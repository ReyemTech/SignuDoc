# Operate durable recovery

Set `DURABLE_JOBS_ENABLED=true` to persist email intents and final document preparation in PostgreSQL. The signing confirmation arrives after the last signature commits. The envelope shows **Preparing final documents** until a worker publishes the signed PDF, certificates and completion notices. Pending downloads return HTTP 409. Existing signing-provider verification and Part 11 checks apply at signature acceptance.

Recovery begins at the local acceptance commit. A qualified signing provider can consume its one-use exchange before SignuDoc records the signature. If that exchange is interrupted, check the envelope, local audit and provider session before asking the signer to restart the provider flow. The finalization worker can only resume signatures whose acceptance committed.

For most workflows, the domain change and queue insert commit together. Better Auth owns its user and verification transactions. In Better Auth 1.7.21, the signup verification callback runs after the adapter transaction, and the native callback wrapper can log an enqueue error and return success. If an account exists and its verification intent is missing after an outage, restore the queue and use the normal resend verification workflow. Use a fresh request for a missing password reset or email change message. Part 11 signing lockouts retain a committed audit record that the recovery worker reconciles into administrator alerts. Contact-form mail and setup test mail use direct sending.

## Activate

1. Choose a runner, matching migrator, and chart that include durable recovery. Apply and verify `20261118110000_durable_recovery.sql`, `20261118113000_recovery_workflow_lifecycle.sql`, and `20261118120000_recoverable_finalization.sql` before starting the new application.
2. On an existing installation, roll out that code with `DURABLE_JOBS_ENABLED=false` and scheduling disabled. Wait for every older pod, request and scheduled job to finish. Older retention and purge code does not recognize a signature awaiting finalization. A fresh installation can proceed after the migrations and readiness checks with only the new version present.
3. Verify a stable, backed-up, explicitly set `BETTER_AUTH_SECRET` of at least **32 characters** on every replica. Generate `CRON_SECRET` with `openssl rand -hex 32` and store it in the same Kubernetes Secret referenced by the chart. An existing value must be a single Bearer token made of ASCII letters, digits, or `-._~+/`, with optional trailing `=` padding. Rotate a value containing a colon, embedded whitespace, or other punctuation before enabling durable recovery. Check the configured sender, provider account and support address in **Settings → Organization** or `SUPPORT_EMAIL`. The account closure workflow needs that address to persist its notification.
4. Hold signing and other producer traffic while switching every app replica to `DURABLE_JOBS_ENABLED=true` and activating one scheduler. With Helm, set `config.DURABLE_JOBS_ENABLED: "true"` and `cron.recovery.enabled: true`. A scheduler outside Kubernetes must send an authenticated HTTP POST every minute and allow the call up to **240 seconds**. Verify an authenticated status response and a completed drain before admitting traffic. Keep the retention schedule active for its domain work and for abandoned file cleanup.

Keep the auth secret stable across rollouts, backups and restores. It protects queue snapshots and the default seal key. A change makes old jobs unreadable unless they have been drained or the encrypted data has been migrated. To rotate the shared `CRON_SECRET`, pause the recovery, retention and backup schedulers and let active calls finish. Update the Secret and any external callers with the same token. Restart the app replicas and wait for the old ones to retire. Confirm authenticated recovery status when durable mode is enabled, then resume the schedulers. In a pending batch, a Resend API key can rotate within the same provider account and dedupe namespace. Drain and reconcile before changing accounts. Keep the storage driver, endpoint and bucket namespace stable while finalization or file cleanup is outstanding. Those records name keys in the current store. Before a storage move, quiesce, drain and reconcile jobs and `pending_file_deletions`, then verify migration of the files. Storage credential changes within the same namespace can preserve access to those keys.

## Check status

From the trusted deployment network, send `Authorization: Bearer <CRON_SECRET>` to `/api/internal/recovery`. **GET** reads queue state. **POST** drains up to **20** jobs with a **200-second** worker budget, then reads health with a separate **5-second** database budget. Store the token through the operator's secret tooling and keep authorization headers out of request logs.

- Authenticated GET returns `status: "ready"` and queue health when the database can be read. Health has counts by state, `pendingSigningLockAlerts`, and up to **100** attention items with only ID, kind, an allowlisted code and attempts. GET does not claim work.
- Authenticated POST returns `status: "ran"`, `enabled`, `processed`, `failed`, `budgetExhausted` and the same health fields. A clean run can process zero jobs. A handler failure, exhausted budget, attention item or unresolved lock alert makes the run fail, even at zero processed. Check subsequent runs and track the age of the oldest eligible work when the queue stays busy.
- Both methods report `status: "disabled"` when the feature is off. Missing or invalid authorization returns **401**. Configuration or database failure returns a sanitized **503**. No response includes payloads, recipients, provider error text or link credentials.

A worker claims with a **120-second** lease, refreshes it every **30 seconds**, and retries with backoff from **30 seconds** to **1 hour** up to **12** attempts. Another worker can reclaim after a lost lease. Signer codes and links can expire sooner. Resend acknowledgements record provider acceptance. Check provider delivery, bounce and complaint events to establish what happened after acceptance. [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

## Handle attention

Investigate through the authenticated status endpoint first. Open an incident record for each affected job ID and record its kind, code, attempts, time range and the operator's decision. Use the right deployment and a restricted database session to locate parent records. Use the application audit and the provider account that actually handled the traffic. A pending signing lock alert is sourced from a committed system audit. Check the presence of an eligible administrator and valid mail settings, then let a scheduled drain reconcile it. Keep the audit history intact.

A DBA can inspect the following fields without reading or exporting payloads. Replace the psql variable with the single reviewed UUID.

```sql
\set job_id '00000000-0000-0000-0000-000000000000'
BEGIN READ ONLY;
SELECT id, kind, state, last_error_code, attempts, envelope_id, user_id,
       created_at, first_attempt_at, updated_at, expires_at, signing_expires_at
FROM public.recovery_jobs WHERE id = :'job_id'::uuid;
COMMIT;
```

- **Finalization.** Restore failing database, storage, signing seal or timestamp access and check that all recovery replicas have the original encryption secret. Confirm the envelope still has `finalization_pending=true`. A hash mismatch needs the original known-good bytes and matches against recorded checksums before a reviewed requeue. Preserve the recorded signature, audit and published pointers. If an artifact cannot be recovered or the stored snapshot is invalid, escalate to the signing and compliance owners. A repaired transient failure can be requeued with the conditional procedure below.
- **Expired or superseded credentials.** After a link or code expires, let a scheduled drain run or send an authenticated POST. Confirm the job moved to cancelled and its live snapshot was cleared. If a signer still needs access, verify the current envelope and signer, then use the application to issue a fresh reminder, code or download link as appropriate. A superseded credential fails the current guard. Leave the earlier record and its evidence in place while the fresh workflow completes.
- **Ambiguous email.** The worker stops automatic retries **23 hours** after the first possible provider attempt, inside Resend's **24-hour** dedupe window. The key for this row is `signudoc-recovery/<job UUID>`. Compare timestamps, provider message records and domain acknowledgements. If acceptance is confirmed but the audit or required domain write is absent, escalate for reviewed reconciliation of that specific acknowledgement using the provider message ID. Retention grace and deadline-expiry notices need the corresponding conditional domain update as well as the existing audit semantics. If provider evidence confirms non-acceptance and the notification is still needed, have the affected user or operator initiate the appropriate fresh application workflow. Keep uncertain jobs quarantined. A job state change alone cannot fill an audit or domain acknowledgement gap. Never reset an email's attempt timestamps or replay an old request outside the provider window. Record a deliberate new workflow separately when the operator and affected user need a fresh action.

For **repaired finalization only**, fix and verify the cause first. For an unreadable snapshot, confirm the original key has been restored. For a checksum mismatch, verify the restored bytes against the accepted signature records. Have a second operator review the affected job UUID, expected code and attempt count. Quiesce producers and suspend recovery scheduling, then wait for active requests and worker runs to stop. Run the following in psql as an authorized DBA, with the current values from the incident. Commit only if the `RETURNING` result contains exactly the intended row. Otherwise roll back and re-inspect. The next claim uses a fresh lease and artifact namespace.

```sql
\set job_id '00000000-0000-0000-0000-000000000000'
\set current_code 'attempts_exhausted'
\set current_attempts 12
BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE public.recovery_jobs AS job
SET state = 'pending', attempts = 0, available_at = clock_timestamp(),
    updated_at = clock_timestamp(), completed_at = NULL, last_error_code = NULL
FROM public.envelopes AS envelope
WHERE job.id = :'job_id'::uuid AND job.kind = 'finalize_envelope'
  AND job.state = 'needs_attention' AND job.lease_token IS NULL
  AND job.payload_ciphertext IS NOT NULL
  AND job.last_error_code = :'current_code'
  AND job.last_error_code IN (
    'attempts_exhausted', 'handler_failed', 'deadline_exceeded',
    'payload_unreadable', 'finalization_artifact_mismatch'
  )
  AND job.attempts = :'current_attempts'::integer
  AND envelope.id = job.envelope_id AND envelope.finalization_pending
RETURNING job.id, job.kind, job.state;
-- Review the single returned row, then issue COMMIT or ROLLBACK.
```

Resume the worker and verify publication, one completion audit and legitimate completion mail. Let normal retention remove abandoned attempt files. Disabled workers cannot publish accepted signatures.

## Disable, restore or change a dependency

1. Quiesce ingress and application producers. Pause automatic retention and other maintenance that can create work. Wait for their active calls to finish. Keep the compatible app and recovery scheduler running with durable mode enabled.
2. Drain recovery jobs and reconcile attention items while traffic is paused. Run a controlled cleanup by sending an authenticated `POST /api/internal/retention` over the trusted deployment network with the same `CRON_SECRET`. Confirm a completed response with `ranAt` and resolve any failures. Retry a skipped run after any earlier sweep finishes. This sweep processes pending file deletions and can also create new jobs or enqueue more deletions.
3. Drain recovery again after maintenance. Confirm **pending**, **running**, **needs_attention** and `pendingSigningLockAlerts` are all zero in authenticated recovery status. Use the read-only check below to confirm that both file cleanup and finalization are clear. If either queue still has work, repeat the controlled retention and recovery passes while the compatible code can run them. Diagnose storage failures or reconcile blocked work before continuing.
4. Once all checks pass, stop the recovery scheduler, disable the flag across replicas and finish the reviewed downgrade or compatible rollout. Resume ingress and normal maintenance only when the rollout is complete.

```sql
BEGIN READ ONLY;
SELECT
  (SELECT count(*) FROM public.envelopes WHERE finalization_pending) AS pending_finalizations,
  (SELECT count(*) FROM public.pending_file_deletions) AS pending_file_deletions;
COMMIT;
```

Restore the database and matching storage versions in isolation with producer traffic, recovery, other scheduled jobs and provider egress disabled. Preserve the stable auth and seal secrets. A point-in-time restore can roll back a queue insert, provider acknowledgement or final-file pointer. Compare restored pending/running/attention rows, accepted signatures and pending file deletions against later provider, audit and storage evidence. A restored row can lack the original first-attempt timestamp or refer to a provider request older than the dedupe window. Have an operator reconcile those states and verify the correct object versions before resuming workers or producers. Keep external acceptance evidence when diagnosing a lost database acknowledgement.

## Retention and data location

Queue payloads can include complete messages and attachments. Backups, WAL and replica storage can retain previous encrypted copies after a job is cleared. Success, cancellation and parent purge clear live payloads. Deduplication metadata can remain for the parent's lifetime, and jobs awaiting attention can retain encrypted content until resolved or expired. Monitor queue and backup size, age, and the retention of rows without a parent. Review parentless tombstone policy before removing any. Removing the tombstone can change replay behavior. Store database snapshots, logs, keys, document objects and provider records in the deployment's approved data plane. Operate independent US and Canadian installations with separate providers, backup destinations and secrets when both residencies are required.

## Validate on disposable fixtures

With Node 24, Chromium and a dedicated PostgreSQL database whose name contains `e2e`, set `E2E_DATABASE_URL` and run `npm run test:e2e` for legacy mode. Run `E2E_DURABLE_JOBS=1 npm run test:e2e` for the same flows through durable recovery. Playwright resets that database and the local test data directory. It uses a signing provider stand-in and captures all mail to JSON.

For the production-container browser run, build the Linux amd64 runner shown below. Point `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, and the AWS SDK credentials at a private disposable test store with an existing bucket. Use `S3_FORCE_PATH_STYLE=true` for local MinIO. Run the browser test as a non-root user so captured files remain accessible on the host. To run the real worker-kill checks against the same test store outside the browser, set `S3_INTEGRATION_TEST=1` and run `npm run test:db`.

```bash
docker build --platform linux/amd64 --target runner -t signudoc-recovery:local .
E2E_DURABLE_JOBS=1 E2E_STORAGE_DRIVER=s3 E2E_APP_IMAGE=signudoc-recovery:local npm run test:e2e
```
