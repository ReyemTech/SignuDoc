import { emailSubject } from "./services/email-subject.ts";
import { isDurableJobsEnabled } from "./recovery/config.ts";
import { enqueueEmail } from "./recovery/email.ts";
import { tryDeliverWorkflowEmails } from "./recovery/workflow-email.ts";
import {
  type DbPool,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { formatDeadline } from "./envelope-deadline.ts";
import { sendAutomaticEnvelopeReminder } from "./reminders.ts";
import { recordAuditEvent } from "./services/audit.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import { AUTOMATIC_REMINDER_SLACK_SECONDS } from "./services/reminders.ts";
import { resolveAppUrl } from "./utils/env.ts";

// What the daily job does for envelopes that are out for signature:
//
// - it tells a sender once when a deadline has passed with signatures still
//   missing;
// - it reminds the signer whose turn it is, on envelopes whose sender asked
//   for automatic reminders.
//
// It runs from the same cron call as the cleanup (see retention-job.ts), so
// an install needs no second schedule, and that call's lock means two runs
// never work at once.
//
// Durable mode freezes each due notice under the envelope lock and stamps
// the notice time on provider acceptance. Pending notices and reminders
// then follow the recovery worker's retry schedule.
//
// In legacy mode a passed-deadline notice is sent first and noted afterwards. So a
// notice that did not go out, because the email failed or because the run
// was cut off, is simply still due on the next run. The cost is that a run
// cut off between the two can send the notice a second time; the mail
// provider drops a repeat that reaches it within its idempotency window.
//
// A legacy reminder changes the signer's link before sending and restores
// the previous link if email fails (see reminders.ts).

const BATCH_SIZE = 200;
// The job shares one function call with the cleanup, and a mail provider
// takes about half a second per message. Past this, what is left waits for
// the next run instead of risking the call being cut off mid-send.
const TIME_BUDGET_MS = 60_000;

export type EnvelopeScheduleSummary = {
  expiryNoticeFailures: string[];
  expiryNoticesSent: number;
  reminderFailures: string[];
  remindersSent: number;
  /** True when the time ran out and some envelopes wait for the next run. */
  stoppedEarly: boolean;
};

type ScheduleRun = {
  database: DbPool;
  durable: boolean;
  emailService: () => EmailService;
  injectedEmailService?: EmailService;
  now: number;
  outOfTime: () => boolean;
  summary: EnvelopeScheduleSummary;
};

type ExpiredEnvelopeRow = {
  expiresAt: number;
  id: string;
  ownerEmail: string;
  ownerName: string | null;
  signerEmail: string | null;
  signerName: string | null;
  title: string;
  userId: string;
};

async function listExpiredEnvelopesToNotify(
  now: number,
  database: DbPool,
  durable: boolean,
): Promise<ExpiredEnvelopeRow[]> {
  return queryMany<ExpiredEnvelopeRow>(
    database,
    `
      SELECT
        e.id,
        e.title,
        e.user_id AS "userId",
        e.expires_at AS "expiresAt",
        u.email AS "ownerEmail",
        u.name AS "ownerName",
        s.name AS "signerName",
        s.email AS "signerEmail"
      FROM envelopes e
      JOIN "user" u ON u.id = e.user_id
      LEFT JOIN signers s
        ON s.envelope_id = e.id
        AND s.status = 'notified'
      WHERE e.status = 'sent' AND NOT e.finalization_pending
        AND e.expires_at IS NOT NULL
        AND e.expires_at <= $1
        AND e.expiry_notified_at IS NULL
        ${
          durable
            ? `AND NOT EXISTS (
          SELECT 1 FROM recovery_jobs r
          WHERE r.dedupe_key = 'expiry-notice/' || e.id || '/' || e.expires_at::text
        )`
            : ""
        }
      ORDER BY e.expires_at ASC, e.id ASC
      LIMIT ${BATCH_SIZE}
    `,
    [now],
  );
}

/**
 * True while there is still something to tell: the envelope is out, its
 * deadline is the one that passed, and the sender has not been told. The
 * list above can be minutes old by the time an envelope's turn comes, and
 * the sender may have moved the deadline or voided the envelope since.
 */
async function isExpiryNoticeDue(
  envelope: ExpiredEnvelopeRow,
  database: DbPool,
): Promise<boolean> {
  const due = await queryOne<{ id: string }>(
    database,
    `
      SELECT id
      FROM envelopes
      WHERE id = $1
        AND status = 'sent' AND NOT finalization_pending
        AND expires_at = $2
        AND expiry_notified_at IS NULL
    `,
    [envelope.id, envelope.expiresAt],
  );

  return due !== null;
}

/**
 * Marks the envelope as told and notes the passed deadline in its audit
 * trail, once the notice has gone out. Nothing is noted when the sender
 * moved the deadline while the notice was on its way: the new deadline is a
 * new thing to tell.
 */
async function noteExpiryNoticeSent(
  envelope: ExpiredEnvelopeRow,
  now: number,
  database: DbPool,
): Promise<void> {
  await withTransaction(async (tx) => {
    const noted = await tx.query(
      `
        UPDATE envelopes
        SET expiry_notified_at = $1
        WHERE id = $2
          AND status = 'sent' AND NOT finalization_pending
          AND expires_at = $3
          AND expiry_notified_at IS NULL
      `,
      [now, envelope.id, envelope.expiresAt],
    );

    if (noted.rowCount !== 1) {
      return;
    }

    await recordAuditEvent(
      {
        actorType: "system",
        createdAt: now,
        envelopeId: envelope.id,
        event: "expired",
        metadata: { expiresAt: envelope.expiresAt },
      },
      tx,
    );
  }, database);
}

function buildExpiryNotice(envelope: ExpiredEnvelopeRow) {
  const appUrl = resolveAppUrl();
  const link = appUrl ? `${appUrl}/envelopes/${envelope.id}` : null;
  const waitingOn =
    envelope.signerName && envelope.signerEmail
      ? ` It was still waiting on ${envelope.signerName} (${envelope.signerEmail}).`
      : "";

  return {
    subject: emailSubject`"${envelope.title}" expired before everyone signed`,
    template: "expiry_notice" as const,
    textBody: [
      `Hello ${envelope.ownerName?.trim() || envelope.ownerEmail},`,
      "",
      `The deadline for "${envelope.title}" passed on ${formatDeadline(envelope.expiresAt)}.${waitingOn} Nobody can sign it now.`,
      "",
      "To give signers more time, open the envelope and set a new deadline. The signing link that was already sent will work again. If the document is no longer needed, void it.",
      ...(link ? ["", link] : []),
    ].join("\n"),
    to: envelope.ownerEmail,
  };
}

async function enqueueExpiryNotice(
  envelope: ExpiredEnvelopeRow,
  database: DbPool,
): Promise<string | undefined> {
  return withTransaction(async (tx) => {
    const current = await queryOne<ExpiredEnvelopeRow>(
      tx,
      `
      SELECT e.id, e.title, e.user_id AS "userId", e.expires_at AS "expiresAt",
        u.email AS "ownerEmail", u.name AS "ownerName",
        NULL AS "signerEmail", NULL AS "signerName"
      FROM envelopes e JOIN "user" u ON u.id = e.user_id
      WHERE e.id = $1 AND e.status = 'sent' AND NOT e.finalization_pending AND e.expires_at = $2
        AND e.expiry_notified_at IS NULL
        AND e.expires_at <= floor(extract(epoch from clock_timestamp()))
      FOR NO KEY UPDATE OF e
    `,
      [envelope.id, envelope.expiresAt],
    );
    if (!current) return;
    const dedupeKey = `expiry-notice/${current.id}/${current.expiresAt}`;
    const existing = await queryOne<{ id: string }>(
      tx,
      "SELECT id FROM recovery_jobs WHERE dedupe_key = $1",
      [dedupeKey],
    );
    if (existing) return;

    // The deadline is the event. Its message stays applicable if the sender
    // corrects the waiting recipient without moving that deadline.
    const { id } = await enqueueEmail(
      {
        message: buildExpiryNotice(current),
        dedupeKey,
        envelopeId: current.id,
        userId: current.userId,
        acknowledgement: {
          kind: "expiry_notice",
          expiresAt: current.expiresAt,
        },
      },
      { database: tx },
    );
    return id;
  }, database);
}

async function sendExpiryNotices({
  database,
  durable,
  emailService,
  injectedEmailService,
  now,
  outOfTime,
  summary,
}: ScheduleRun): Promise<void> {
  const expired = await listExpiredEnvelopesToNotify(now, database, durable);

  for (const envelope of expired) {
    if (outOfTime()) {
      summary.stoppedEarly = true;
      return;
    }

    try {
      if (durable) {
        const id = await enqueueExpiryNotice(envelope, database);
        if (
          id &&
          (
            await tryDeliverWorkflowEmails([id], {
              database,
              emailService: injectedEmailService,
            })
          ).has(id)
        ) {
          summary.expiryNoticesSent += 1;
        }
        continue;
      }
      if (!(await isExpiryNoticeDue(envelope, database))) {
        continue;
      }

      await emailService().send(buildExpiryNotice(envelope), {
        idempotencyKey: `expiry-notice/${envelope.id}/${envelope.expiresAt}`,
      });
      await noteExpiryNoticeSent(envelope, now, database);

      summary.expiryNoticesSent += 1;
    } catch (error) {
      summary.expiryNoticeFailures.push(envelope.id);
      console.error(`Expiry notice failed for envelope ${envelope.id}:`, error);
    }
  }
}

/**
 * Envelopes whose current signer has heard nothing for the envelope's
 * reminder interval. Expired ones are left out: their link is dead, and the
 * sender has been told.
 */
async function listEnvelopesDueForReminder(
  now: number,
  database: DbPool,
): Promise<string[]> {
  const rows = await queryMany<{ id: string }>(
    database,
    `
      SELECT e.id
      FROM envelopes e
      JOIN signers s
        ON s.envelope_id = e.id
        AND s.status = 'notified'
      WHERE e.status = 'sent' AND NOT e.finalization_pending
        AND e.reminder_interval_days IS NOT NULL
        AND (e.expires_at IS NULL OR e.expires_at > $1)
        AND GREATEST(
          COALESCE(s.last_notified_at, 0),
          COALESCE(s.last_nudged_at, 0)
        ) > 0
        AND GREATEST(
          COALESCE(s.last_notified_at, 0),
          COALESCE(s.last_nudged_at, 0)
        ) + e.reminder_interval_days * 86400 - $2 <= $1
      ORDER BY
        GREATEST(
          COALESCE(s.last_notified_at, 0),
          COALESCE(s.last_nudged_at, 0)
        ) ASC,
        e.id ASC
      LIMIT ${BATCH_SIZE}
    `,
    [now, AUTOMATIC_REMINDER_SLACK_SECONDS],
  );

  return rows.map((row) => row.id);
}

async function sendAutomaticReminders({
  database,
  durable,
  emailService,
  injectedEmailService,
  now,
  outOfTime,
  summary,
}: ScheduleRun): Promise<void> {
  for (const envelopeId of await listEnvelopesDueForReminder(now, database)) {
    if (outOfTime()) {
      summary.stoppedEarly = true;
      return;
    }

    try {
      const sent = await sendAutomaticEnvelopeReminder(envelopeId, {
        database,
        emailService: durable ? injectedEmailService : emailService(),
        nowUnixTimestamp: now,
      });

      if (sent) {
        summary.remindersSent += 1;
      }
    } catch (error) {
      summary.reminderFailures.push(envelopeId);
      console.error(
        `Automatic reminder failed for envelope ${envelopeId}:`,
        error,
      );
    }
  }
}

export async function runEnvelopeSchedule({
  database,
  emailService,
  now = Math.floor(Date.now() / 1000),
  timeBudgetMs = TIME_BUDGET_MS,
}: {
  database: DbPool;
  emailService?: EmailService;
  now?: number;
  timeBudgetMs?: number;
}): Promise<EnvelopeScheduleSummary> {
  const summary: EnvelopeScheduleSummary = {
    expiryNoticeFailures: [],
    expiryNoticesSent: 0,
    reminderFailures: [],
    remindersSent: 0,
    stoppedEarly: false,
  };
  const stopAt = Date.now() + timeBudgetMs;
  let service = emailService;
  // Made only when there is something to send: an install without email
  // set up yet must not fail the whole job.
  const getEmailService = () => (service ??= createEmailService());

  const run: ScheduleRun = {
    database,
    durable: isDurableJobsEnabled(),
    emailService: getEmailService,
    injectedEmailService: emailService,
    now,
    outOfTime: () => Date.now() >= stopAt,
    summary,
  };

  await sendExpiryNotices(run);
  await sendAutomaticReminders(run);

  return summary;
}

export function envelopeScheduleFailed(
  summary: EnvelopeScheduleSummary,
): boolean {
  return (
    summary.expiryNoticeFailures.length > 0 ||
    summary.reminderFailures.length > 0
  );
}
