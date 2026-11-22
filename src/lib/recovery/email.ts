import { Resend, type Response as ResendResponse } from "resend";
import { z } from "zod";

import {
  type DbExecutor,
  type TransactionPool,
  queryOne,
  withTransaction,
} from "../db/connection.ts";
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
import { EMAIL_CODE_MAX_ATTEMPTS } from "../signer-checks.ts";
import { emailTemplateKinds, envelopeStatuses } from "../types/domain.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import { releaseSentWebhook } from "../webhooks/outbox.ts";
import {
  RETENTION_DAY_SECONDS,
  RETENTION_WARNING_DAYS,
  readRetentionPolicy,
  retentionNoticeKeySql,
} from "./retention-policy.ts";
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
/** Stable for one deadline and recipient, including a return to an earlier mailbox. */
export const EXPIRY_NOTICE_KEY_SQL =
  "('expiry-notice/' || e.id || '/' || e.expires_at::text || '/' || e.retention_custody_revision::text || '/' || u.retention_mailbox_revision::text)";
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
  z.object({ kind: z.literal("password_reset"), verificationId: id }),
  z.object({
    kind: z.literal("signing_lock"),
    adminId: id,
    lockedAt: expiry,
    auditSequence: z.number().int().positive().optional(),
  }),
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
    // Numeric snapshots predate recipient-specific notice identities. They
    // decode so the worker can retire them without granting grace.
    policyGeneration: z
      .union([z.uuid(), z.number().int().positive()])
      .optional(),
    noticeKey: id.optional(),
    audit: emailAudit.optional(),
  }),
  z.object({
    kind: z.literal("expiry_notice"),
    expiresAt: expiry,
    noticeKey: id.optional(),
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
  signingExpiresAt?: number;
  guard?: EmailJobGuard;
  acknowledgement?: EmailAcknowledgement;
};

function hasGuardAssociation(
  job: { envelopeId?: string | null; userId?: string | null },
  {
    acknowledgement,
    guard,
  }: Pick<EnqueueEmailInput, "acknowledgement" | "guard">,
): boolean {
  if (acknowledgement && !job.envelopeId) return false;
  if (!guard) return true;
  return guard.kind === "signing_lock" || guard.kind === "password_reset"
    ? Boolean(job.userId)
    : Boolean(job.envelopeId);
}

function isEnvelopeOwnerNotice({
  guard,
  acknowledgement,
}: Pick<EnqueueEmailInput, "guard" | "acknowledgement">) {
  return (
    acknowledgement?.kind === "retention_warning" ||
    acknowledgement?.kind === "expiry_notice" ||
    (guard?.kind === "envelope_status" &&
      acknowledgement?.kind === "email_audit" &&
      !acknowledgement.signerId)
  );
}

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
  if (
    !hasGuardAssociation(job, { guard, acknowledgement }) ||
    (job.signingExpiresAt !== undefined && guard?.kind !== "signer_token") ||
    (message.template === "password_reset" &&
      guard?.kind !== "password_reset") ||
    (acknowledgement?.kind === "retention_warning" &&
      (typeof acknowledgement.policyGeneration !== "string" ||
        !acknowledgement.noticeKey ||
        !job.userId))
  ) {
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
    {
      ...job,
      kind: "email",
      payload: payload.data,
      purgeWithUser: isEnvelopeOwnerNotice({ guard, acknowledgement }),
    },
    { database, env },
  );
}

type EnvelopeGuardRow = {
  finalizationPending: boolean;
  status: (typeof envelopeStatuses)[number];
  expiresAt: number | null;
  expiryNotifiedAt: number | null;
  expiryNoticeKey: string | null;
  retentionWarnedAt: number | null;
  part11: boolean;
  now: number;
  finishedAt: number;
  warningKey: string | null;
  noticeKey: string | null;
  ownerId: string;
  ownerEmail: string;
};

async function emailGuardMatches(
  job: ClaimedRecoveryJob,
  { guard, acknowledgement, message }: FrozenEmail,
  database: DbExecutor,
): Promise<boolean> {
  if (guard?.kind === "password_reset") {
    const reset = await queryOne<{ id: string }>(
      database,
      `
      SELECT v.id FROM verification v
      JOIN "user" u ON u.id = v.value
      WHERE v.id = $1 AND u.id = $2 AND lower(u.email) = lower($3)
        AND v.identifier LIKE 'reset-password:%' AND v."expiresAt" > clock_timestamp()
    `,
      [guard.verificationId, job.userId, message.to],
    );
    return reset !== null;
  }

  if (guard?.kind === "signing_lock") {
    const admin = await queryOne<{ id: string }>(
      database,
      `
      SELECT a.id FROM "user" a
      JOIN "user" person ON person.id = $1 AND person.signing_locked_at = $2
      WHERE a.id = $3 AND a.role = 'admin' AND a.email = $4
        AND ($5::bigint IS NULL OR NOT EXISTS (
          SELECT 1 FROM system_audit_events WHERE target_user_id = person.id
            AND sequence > $5 AND event IN ('signing_locked', 'signing_unlocked', 'account_deleted')
        ))
    `,
      [
        job.userId,
        guard.lockedAt,
        guard.adminId,
        message.to,
        guard.auditSequence ?? null,
      ],
    );
    return admin !== null;
  }

  if (!guard && (!acknowledgement || acknowledgement.kind === "email_audit"))
    return true;

  const envelope = await queryOne<EnvelopeGuardRow>(
    database,
    `SELECT status, finalization_pending AS "finalizationPending",expires_at AS "expiresAt", expiry_notified_at AS "expiryNotifiedAt",
        retention_warned_at AS "retentionWarnedAt", part11, ${DATABASE_SECONDS} AS now,
        COALESCE(e.completed_at, e.declined_at, e.voided_at, e.updated_at) AS "finishedAt",
        e.retention_warning_key AS "warningKey", ${retentionNoticeKeySql("$2")} AS "noticeKey",
        u.id AS "ownerId", u.email AS "ownerEmail", ${EXPIRY_NOTICE_KEY_SQL} AS "expiryNoticeKey"
      FROM envelopes e JOIN "user" u ON u.id=e.user_id WHERE e.id = $1`,
    [
      job.envelopeId,
      acknowledgement?.kind === "retention_warning" &&
      typeof acknowledgement.policyGeneration === "string"
        ? acknowledgement.policyGeneration
        : null,
    ],
  );
  if (!envelope) return false;

  // Owner notices cannot disclose a retained record to a former keeper.
  if (
    isEnvelopeOwnerNotice({ guard, acknowledgement }) &&
    job.userId &&
    (job.userId !== envelope.ownerId || message.to !== envelope.ownerEmail)
  )
    return false;

  if (
    acknowledgement?.kind === "expiry_notice" &&
    (envelope.status !== "sent" ||
      envelope.finalizationPending ||
      envelope.expiresAt !== acknowledgement.expiresAt ||
      (acknowledgement.noticeKey !== undefined &&
        envelope.expiryNoticeKey !== acknowledgement.noticeKey) ||
      envelope.expiresAt > envelope.now ||
      envelope.expiryNotifiedAt !== null)
  )
    return false;

  if (acknowledgement?.kind === "retention_warning") {
    const policy = await readRetentionPolicy(database);
    if (
      !policy ||
      policy.generation !== acknowledgement.policyGeneration ||
      !acknowledgement.noticeKey ||
      acknowledgement.noticeKey !== envelope.noticeKey ||
      !FINAL_ENVELOPE_STATUSES.has(envelope.status) ||
      envelope.part11 ||
      (envelope.retentionWarnedAt !== null &&
        envelope.warningKey === envelope.noticeKey) ||
      envelope.finishedAt >=
        envelope.now -
          (policy.days - RETENTION_WARNING_DAYS) * RETENTION_DAY_SECONDS
    )
      return false;
  }

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
      AND signing_token_hash = $3
      AND (signing_token_expires_at IS NULL OR signing_token_expires_at >= ${DATABASE_SECONDS})
      AND ($4::text IS NULL OR (
        email_code_hash = $4
        AND email_code_expires_at >= ${DATABASE_SECONDS}
        AND email_code_attempts < $5
      ))`,
    [
      job.envelopeId,
      guard.signerId,
      guard.tokenHash,
      codeHash,
      EMAIL_CODE_MAX_ATTEMPTS,
    ],
  );
  return result.rowCount === 1;
}

async function acknowledgeEmail(
  envelopeId: string,
  userId: string | null,
  { message, acknowledgement }: FrozenEmail,
  messageId: string,
  database: DbExecutor,
): Promise<void> {
  if (!acknowledgement) return;

  if (acknowledgement.kind === "retention_warning") {
    const policy = await readRetentionPolicy(database, true);
    if (policy && policy.generation === acknowledgement.policyGeneration) {
      await database.query(
        `UPDATE envelopes e SET retention_warned_at = ${DATABASE_SECONDS}, retention_warning_key = $4
          FROM "user" u
          WHERE e.id = $1 AND status IN ('completed', 'declined', 'voided') AND NOT part11
            AND u.id=e.user_id AND u.id=$5 AND u.email=$6
            AND ${retentionNoticeKeySql("$2")} = $4
            AND (retention_warned_at IS NULL OR retention_warning_key IS DISTINCT FROM $4)
            AND COALESCE(e.completed_at, e.declined_at, e.voided_at, e.updated_at) < ${DATABASE_SECONDS} - $3`,
        [
          envelopeId,
          policy.generation,
          (policy.days - RETENTION_WARNING_DAYS) * RETENTION_DAY_SECONDS,
          acknowledgement.noticeKey,
          userId,
          message.to,
        ],
      );
    }
  } else if (acknowledgement.kind === "expiry_notice") {
    // Publication already holds the envelope. Let a conflicting account edit
    // finish first, without waiting in reverse purge lock order.
    const recorded = await queryOne<{ notifiedAt: number }>(
      database,
      `UPDATE envelopes e SET expiry_notified_at = ${DATABASE_SECONDS}
        FROM (SELECT id, retention_mailbox_revision FROM "user" WHERE id = $3 AND email = $4 FOR SHARE NOWAIT) u
        WHERE e.id = $1 AND e.user_id = u.id AND e.status = 'sent' AND e.expires_at = $2
          AND NOT e.finalization_pending AND e.expiry_notified_at IS NULL
          AND ($5::text IS NULL OR ${EXPIRY_NOTICE_KEY_SQL} = $5)
        RETURNING e.expiry_notified_at AS "notifiedAt"`,
      [
        envelopeId,
        acknowledgement.expiresAt,
        userId,
        message.to,
        acknowledgement.noticeKey ?? null,
      ],
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
    database: TransactionPool;
    env?: EnvSource;
    emailService?: EmailService;
    signal?: AbortSignal;
  },
): Promise<void> {
  const parsed = frozenEmailSchema.safeParse(job.payload);
  if (job.kind !== "email" || !parsed.success)
    throw new RecoveryJobError("payload_invalid", true);
  const payload = parsed.data;
  if (
    payload.message.template === "password_reset" &&
    payload.guard?.kind !== "password_reset"
  ) {
    await cancelRecoveryJob(job, { database, code: "guard_changed" });
    return;
  }
  if (!hasGuardAssociation(job, payload)) {
    throw new RecoveryJobError("payload_invalid", true);
  }

  if (
    !job.envelopeId &&
    job.userId &&
    payload.guard?.kind !== "password_reset"
  ) {
    const user = await database.query('SELECT 1 FROM "user" WHERE id = $1', [
      job.userId,
    ]);
    // A Better Auth-owned transaction may still be inserting this user.
    if (user.rowCount !== 1) throw new RecoveryJobError("missing_parent");
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
  if (!(await emailGuardMatches(job, payload, database))) {
    // A signer deadline may have moved since the read. Decide whether to
    // retire the token under the same envelope-first order as the edit.
    if (payload.guard?.kind === "signer_token" && job.envelopeId) {
      const current = await withTransaction(async (tx) => {
        const envelope = await queryOne<{ id: string }>(
          tx,
          "SELECT id FROM envelopes WHERE id = $1 FOR NO KEY UPDATE",
          [job.envelopeId],
        );
        if (envelope && (await emailGuardMatches(job, payload, tx)))
          return true;
        await cancelRecoveryJob(job, { database: tx, code: "guard_changed" });
        return false;
      }, database);
      if (!current) return;
    } else {
      await cancelRecoveryJob(job, { database, code: "guard_changed" });
      return;
    }
  }

  // A domain guard may wait on PostgreSQL. Check the live lease and
  // dispatch window after every successful guard path.
  const status = await getEmailDispatchStatus(job, database);
  if (status === "stale") return;
  if (status === "expired") {
    await cancelRecoveryJob(job, { database, code: "expired" });
    return;
  }
  if (status === "retry_window_elapsed")
    throw new RecoveryJobError(status, true);
  const service = emailService ?? createRecoveryEmailService(env);
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
        ? (tx) =>
            acknowledgeEmail(envelopeId, job.userId, payload, messageId, tx)
        : undefined,
  });
  if (envelopeId && message.template === "signing_invitation") {
    await releaseSentWebhook(envelopeId, database).catch((error: unknown) => {
      console.error(
        `Releasing the envelope.sent webhook of ${envelopeId} failed:`,
        error,
      );
    });
  }
}
