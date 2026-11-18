import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  type DbExecutor,
  type DbPool,
  withTransaction,
} from "../db/connection.ts";
import { canonicalJson } from "../utils/canonical-json.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import { assertRecoveryConfigured, isDurableJobsEnabled } from "./config.ts";

export const RECOVERY_JOB_KINDS = ["email", "finalize_envelope"] as const;
export type RecoveryJobKind = (typeof RECOVERY_JOB_KINDS)[number];
export type RecoveryJobState =
  "pending" | "running" | "succeeded" | "needs_attention" | "cancelled";

export const RECOVERY_LEASE_SECONDS = 120;
export const RECOVERY_HEARTBEAT_MS = 30_000;
const MAX_ATTEMPTS = 12;
const EMAIL_RETRY_WINDOW_SECONDS = 23 * 60 * 60;
const FIRST_RETRY_SECONDS = 30;
const MAX_RETRY_SECONDS = 3600;
const REAP_LIMIT = 100;

const ERROR_CODES = [
  "attempts_exhausted",
  "cancelled",
  "deadline_exceeded",
  "email_configuration_invalid",
  "envelope_not_ready",
  "expired",
  "finalization_artifact_mismatch",
  "finalization_failed",
  "guard_changed",
  "handler_failed",
  "job_failed",
  "missing_parent",
  "payload_invalid",
  "payload_unreadable",
  "provider_outcome_unknown",
  "recipient_unavailable",
  "retry_window_elapsed",
  "stale_payload",
  "storage_error",
  "unknown_outcome",
] as const;
export type RecoveryErrorCode = (typeof ERROR_CODES)[number];

function safeCode(code: string): RecoveryErrorCode {
  const knownCode = ERROR_CODES.find((value) => value === code);
  return knownCode ?? "job_failed";
}

export class RecoveryJobError extends Error {
  readonly code: RecoveryErrorCode;
  readonly permanent: boolean;

  constructor(code: RecoveryErrorCode, permanent = false) {
    super(code);
    this.name = "RecoveryJobError";
    this.code = code;
    this.permanent = permanent;
  }
}

type JobIdentity = {
  id: string;
  kind: RecoveryJobKind;
  envelopeId: string | null;
  userId: string | null;
  expiresAt: number | null;
};

export type ClaimedRecoveryJob = JobIdentity & {
  payload: unknown;
  leaseToken: string;
  attempts: number;
  /** Unix seconds at the first possible dispatch. */
  firstAttemptAt: number;
};

type JobFence = Pick<ClaimedRecoveryJob, "id" | "leaseToken">;

type EnqueueRecoveryJobInput = {
  kind: RecoveryJobKind;
  dedupeKey: string;
  payload: unknown;
  envelopeId?: string;
  userId?: string;
  expiresAt?: number;
};

type JobOptions = {
  database: DbExecutor;
  env?: EnvSource;
};

function payloadKey(env: EnvSource, use: "encryption" | "digest"): Buffer {
  return createHmac("sha256", readEnv(env, "BETTER_AUTH_SECRET")!)
    .update(`signudoc/recovery/v1/${use}`)
    .digest();
}

function serialize(payload: unknown): string {
  try {
    return canonicalJson(JSON.parse(JSON.stringify(payload)));
  } catch {
    throw new Error("Recovery job payload must be JSON serializable.");
  }
}

function associatedData(identity: JobIdentity): string {
  return canonicalJson(identity);
}

function encryptPayload(
  payload: string,
  identity: JobIdentity,
  env: EnvSource,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    payloadKey(env, "encryption"),
    iv,
  );
  cipher.setAAD(Buffer.from(associatedData(identity)));
  const ciphertext = Buffer.concat([
    cipher.update(payload, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

function decryptPayload(
  ciphertext: Buffer,
  identity: JobIdentity,
  env: EnvSource,
): unknown {
  if (ciphertext[0] !== 1 || ciphertext.length < 30) {
    throw new Error("Invalid recovery job ciphertext.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    payloadKey(env, "encryption"),
    ciphertext.subarray(1, 13),
  );
  decipher.setAAD(Buffer.from(associatedData(identity)));
  decipher.setAuthTag(ciphertext.subarray(13, 29));
  return JSON.parse(
    Buffer.concat([
      decipher.update(ciphertext.subarray(29)),
      decipher.final(),
    ]).toString("utf8"),
  );
}

export async function enqueueRecoveryJob(
  input: EnqueueRecoveryJobInput,
  { database, env = process.env }: JobOptions,
): Promise<{ id: string; created: boolean }> {
  if (!isDurableJobsEnabled(env)) throw new Error("Durable jobs are disabled.");
  assertRecoveryConfigured(env);
  if (
    !input.dedupeKey.trim() ||
    Buffer.byteLength(input.dedupeKey) > 512 ||
    input.dedupeKey.includes("\0")
  ) {
    throw new Error("Invalid recovery job dedupe key.");
  }
  if (
    input.expiresAt !== undefined &&
    (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0)
  ) {
    throw new Error("Invalid recovery job expiry.");
  }

  const id = randomUUID();
  const parent = {
    kind: input.kind,
    envelopeId: input.envelopeId ?? null,
    userId: input.userId ?? null,
    expiresAt: input.expiresAt ?? null,
  };
  const payload = serialize(input.payload);
  const digest = createHmac("sha256", payloadKey(env, "digest"))
    .update(canonicalJson(parent))
    .update(payload)
    .digest();
  const ciphertext = encryptPayload(payload, { id, ...parent }, env);
  const { rowCount } = await database.query(
    `INSERT INTO recovery_jobs (
        id, kind, dedupe_key, envelope_id, user_id, expires_at, payload_digest, payload_ciphertext
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      id,
      parent.kind,
      input.dedupeKey,
      parent.envelopeId,
      parent.userId,
      parent.expiresAt,
      digest,
      ciphertext,
    ],
  );
  if (rowCount === 1) return { id, created: true };

  // A separate statement sees a conflicting insert that committed after this
  // insertion's statement snapshot, without rewriting an existing tombstone.
  const existing = await database.query<{ id: string; payload_digest: Buffer }>(
    "SELECT id, payload_digest FROM recovery_jobs WHERE dedupe_key = $1",
    [input.dedupeKey],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.payload_digest.length !== digest.length ||
    !timingSafeEqual(row.payload_digest, digest)
  ) {
    throw new Error(
      "Recovery job dedupe key conflicts with a different payload.",
    );
  }
  return { id: row.id, created: false };
}

type ClaimOptions = {
  database: DbPool;
  env?: EnvSource;
  jobId?: string;
  kinds?: readonly RecoveryJobKind[];
};

const CLAIM_SCOPE = `
  ($1::uuid IS NULL OR id = $1) AND kind = ANY($2::text[])
`;
const RECLAIMABLE =
  "state = 'running' AND lease_expires_at <= statement_timestamp()";
const EXPIRED = "expires_at <= extract(epoch from clock_timestamp())";
const EXPIRED_AT_CLAIM =
  "expires_at <= extract(epoch from statement_timestamp())";
const WINDOW_ELAPSED_AT_CLAIM = `
  kind = 'email' AND first_attempt_at <= statement_timestamp() - $4::int * interval '1 second'
`;

const SHOULD_REAP = `
  COALESCE(${EXPIRED_AT_CLAIM}, false) OR attempts >= $3 OR COALESCE(${WINDOW_ELAPSED_AT_CLAIM}, false)
`;

type ClaimedRow = Omit<ClaimedRecoveryJob, "payload"> & { ciphertext: Buffer };

export async function claimRecoveryJob({
  database,
  env = process.env,
  jobId,
  kinds = RECOVERY_JOB_KINDS,
}: ClaimOptions): Promise<ClaimedRecoveryJob | null> {
  if (!isDurableJobsEnabled(env) || kinds.length === 0) return null;
  assertRecoveryConfigured(env);

  const scope = [
    jobId ?? null,
    kinds,
    MAX_ATTEMPTS,
    EMAIL_RETRY_WINDOW_SECONDS,
  ];
  const { rows } = await database.query<ClaimedRow>(
    `WITH discarded AS (
        SELECT id, CASE
          WHEN ${EXPIRED_AT_CLAIM} THEN 'expired'
          WHEN ${WINDOW_ELAPSED_AT_CLAIM} THEN 'retry_window_elapsed'
          ELSE 'attempts_exhausted'
        END AS reason
        FROM recovery_jobs
        WHERE ${CLAIM_SCOPE} AND (state = 'pending' OR (${RECLAIMABLE})) AND (${SHOULD_REAP})
        ORDER BY available_at, id
        LIMIT $5
        FOR UPDATE SKIP LOCKED
      ), reap AS (
        UPDATE recovery_jobs AS job
        SET state = CASE WHEN reason = 'expired' THEN 'cancelled' ELSE 'needs_attention' END,
          payload_ciphertext = CASE WHEN reason = 'expired' THEN NULL ELSE job.payload_ciphertext END,
          last_error_code = reason, lease_token = NULL, lease_expires_at = NULL,
          updated_at = clock_timestamp(), completed_at = clock_timestamp()
        FROM discarded
        WHERE job.id = discarded.id
      ), candidate AS (
        SELECT id FROM recovery_jobs
        WHERE ${CLAIM_SCOPE} AND NOT (${SHOULD_REAP}) AND (
          (state = 'pending' AND available_at <= statement_timestamp()) OR (${RECLAIMABLE})
        )
        ORDER BY available_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE recovery_jobs AS job
      SET state = 'running', lease_token = $6, lease_expires_at = clock_timestamp() + $7::int * interval '1 second',
        first_attempt_at = COALESCE(job.first_attempt_at, clock_timestamp()), attempts = job.attempts + 1,
        updated_at = clock_timestamp()
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.id, job.kind, job.payload_ciphertext AS ciphertext,
        job.lease_token AS "leaseToken", job.attempts,
        floor(extract(epoch from job.first_attempt_at))::bigint AS "firstAttemptAt",
        job.expires_at AS "expiresAt", job.envelope_id AS "envelopeId", job.user_id AS "userId"`,
    [...scope, REAP_LIMIT, randomUUID(), RECOVERY_LEASE_SECONDS],
  );
  const row = rows[0];
  if (!row) return null;

  const { ciphertext, ...job } = row;
  const { id, kind, envelopeId, userId, expiresAt } = job;
  try {
    return {
      ...job,
      payload: decryptPayload(
        ciphertext,
        { id, kind, envelopeId, userId, expiresAt },
        env,
      ),
    };
  } catch {
    await failRecoveryJob(job, {
      database,
      code: "payload_unreadable",
      permanent: true,
    });
    return null;
  }
}

const FENCE = `
  id = $1 AND state = 'running' AND lease_token = $2 AND lease_expires_at > clock_timestamp()
`;

export async function renewRecoveryLease(
  job: JobFence,
  { database }: { database: DbExecutor },
): Promise<boolean> {
  const result = await database.query(
    `UPDATE recovery_jobs
      SET lease_expires_at = clock_timestamp() + $3::int * interval '1 second', updated_at = clock_timestamp()
      WHERE ${FENCE}`,
    [job.id, job.leaseToken, RECOVERY_LEASE_SECONDS],
  );
  return result.rowCount === 1;
}

class LostRecoveryLease extends Error {}

export async function completeRecoveryJob(
  job: JobFence & Pick<ClaimedRecoveryJob, "envelopeId">,
  {
    database,
    onCommit,
  }: { database: DbPool; onCommit?: (tx: DbExecutor) => Promise<void> },
): Promise<boolean> {
  const values = [job.id, job.leaseToken];

  try {
    return await withTransaction(async (tx) => {
      if (job.envelopeId !== null) {
        // Domain transitions and parent deletion acquire the envelope before
        // the queue row. NO KEY UPDATE stays compatible with audit FK checks.
        const parent = await tx.query(
          "SELECT id FROM envelopes WHERE id = $1 FOR NO KEY UPDATE",
          [job.envelopeId],
        );
        if (parent.rowCount !== 1) return false;
      }

      const owner = await tx.query(
        `SELECT id FROM recovery_jobs WHERE ${FENCE} FOR UPDATE`,
        values,
      );
      if (owner.rowCount !== 1) return false;
      await onCommit?.(tx);
      const result = await tx.query(
        `UPDATE recovery_jobs
          SET state = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
            payload_ciphertext = NULL, last_error_code = NULL,
            updated_at = clock_timestamp(), completed_at = clock_timestamp()
          WHERE ${FENCE}`,
        values,
      );
      if (result.rowCount !== 1) throw new LostRecoveryLease();
      return true;
    }, database);
  } catch (error) {
    if (error instanceof LostRecoveryLease) return false;
    throw error;
  }
}

export async function cancelRecoveryJob(
  job: JobFence,
  { database, code = "cancelled" }: { database: DbExecutor; code?: string },
): Promise<boolean> {
  const result = await database.query(
    `UPDATE recovery_jobs
      SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
        payload_ciphertext = NULL, last_error_code = $3,
        updated_at = clock_timestamp(), completed_at = clock_timestamp()
      WHERE ${FENCE}`,
    [job.id, job.leaseToken, safeCode(code)],
  );
  return result.rowCount === 1;
}

export async function failRecoveryJob(
  job: JobFence,
  {
    database,
    code,
    permanent = false,
  }: { database: DbExecutor; code: string; permanent?: boolean },
): Promise<boolean> {
  const result = await database.query(
    `WITH failed AS (
        SELECT id, CASE
          WHEN ${EXPIRED} THEN 'cancelled'
          WHEN $5 OR attempts >= $6 OR
            (kind = 'email' AND first_attempt_at <= clock_timestamp() - $7::int * interval '1 second')
            THEN 'needs_attention'
          ELSE 'pending'
        END AS next_state
        FROM recovery_jobs WHERE ${FENCE}
        FOR UPDATE
      )
      UPDATE recovery_jobs AS job
      SET state = next_state, lease_token = NULL, lease_expires_at = NULL,
        available_at = clock_timestamp() + LEAST($3 * power(2, job.attempts - 1), $4) * interval '1 second',
        payload_ciphertext = CASE WHEN next_state = 'cancelled' THEN NULL ELSE job.payload_ciphertext END,
        last_error_code = CASE WHEN next_state = 'cancelled' THEN 'expired' ELSE $8 END,
        updated_at = clock_timestamp(),
        completed_at = CASE WHEN next_state = 'pending' THEN NULL ELSE clock_timestamp() END
      FROM failed WHERE job.id = failed.id AND job.lease_expires_at > clock_timestamp()`,
    [
      job.id,
      job.leaseToken,
      FIRST_RETRY_SECONDS,
      MAX_RETRY_SECONDS,
      permanent,
      MAX_ATTEMPTS,
      EMAIL_RETRY_WINDOW_SECONDS,
      safeCode(code),
    ],
  );
  return result.rowCount === 1;
}

/** Rechecks the dispatch window using fresh database time, just before I/O. */
export async function getEmailDispatchStatus(
  job: JobFence,
  database: DbExecutor,
): Promise<"ready" | "stale" | "expired" | "retry_window_elapsed"> {
  const result = await database.query<{
    status: "ready" | "expired" | "retry_window_elapsed";
  }>(
    `SELECT CASE
        WHEN ${EXPIRED} THEN 'expired'
        WHEN first_attempt_at <= clock_timestamp() - $3::int * interval '1 second' THEN 'retry_window_elapsed'
        ELSE 'ready'
      END AS status
      FROM recovery_jobs WHERE ${FENCE} AND kind = 'email'`,
    [job.id, job.leaseToken, EMAIL_RETRY_WINDOW_SECONDS],
  );
  return result.rows[0]?.status ?? "stale";
}

export type RecoveryQueueHealth = {
  counts: Record<RecoveryJobState, number>;
  attention: {
    id: string;
    kind: RecoveryJobKind;
    code: RecoveryErrorCode | null;
    attempts: number;
  }[];
};

export async function getRecoveryQueueHealth({
  database,
}: {
  database: DbExecutor;
}): Promise<RecoveryQueueHealth> {
  const { rows } = await database.query<{
    state: RecoveryJobState;
    count: number;
    attention:
      | {
          id: string;
          kind: RecoveryJobKind;
          code: string | null;
          attempts: number;
        }[]
      | null;
  }>(
    `WITH attention AS (
        SELECT id, kind, last_error_code AS code, attempts
        FROM recovery_jobs WHERE state = 'needs_attention'
        ORDER BY updated_at, id LIMIT 100
      )
      SELECT state, count(*)::int AS count,
        CASE WHEN state = 'needs_attention' THEN (SELECT json_agg(attention) FROM attention) END AS attention
      FROM recovery_jobs GROUP BY state`,
  );
  const counts: RecoveryQueueHealth["counts"] = {
    pending: 0,
    running: 0,
    succeeded: 0,
    needs_attention: 0,
    cancelled: 0,
  };
  for (const { state, count } of rows) counts[state] = count;
  const attention = (
    rows.find((row) => row.state === "needs_attention")?.attention ?? []
  ).map((row) => ({
    ...row,
    code: row.code === null ? null : safeCode(row.code),
  }));
  return { counts, attention };
}
