import { queryOne, withTransaction, type DbPool } from "../db/connection.ts";
import { recordAuditEvent } from "../services/audit.ts";
import {
  finalizeEnvelope,
  loadInstallSealer,
} from "../services/pdf-finalize.ts";
import { sha256Hex } from "../services/pdf-seal.ts";
import { buildFinalizationAttemptKeys } from "../services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "../services/storage.ts";
import { enqueueCompletionEmails } from "../signing.ts";
import type { EnvSource } from "../utils/env.ts";
import {
  completeRecoveryJob,
  RecoveryJobError,
  type ClaimedRecoveryJob,
} from "./jobs.ts";
import { finalizationPayload } from "./finalization-payload.ts";

export async function processFinalizationJob(
  job: ClaimedRecoveryJob,
  {
    database,
    env,
    signal,
    storageService: injectedStorage,
  }: {
    database: DbPool;
    env: EnvSource;
    signal: AbortSignal;
    storageService?: StorageService;
  },
) {
  const result = finalizationPayload.safeParse(job.payload);
  if (
    !result.success ||
    result.data.envelope.id !== job.envelopeId ||
    result.data.envelope.userId !== job.userId
  )
    throw new RecoveryJobError("payload_invalid", true);
  const payload = result.data;
  const storageService =
    injectedStorage ?? createStorageService({ env, signal });
  const keys = buildFinalizationAttemptKeys({
    envelopeId: payload.envelope.id,
    userId: payload.envelope.userId,
    attemptId: job.leaseToken,
  });
  const registered = await database.query(
    `WITH owned AS (
       SELECT id FROM recovery_jobs WHERE id = $1 AND state = 'running'
         AND lease_token = $2 AND lease_expires_at > clock_timestamp() FOR UPDATE
     )
     INSERT INTO finalization_attempts (job_id, lease_token, storage_keys)
     SELECT id, $2, $3 FROM owned`,
    [job.id, job.leaseToken, Object.values(keys)],
  );
  if (!registered.rowCount) return;

  const hashes = new Map(
    payload.images.map((image) => [image.key, image.sha256]),
  );
  hashes.set(payload.envelope.sourcePdfKey, payload.envelope.sourcePdfHash);
  if (payload.revision)
    hashes.set(payload.revision.key, payload.revision.sha256);
  const storage: StorageService = {
    ...storageService,
    async getObject(key) {
      signal.throwIfAborted();
      const object = await storageService.getObject(key);
      if (sha256Hex(object.body) !== hashes.get(key))
        throw new RecoveryJobError("finalization_artifact_mismatch", true);
      return object;
    },
    async putObject(input) {
      return withTransaction(async (tx) => {
        const active = await queryOne(
          tx,
          `SELECT job_id FROM finalization_attempts
             WHERE job_id = $1 AND lease_token = $2 AND $3 = ANY(storage_keys)
             FOR SHARE`,
          [job.id, job.leaseToken, input.key],
        );
        if (!active) throw new RecoveryJobError("stale_payload");
        signal.throwIfAborted();
        // Free the manifest lock and its pool slot well before the 120s lease.
        const uploadSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(25_000),
        ]);
        return storageService.putObject({ ...input, signal: uploadSignal });
      }, database);
    },
  };
  const seal = await loadInstallSealer({ database, env, signal });
  let signedRevision: Uint8Array | undefined;
  if (payload.revision) {
    await storage.getObject(payload.envelope.sourcePdfKey);
    signedRevision = (await storage.getObject(payload.revision.key)).body;
    // Provider PDFs already contain the appearances, so their renderer does
    // not load the original drawn fields itself.
    for (const image of payload.images) await storage.getObject(image.key);
  }
  const sourcePdf = await storage.headObject(payload.envelope.sourcePdfKey);
  const artifacts = await finalizeEnvelope(
    { ...payload, sourcePdf },
    {
      generatedAt: payload.generatedAt,
      keys,
      seal,
      signedRevision,
      storageService: storage,
      env,
      signal,
    },
  );
  await completeRecoveryJob(job, {
    database,
    onCommit: async (tx) => {
      const published = await tx.query(
        `UPDATE envelopes SET status = 'completed', finalization_pending = false,
           signed_pdf_key = $2, evidence_key = $3, completed_at = $4, updated_at = $4,
           signed_pdf_sha256 = $5, evidence_sha256 = $6, recipient_evidence_sha256 = $7
         WHERE id = $1 AND status = 'sent' AND finalization_pending`,
        [
          job.envelopeId,
          keys.signedPdf,
          keys.certificate,
          payload.generatedAt,
          artifacts.signedPdf.sha256,
          artifacts.certificate.sha256,
          artifacts.recipientCertificate.sha256,
        ],
      );
      if (!published.rowCount)
        throw new RecoveryJobError("envelope_not_ready", true);
      await recordAuditEvent(
        {
          actorType: "system",
          createdAt: payload.generatedAt,
          envelopeId: payload.envelope.id,
          event: "completed",
        },
        tx,
      );
      await enqueueCompletionEmails({
        database: tx,
        env,
        envelopeId: payload.envelope.id,
        envelopeTitle: payload.envelope.title,
        signers: payload.signers,
        copyRecipients: payload.copyRecipients,
        sender: payload.sender,
        attachments: {
          signedPdf: artifacts.signedPdf.body,
          recipientCertificate: artifacts.recipientCertificate.body,
        },
      });
    },
  });
}
