import { Resend, type Response as ResendResponse } from "resend";
import { z } from "zod";

import { type DbExecutor, type DbPool, queryOne } from "../db/connection.ts";
import { recordAuditEvent } from "../services/audit.ts";
import {
  createEmailService,
  fitsAsAttachments,
  MAX_ATTACHMENT_BYTES,
  resolveEmailAddresses,
  resolveEmailDriver,
  type EmailService,
  type TransactionalEmailMessage,
} from "../services/email.ts";
import {
  extractEmailAddress,
  type EmailAddresses,
} from "../services/email-addresses.ts";
import { emailTemplateKinds, envelopeStatuses } from "../types/domain.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import { assertRecoveryConfigured, isDurableJobsEnabled } from "./config.ts";
import {
  cancelRecoveryJob,
  completeRecoveryJob,
  enqueueRecoveryJob,
  getEmailDispatchStatus,
  RecoveryJobError,
  type ClaimedRecoveryJob,
} from "./jobs.ts";

const EMAIL_REQUEST_TIMEOUT_MS = 25_000;
const DATABASE_SECONDS = "floor(extract(epoch from clock_timestamp()))::bigint";
const FINAL_ENVELOPE_STATUSES = new Set(["completed", "declined", "voided"]);

const tokenHash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1);
const expiry = z.number().int().nonnegative();
const singleLine = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n\x00]/.test(value));
const emailAddress = z.email();

const guardSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("envelope_status"),
    allowedStatuses: z.array(z.enum(envelopeStatuses)).nonempty(),
  }),
  z.object({ kind: z.literal("signer_token"), signerId: id, tokenHash }),
  z.object({
    kind: z.literal("signing_code"),
    signerId: id,
    tokenHash,
    codeHash: tokenHash,
  }),
  z.object({
    kind: z.literal("recipient_download_tokens"),
    signerId: id,
    tokenHashes: z.array(tokenHash).nonempty(),
  }),
]);
export type EmailJobGuard = z.infer<typeof guardSchema>;

const emailAudit = z.object({ signerId: id.optional() });
const acknowledgementSchema = z.discriminatedUnion("kind", [
  emailAudit.extend({ kind: z.literal("email_audit") }),
  z.object({
    kind: z.literal("retention_warning"),
    audit: emailAudit.optional(),
  }),
  z.object({
    kind: z.literal("expiry_notice"),
    expiresAt: expiry,
    audit: emailAudit.optional(),
  }),
]);
export type EmailAcknowledgement = z.infer<typeof acknowledgementSchema>;

const frozenEmailSchema = z.object({
  addresses: z.object({
    senderAddress: singleLine.refine(
      (value) => emailAddress.safeParse(extractEmailAddress(value)).success,
    ),
    supportAddress: emailAddress.nullable(),
  }),
  message: z.object({
    attachments: z
      .array(
        z.object({
          content: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
          contentType: singleLine,
          filename: singleLine,
        }),
      )
      .optional(),
    htmlBody: z.string().optional(),
    replyTo: emailAddress.optional(),
    subject: singleLine,
    template: z.enum(emailTemplateKinds),
    textBody: z.string(),
    to: emailAddress,
  }),
  guard: guardSchema.optional(),
  acknowledgement: acknowledgementSchema.optional(),
});

type FrozenEmail = z.infer<typeof frozenEmailSchema>;

type EnqueueEmailInput = {
  message: TransactionalEmailMessage;
  dedupeKey: string;
  envelopeId?: string;
  userId?: string;
  expiresAt?: number;
  guard?: EmailJobGuard;
  acknowledgement?: EmailAcknowledgement;
};

export async function enqueueEmail(
  { message, guard, acknowledgement, ...job }: EnqueueEmailInput,
  {
    database,
    env = process.env,
    addresses,
  }: { database: DbExecutor; env?: EnvSource; addresses?: EmailAddresses },
): Promise<{ id: string; created: boolean }> {
  if (!isDurableJobsEnabled(env)) throw new Error("Durable jobs are disabled.");
  assertRecoveryConfigured(env);
  if ((guard || acknowledgement) && !job.envelopeId) {
    throw new RecoveryJobError("payload_invalid", true);
  }

  if (
    message.attachments?.some(
      (item) => !(item.content instanceof Uint8Array),
    ) ||
    !fitsAsAttachments(message.attachments ?? [])
  ) {
    throw new RecoveryJobError("payload_invalid", true);
  }

  const payload = frozenEmailSchema.safeParse({
    addresses: addresses ?? (await resolveEmailAddresses(env, database)),
    message: {
      ...message,
      attachments: message.attachments?.length
        ? message.attachments.map((item) => ({
            ...item,
            content: Buffer.from(item.content).toString("base64"),
          }))
        : undefined,
    },
    guard,
    acknowledgement,
  });
  if (!payload.success) throw new RecoveryJobError("payload_invalid", true);

  return enqueueRecoveryJob(
    { ...job, kind: "email", payload: payload.data },
    { database, env },
  );
}

type EnvelopeGuardRow = {
  status: (typeof envelopeStatuses)[number];
  expiresAt: number | null;
  expiryNotifiedAt: number | null;
  retentionWarnedAt: number | null;
  part11: boolean;
  now: number;
};

async function envelopeGuardMatches(
  job: ClaimedRecoveryJob,
  { guard, acknowledgement }: FrozenEmail,
  database: DbExecutor,
): Promise<boolean> {
  if (!guard && (!acknowledgement || acknowledgement.kind === "email_audit"))
    return true;

  const envelope = await queryOne<EnvelopeGuardRow>(
    database,
    `SELECT status, expires_at AS "expiresAt", expiry_notified_at AS "expiryNotifiedAt",
        retention_warned_at AS "retentionWarnedAt", part11, ${DATABASE_SECONDS} AS now
      FROM envelopes WHERE id = $1`,
    [job.envelopeId],
  );
  if (!envelope) return false;

  if (
    acknowledgement?.kind === "expiry_notice" &&
    (envelope.status !== "sent" ||
      envelope.expiresAt !== acknowledgement.expiresAt ||
      envelope.expiresAt > envelope.now ||
      envelope.expiryNotifiedAt !== null)
  )
    return false;

  if (
    acknowledgement?.kind === "retention_warning" &&
    (!FINAL_ENVELOPE_STATUSES.has(envelope.status) ||
      envelope.part11 ||
      envelope.retentionWarnedAt !== null)
  )
    return false;

  if (!guard) return true;
  if (guard.kind === "envelope_status")
    return guard.allowedStatuses.includes(envelope.status);
  if (guard.kind === "recipient_download_tokens") {
    if (!FINAL_ENVELOPE_STATUSES.has(envelope.status)) return false;

    const { rows } = await database.query<{ token_hash: string }>(
      `SELECT token_hash FROM recipient_download_tokens
        WHERE envelope_id = $1 AND signer_id = $2 AND token_hash = ANY($3::text[])
          AND expires_at > ${DATABASE_SECONDS}`,
      [job.envelopeId, guard.signerId, guard.tokenHashes],
    );
    return rows.length === new Set(guard.tokenHashes).size;
  }

  if (
    envelope.status !== "sent" ||
    (envelope.expiresAt !== null && envelope.expiresAt <= envelope.now)
  ) {
    return false;
  }

  const codeHash = guard.kind === "signing_code" ? guard.codeHash : null;
  const result = await database.query(
    `SELECT 1 FROM signers WHERE envelope_id = $1 AND id = $2 AND status = 'notified'
      AND signing_token_hash = $3 AND signing_token_expires_at > ${DATABASE_SECONDS}
      AND ($4::text IS NULL OR (email_code_hash = $4 AND email_code_expires_at > ${DATABASE_SECONDS}))`,
    [job.envelopeId, guard.signerId, guard.tokenHash, codeHash],
  );
  return result.rowCount === 1;
}

async function acknowledgeEmail(
  envelopeId: string,
  { message, acknowledgement }: FrozenEmail,
  messageId: string,
  database: DbExecutor,
): Promise<void> {
  if (!acknowledgement) return;

  if (acknowledgement.kind === "retention_warning") {
    await database.query(
      `UPDATE envelopes SET retention_warned_at = ${DATABASE_SECONDS}
        WHERE id = $1 AND status IN ('completed', 'declined', 'voided')
          AND NOT part11 AND retention_warned_at IS NULL`,
      [envelopeId],
    );
  } else if (acknowledgement.kind === "expiry_notice") {
    const recorded = await queryOne<{ notifiedAt: number }>(
      database,
      `UPDATE envelopes SET expiry_notified_at = ${DATABASE_SECONDS}
        WHERE id = $1 AND status = 'sent' AND expires_at = $2 AND expiry_notified_at IS NULL
        RETURNING expiry_notified_at AS "notifiedAt"`,
      [envelopeId, acknowledgement.expiresAt],
    );
    if (recorded) {
      await recordAuditEvent(
        {
          actorType: "system",
          createdAt: recorded.notifiedAt,
          envelopeId,
          event: "expired",
          metadata: { expiresAt: acknowledgement.expiresAt },
        },
        database,
      );
    }
  }

  const audit =
    acknowledgement.kind === "email_audit"
      ? acknowledgement
      : acknowledgement.audit;
  if (audit) {
    await recordAuditEvent(
      {
        actorType: "system",
        envelopeId,
        event: "email_sent",
        metadata: {
          messageId,
          recipient: message.to,
          signerId: audit.signerId ?? null,
          template: message.template,
        },
      },
      database,
    );
  }
}

/** Reuse the SDK's wire encoding while keeping provider response text private. */
class RecoveryResend extends Resend {
  override async fetchRequest<T>(
    path: string,
    options?: RequestInit,
  ): Promise<ResendResponse<T>> {
    let statusCode: number | null = null;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        redirect: "error",
      });
      statusCode = response.status;
      if (response.ok) {
        return {
          data: (await response.json()) as T,
          error: null,
          headers: null,
        };
      }
      await response.body?.cancel();
    } catch {
      // A timeout or network/parse failure may happen after provider acceptance.
    }
    return {
      data: null,
      error: {
        statusCode,
        name: "application_error",
        message: "Email provider did not confirm acceptance.",
      },
      headers: null,
    };
  }
}

function createRecoveryEmailService(env: EnvSource): EmailService {
  if (resolveEmailDriver(env) === "capture") return createEmailService({ env });

  const apiKey = readEnv(env, "RESEND_API_KEY");
  if (!apiKey) throw new RecoveryJobError("email_configuration_invalid");
  return createEmailService({ env, resendClient: new RecoveryResend(apiKey) });
}

export async function processEmailJob(
  job: ClaimedRecoveryJob,
  {
    database,
    env = process.env,
    emailService,
    signal,
  }: {
    database: DbPool;
    env?: EnvSource;
    emailService?: EmailService;
    signal?: AbortSignal;
  },
): Promise<void> {
  const parsed = frozenEmailSchema.safeParse(job.payload);
  if (job.kind !== "email" || !parsed.success)
    throw new RecoveryJobError("payload_invalid", true);
  const payload = parsed.data;
  if ((payload.guard || payload.acknowledgement) && !job.envelopeId) {
    throw new RecoveryJobError("payload_invalid", true);
  }

  if (job.userId) {
    const user = await database.query('SELECT 1 FROM "user" WHERE id = $1', [
      job.userId,
    ]);
    // A Better Auth-owned transaction may still be inserting this user.
    if (user.rowCount !== 1) throw new RecoveryJobError("missing_parent");
  }

  if (!(await envelopeGuardMatches(job, payload, database))) {
    await cancelRecoveryJob(job, { database, code: "guard_changed" });
    return;
  }

  const attachments = payload.message.attachments?.map((item) => {
    const content = Buffer.from(item.content, "base64");
    if (content.toString("base64") !== item.content) {
      throw new RecoveryJobError("payload_invalid", true);
    }
    return { ...item, content };
  });
  if (!fitsAsAttachments(attachments ?? [])) {
    throw new RecoveryJobError("payload_invalid", true);
  }
  const message = { ...payload.message, attachments };
  const service = emailService ?? createRecoveryEmailService(env);

  const status = await getEmailDispatchStatus(job, database);
  if (status === "stale") return;
  if (status === "expired") {
    await cancelRecoveryJob(job, { database, code: "expired" });
    return;
  }
  if (status === "retry_window_elapsed")
    throw new RecoveryJobError(status, true);
  if (signal?.aborted) throw new RecoveryJobError("deadline_exceeded");

  const requestSignal = AbortSignal.timeout(EMAIL_REQUEST_TIMEOUT_MS);
  let messageId: string;
  try {
    const result = await service.send(message, {
      addresses: payload.addresses,
      idempotencyKey: `signudoc-recovery/${job.id}`,
      signal: signal ? AbortSignal.any([signal, requestSignal]) : requestSignal,
    });
    if (
      typeof result?.messageId !== "string" ||
      !result.messageId.trim() ||
      result.messageId.length > 512 ||
      /[\r\n\x00]/.test(result.messageId) ||
      !Array.isArray(result.accepted) ||
      result.accepted.length !== 1 ||
      result.accepted[0] !== message.to ||
      !Array.isArray(result.rejected) ||
      result.rejected.length !== 0
    ) {
      throw new RecoveryJobError("provider_outcome_unknown");
    }
    messageId = result.messageId;
  } catch {
    throw new RecoveryJobError("provider_outcome_unknown");
  }

  const { envelopeId } = job;
  await completeRecoveryJob(job, {
    database,
    onCommit:
      envelopeId && payload.acknowledgement
        ? (tx) => acknowledgeEmail(envelopeId, payload, messageId, tx)
        : undefined,
  });
}
