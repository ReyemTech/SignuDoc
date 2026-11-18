import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { requestAccountClosure } from "../account.ts";
import { type DbPool } from "../db/connection.ts";
import { afterStatement, openTestDatabase } from "../db/test-database.ts";
import { sendFreshDownloadLinks } from "../download-renewal.ts";
import { createRecipientDownloadLink } from "../downloads.ts";
import { runEnvelopeSchedule } from "../envelope-schedule.ts";
import { changeEnvelopeDeadline } from "../envelopes.ts";
import { checkSigningCredentials } from "../part11.ts";
import { sendManualEnvelopeNudge } from "../reminders.ts";
import { runRetentionSweep } from "../retention.ts";
import {
  type EmailService,
  type TransactionalEmailMessage,
} from "../services/email.ts";
import { hashOpaqueToken } from "../services/opaque-tokens.ts";
import { issueSigningLink } from "../services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "../services/storage.ts";
import { readStoredSettings, saveSettings } from "../settings.ts";
import { getSigningPayloadForToken, sendSignerEmailCode } from "../signing.ts";
import { enqueueEmail } from "./email.ts";
import { runRecoveryJobs } from "./worker.ts";

const DAY = 86_400;
const env = {
  APP_URL: "https://sign.example.test",
  BETTER_AUTH_SECRET: "fixture-secret-for-durable-workflow",
  CRON_SECRET: "test-cron",
  DURABLE_JOBS_ENABLED: "true",
  EMAIL_DRIVER: "capture",
  SUPPORT_EMAIL: "support@example.test",
};
Object.assign(process.env, env);

let database: DbPool;
let storage: StorageService;
let directory: string;
const users: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  directory = await mkdtemp(path.join(tmpdir(), "signudoc-workflow-email-"));
  process.env.EMAIL_CAPTURE_DIR = directory;
  storage = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: directory },
  });
});

after(async () => {
  await database.query("DELETE FROM recovery_jobs WHERE user_id = ANY($1)", [
    users,
  ]);
  await database.query('DELETE FROM "user" WHERE id = ANY($1)', [users]);
  await database.end();
  await rm(directory, { recursive: true, force: true });
});

function clock() {
  return Math.floor(Date.now() / 1000);
}

async function user() {
  const id = randomUUID();
  users.push(id);
  await database.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, "Fixture Owner", `${id}@example.test`],
  );
  return id;
}

async function fixture({
  status = "sent",
  deadline = clock() + DAY,
  finishedAt = clock(),
}: {
  status?: "sent" | "completed";
  deadline?: number;
  finishedAt?: number;
} = {}) {
  const userId = await user();
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const link = await issueSigningLink({ expiresInSeconds: DAY });
  const email = `${signerId}@example.test`;
  await database.query(
    `INSERT INTO envelopes (id, user_id, title, status, source_pdf_key, source_pdf_filename,
      source_pdf_size_bytes, page_count, source_pdf_hash, expires_at, sent_at, completed_at)
      VALUES ($1, $2, 'Fixture', $3, $1 || '.pdf', 'fixture.pdf', 1, 1, repeat('a',64), $4, $5, $6)`,
    [
      envelopeId,
      userId,
      status,
      deadline,
      clock() - DAY,
      status === "completed" ? finishedAt : null,
    ],
  );
  await database.query(
    `INSERT INTO signers (id, envelope_id, name, email, sign_order, status,
      signing_token_hash, signing_token_expires_at, last_notified_at)
      VALUES ($1, $2, 'Signer', $3, 1, $4, $5, $6, $7)`,
    [
      signerId,
      envelopeId,
      email,
      status === "sent" ? "notified" : "signed",
      link.tokenHash,
      link.exp,
      clock() - DAY,
    ],
  );
  return { deadline, email, envelopeId, link, signerId, userId };
}

function mail(fail = false) {
  const sent: { message: TransactionalEmailMessage; key?: string }[] = [];
  const emailService: EmailService = {
    async send(message, options) {
      sent.push({ message, key: options?.idempotencyKey });
      if (fail) throw new Error("fixture provider unavailable");
      return {
        accepted: [message.to],
        rejected: [],
        messageId: "captured-for-test",
      };
    },
    async sendBatch() {
      throw new Error("unexpected batch");
    },
  };
  return { emailService, sent };
}

async function jobFor(envelopeId: string) {
  return (
    await database.query<{
      id: string;
      state: string;
      expires_at: number | null;
    }>(
      "SELECT id, state, expires_at FROM recovery_jobs WHERE envelope_id = $1 ORDER BY created_at DESC LIMIT 1",
      [envelopeId],
    )
  ).rows[0];
}

async function retry(id: string, emailService: EmailService) {
  await database.query(
    "UPDATE recovery_jobs SET available_at = clock_timestamp() WHERE id = $1",
    [id],
  );
  await runRecoveryJobs({ database, jobId: id, emailService });
}

test("durable reminder retries the exact new link while keeping it active through outage", async () => {
  const f = await fixture();
  const failed = mail(true);
  await sendManualEnvelopeNudge(
    f.userId,
    f.envelopeId,
    {
      senderEmail: "sender@example.test",
      senderName: "Fixture Owner",
    },
    { database, emailService: failed.emailService },
  );
  const job = await jobFor(f.envelopeId);
  assert.equal(job?.state, "pending");
  assert.equal(job.expires_at, f.deadline);
  const token = failed.sent[0]?.message.textBody.match(/\/sign\/([\w-]+)/)?.[1];
  assert.ok(token);
  await getSigningPayloadForToken(token, { database });

  const success = mail();
  await retry(job.id, success.emailService);
  assert.deepEqual(success.sent, failed.sent);
  assert.equal((await jobFor(f.envelopeId))?.state, "succeeded");
});

test("the durable schedule leaves a failed automatic reminder active for recovery", async () => {
  const f = await fixture();
  await database.query(
    "UPDATE envelopes SET reminder_interval_days = 1 WHERE id = $1",
    [f.envelopeId],
  );
  const failed = mail(true);
  try {
    const summary = await runEnvelopeSchedule({
      database,
      emailService: failed.emailService,
    });
    assert.equal(summary.remindersSent, 0);
    assert.deepEqual(summary.reminderFailures, []);
    assert.equal(failed.sent[0]?.message.template, "automatic_reminder");
    assert.equal((await jobFor(f.envelopeId))?.state, "pending");
  } finally {
    await database.query(
      "UPDATE envelopes SET reminder_interval_days = NULL WHERE id = $1",
      [f.envelopeId],
    );
  }
});

test("durable signing code uses the verifier rules for legacy token expiry and exhausted attempts", async () => {
  const f = await fixture();
  await database.query(
    "UPDATE signers SET signing_token_expires_at = NULL, require_email_code = true WHERE id = $1",
    [f.signerId],
  );
  const failed = mail(true);
  const { emailCodeSentAt } = await sendSignerEmailCode(f.link.token, {
    database,
    emailService: failed.emailService,
  });
  const job = await jobFor(f.envelopeId);
  assert.equal(job?.state, "pending");
  assert.equal(job.expires_at, emailCodeSentAt + 601);
  assert.equal(failed.sent.length, 1);

  await database.query(
    "UPDATE signers SET email_code_attempts = 5 WHERE id = $1",
    [f.signerId],
  );
  const success = mail();
  await retry(job.id, success.emailService);
  assert.equal(success.sent.length, 0);
  assert.equal((await jobFor(f.envelopeId))?.state, "cancelled");
});

test("durable expiry notice is cancelled after the unchanged link gets a new deadline", async () => {
  const f = await fixture({ deadline: clock() - 60 });
  const failed = mail(true);
  const summary = await runEnvelopeSchedule({
    database,
    emailService: failed.emailService,
  });
  assert.equal(summary.expiryNoticesSent, 0);
  const job = await jobFor(f.envelopeId);
  assert.equal(job?.state, "pending");
  await changeEnvelopeDeadline(
    f.userId,
    f.envelopeId,
    {
      expiresInDays: 7,
      senderEmail: "sender@example.test",
    },
    { database },
  );
  await getSigningPayloadForToken(f.link.token, { database });
  const success = mail();
  await retry(job.id, success.emailService);
  assert.equal(success.sent.length, 0);
  assert.equal((await jobFor(f.envelopeId))?.state, "cancelled");
  const { rows } = await database.query(
    "SELECT expiry_notified_at FROM envelopes WHERE id = $1",
    [f.envelopeId],
  );
  assert.deepEqual(rows, [{ expiry_notified_at: null }]);
});

test("durable retention warning keeps its frozen payload and starts grace at acknowledgement", async () => {
  const originalRetention =
    (await readStoredSettings(database))?.retentionDays ?? null;
  const f = await fixture({
    status: "completed",
    finishedAt: clock() - 95 * DAY,
  });
  const failed = mail(true);
  const warnedAt = async () =>
    (
      await database.query<{ retention_warned_at: number | null }>(
        "SELECT retention_warned_at FROM envelopes WHERE id = $1",
        [f.envelopeId],
      )
    ).rows[0]?.retention_warned_at;
  try {
    await saveSettings({ retentionDays: 90 }, database);
    const runNow = clock() - DAY;
    const first = await runRetentionSweep({
      database,
      storageService: storage,
      now: runNow,
      emailService: failed.emailService,
    });
    assert.equal(first.finishedEnvelopeWarningsSent, 0);
    assert.equal(await warnedAt(), null);
    const job = await jobFor(f.envelopeId);
    assert.equal(job?.state, "pending");
    const second = await runRetentionSweep({
      database,
      storageService: storage,
      now: runNow + DAY,
      emailService: failed.emailService,
    });
    assert.deepEqual(second.finishedEnvelopeDeletionFailures, []);
    assert.equal((await jobFor(f.envelopeId))?.id, job.id);
    assert.equal(await warnedAt(), null);
    const success = mail();
    const before = clock();
    await retry(job.id, success.emailService);
    assert.deepEqual(
      success.sent.filter(
        ({ message }) => message.to === `${f.userId}@example.test`,
      ),
      failed.sent.filter(
        ({ message }) => message.to === `${f.userId}@example.test`,
      ),
    );
    assert.ok((await warnedAt())! >= before);
  } finally {
    await saveSettings({ retentionDays: originalRetention }, database);
  }
});

test("durable renewal rolls both links back on enqueue failure and replays the same committed links", async () => {
  const f = await fixture({ status: "completed" });
  const link = await createRecipientDownloadLink(
    { envelopeId: f.envelopeId, signerId: f.signerId, fileType: "evidence" },
    { database },
  );
  const failed = mail(true);
  const failingDatabase = afterStatement(
    database,
    (sql) => sql.includes("INSERT INTO recovery_jobs"),
    async () => {
      throw new Error("forced enqueue transaction rollback");
    },
  );
  await assert.rejects(
    sendFreshDownloadLinks(link.token, {
      database: failingDatabase,
      emailService: failed.emailService,
    }),
    /forced enqueue transaction rollback/,
  );
  assert.equal(await jobFor(f.envelopeId), undefined);
  assert.equal(failed.sent.length, 0);

  await sendFreshDownloadLinks(link.token, {
    database,
    emailService: failed.emailService,
  });
  const job = await jobFor(f.envelopeId);
  assert.equal(job?.state, "pending");
  const success = mail();
  await retry(job.id, success.emailService);
  assert.deepEqual(success.sent, failed.sent);
  const hashes = success.sent[0]!.message.textBody.match(
    /\/api\/download\/[\w-]+/g,
  )?.map((url) => hashOpaqueToken(url.split("/").at(-1)!));
  const stored = await database.query<{ token_hash: string }>(
    "SELECT token_hash FROM recipient_download_tokens WHERE envelope_id = $1",
    [f.envelopeId],
  );
  assert.deepEqual(
    new Set(hashes),
    new Set(stored.rows.map((row) => row.token_hash)),
  );
});

test("durable account closure is atomic and purge clears user and envelope jobs", async () => {
  const f = await fixture();
  const failingDatabase = afterStatement(
    database,
    (sql) => sql.includes("INSERT INTO recovery_jobs"),
    async () => {
      throw new Error("forced enqueue transaction rollback");
    },
  );
  await assert.rejects(
    requestAccountClosure(
      f.userId,
      { confirmation: "close my account" },
      { database: failingDatabase },
    ),
    /forced enqueue transaction rollback/,
  );
  assert.equal(
    (
      await database.query(
        "SELECT 1 FROM account_closure_requests WHERE user_id = $1",
        [f.userId],
      )
    ).rowCount,
    0,
  );

  const failed = mail(true);
  const closure = await requestAccountClosure(
    f.userId,
    { confirmation: "close my account" },
    { database, emailService: failed.emailService },
  );
  assert.equal(closure.alreadyQueued, false);
  assert.equal(failed.sent[0]?.message.template, "account_closure_request");
  const standalone = await enqueueEmail(
    {
      message: {
        subject: "Fixture",
        template: "password_reset",
        textBody: "Fixture reset link",
        to: f.email,
      },
      dedupeKey: `purge/${f.userId}`,
      userId: f.userId,
    },
    { database },
  );
  const dangling = await enqueueEmail(
    {
      message: {
        subject: "Fixture",
        template: "signing_invitation",
        textBody: "Fixture signing link",
        to: f.email,
      },
      dedupeKey: `purge/${f.envelopeId}`,
      envelopeId: f.envelopeId,
    },
    { database },
  );
  const summary = await runRetentionSweep({
    database,
    now: closure.purgeAfterAt + 1,
    storageService: storage,
    emailService: failed.emailService,
  });
  assert.ok(summary.accountsPurged >= 1);
  assert.equal(
    (
      await database.query(
        "SELECT 1 FROM recovery_jobs WHERE user_id = $1 OR id = ANY($2::uuid[])",
        [f.userId, [standalone.id, dangling.id]],
      )
    ).rowCount,
    0,
  );
});

test("durable Part 11 lock rolls back with its alert and cancels delivery to a former administrator", async () => {
  const person = await user();
  const administrator = await user();
  await database.query(`UPDATE "user" SET role = 'admin' WHERE id = $1`, [
    administrator,
  ]);
  await database.query(
    'UPDATE "user" SET "emailVerified" = true, identity_verified_at = $2, signing_failed_attempts = 4 WHERE id = $1',
    [person, clock()],
  );
  const state = async () =>
    (
      await database.query(
        'SELECT signing_failed_attempts, signing_locked_at FROM "user" WHERE id = $1',
        [person],
      )
    ).rows[0];
  const input = {
    userId: person,
    email: `${person}@example.test`,
    password: "fixture-rejected-password",
  };
  const failed = mail(true);
  const failingDatabase = afterStatement(
    database,
    (sql) => sql.includes("INSERT INTO recovery_jobs"),
    async () => {
      assert.deepEqual(await state(), {
        signing_failed_attempts: 4,
        signing_locked_at: null,
      });
      throw new Error("forced enqueue transaction rollback");
    },
  );
  await assert.rejects(
    checkSigningCredentials(input, {
      database: failingDatabase,
      emailService: failed.emailService,
    }),
    /forced enqueue transaction rollback/,
  );
  assert.deepEqual(await state(), {
    signing_failed_attempts: 4,
    signing_locked_at: null,
  });

  assert.deepEqual(
    await checkSigningCredentials(input, {
      database,
      emailService: failed.emailService,
    }),
    { attemptsLeft: 0, locked: true, ok: false },
  );
  assert.equal((await state()).signing_failed_attempts, 5);
  assert.ok(
    failed.sent.some(
      ({ message }) => message.to === `${administrator}@example.test`,
    ),
  );
  assert.ok(
    failed.sent.every(
      ({ message }) => !message.textBody.includes(input.password),
    ),
  );
  await database.query(`UPDATE "user" SET role = 'user' WHERE id = $1`, [
    administrator,
  ]);
  const jobs = await database.query<{ id: string }>(
    "SELECT id FROM recovery_jobs WHERE user_id = $1",
    [person],
  );
  assert.ok(jobs.rows.length);
  const success = mail();
  for (const { id } of jobs.rows) await retry(id, success.emailService);
  assert.ok(
    success.sent.every(
      ({ message }) => message.to !== `${administrator}@example.test`,
    ),
  );
});
