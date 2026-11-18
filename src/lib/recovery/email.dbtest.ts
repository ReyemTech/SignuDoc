import { readStoredSettings, saveSettings } from "../settings.ts";
import { readRetentionPolicy } from "./retention-policy.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { Resend } from "resend";

import { type DbPool, withTransaction } from "../db/connection.ts";
import { afterStatement, openTestDatabase } from "../db/test-database.ts";
import { verifyAuditChain } from "../services/audit.ts";
import {
  createEmailService,
  type EmailService,
  type TransactionalEmailMessage,
} from "../services/email.ts";
import { enqueueEmail } from "./email.ts";
import { enqueueRecoveryJob } from "./jobs.ts";
import { runRecoveryJobs } from "./worker.ts";

let database: DbPool;
const env = {
  DURABLE_JOBS_ENABLED: "true",
  BETTER_AUTH_SECRET: "email-db-fixture-auth-secret-value",
  CRON_SECRET: "fixture",
};
const userId = `test-user-${randomUUID()}`;
const envelopeId = `test-envelope-${randomUUID()}`;
const signerId = `test-signer-${randomUUID()}`;
const tokenHash = "7".repeat(64);
const addresses = {
  senderAddress: "Frozen Team <frozen@example.test>",
  supportAddress: "support@example.test",
};
const message = {
  subject: "Your copy",
  template: "completion_notification" as const,
  textBody: "One frozen message",
  to: "signer@example.test",
};
const dedupeKey = () => `recovery-email-test/${userId}/${randomUUID()}`;
const sendNever: EmailService = {
  send: async () => assert.fail("email reached provider"),
  sendBatch: async () => assert.fail("unexpected batch request"),
};

before(async () => {
  database = await openTestDatabase();
  await database.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "Fixture", `${userId}@example.test`],
  );
  await database.query(
    `INSERT INTO envelopes (id, user_id, title, status, source_pdf_key, source_pdf_filename, source_pdf_size_bytes, page_count, source_pdf_hash)
    VALUES ($1, $2, 'Fixture', 'completed', 'fixture', 'fixture.pdf', 1, 1, repeat('a', 64))`,
    [envelopeId, userId],
  );
  await database.query(
    `INSERT INTO signers (id, envelope_id, name, email, sign_order, status, signing_token_hash, signing_token_expires_at)
    VALUES ($1, $2, 'Fixture', $3, 1, 'notified', $4, floor(extract(epoch from clock_timestamp()))::bigint + 600)`,
    [signerId, envelopeId, message.to, tokenHash],
  );
});
after(async () => {
  if (database) {
    await database.query("DELETE FROM recovery_jobs WHERE user_id = $1", [
      userId,
    ]);
    await database.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await database.end();
  }
});

test(
  "a killed worker leaves one accepted provider send and one fenced email audit after retry",
  { timeout: 15_000 },
  async () => {
    const requests: { key: string; body: string }[] = [];
    const accepted = new Map<string, string>();
    const server = createServer(async (request, response) => {
      const key = request.headers["idempotency-key"];
      const body = (await Array.fromAsync(request)).map(String).join("");
      if (
        request.url !== "/emails" ||
        request.method !== "POST" ||
        typeof key !== "string"
      ) {
        response.writeHead(400).end();
        return;
      }
      requests.push({ key, body });
      const prior = accepted.get(key);
      if (prior !== undefined && prior !== body) {
        response.writeHead(409).end();
        return;
      }
      accepted.set(key, body);
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ id: "local-provider-id" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = server.address();
    assert.ok(endpoint && typeof endpoint !== "string");
    const baseUrl = `http://127.0.0.1:${endpoint.port}`;
    try {
      const pdf = Buffer.from("original content");
      const { id } = await enqueueEmail(
        {
          message: {
            ...message,
            attachments: [
              {
                filename: "signed.pdf",
                content: pdf,
                contentType: "application/pdf",
              },
            ],
          },
          dedupeKey: dedupeKey(),
          userId,
          envelopeId,
          guard: { kind: "envelope_status", allowedStatuses: ["completed"] },
          acknowledgement: { kind: "email_audit", signerId },
        },
        { database, env, addresses },
      );
      pdf.fill(0);
      const child = fork(
        new URL("./fixtures/interrupted-email.ts", import.meta.url),
        [id, baseUrl],
        {
          env: {
            ...process.env,
            ...env,
            DATABASE_URL:
              process.env.E2E_DATABASE_URL ??
              "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e",
          },
          execArgv: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      const exited = once(child, "exit");
      try {
        const [result] = await Promise.race([
          once(child, "message"),
          exited.then(() => assert.fail("worker exited before acceptance")),
        ]);
        assert.deepEqual(result, { accepted: "local-provider-id" });
        child.kill("SIGKILL");
        assert.deepEqual(await exited, [null, "SIGKILL"]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      const beforeRetry = await database.query(
        "SELECT state FROM recovery_jobs WHERE id = $1",
        [id],
      );
      assert.deepEqual(beforeRetry.rows, [{ state: "running" }]);
      const audits = () =>
        database.query(
          "SELECT metadata FROM audit_events WHERE envelope_id = $1 AND event = 'email_sent'",
          [envelopeId],
        );
      assert.equal((await audits()).rowCount, 0);
      await database.query(
        "UPDATE recovery_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [id],
      );
      const transport = createEmailService({
        resendClient: new Resend("re_local_fixture", { baseUrl }),
        resolveAddresses: async () => ({
          senderAddress: "Changed <new@example.test>",
          supportAddress: null,
        }),
      });
      assert.equal(
        (
          await runRecoveryJobs({
            database,
            env,
            jobId: id,
            emailService: transport,
          })
        ).processed,
        1,
      );
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0], requests[1]);
      assert.equal(accepted.size, 1);
      const frozen = JSON.parse(requests[0].body);
      assert.equal(frozen.from, "Frozen Team <frozen@example.test>");
      assert.equal(frozen.reply_to, "support@example.test");
      assert.deepEqual(frozen.attachments, [
        {
          filename: "signed.pdf",
          content_type: "application/pdf",
          content: "b3JpZ2luYWwgY29udGVudA==",
        },
      ]);
      assert.deepEqual((await audits()).rows, [
        {
          metadata: {
            messageId: "local-provider-id",
            signerId,
            recipient: message.to,
            template: message.template,
          },
        },
      ]);
      assert.deepEqual(await verifyAuditChain(envelopeId, database), {
        ok: true,
        chainedEvents: 1,
      });
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  },
);

test("deadline changes and replaced signing tokens cancel queued copies", async () => {
  await database.query(
    "UPDATE envelopes SET status = 'sent', expires_at = 200 WHERE id = $1",
    [envelopeId],
  );
  const notice = await enqueueEmail(
    {
      message: { ...message, template: "expiry_notice" },
      dedupeKey: dedupeKey(),
      envelopeId,
      userId,
      guard: { kind: "envelope_status", allowedStatuses: ["sent"] },
      acknowledgement: { kind: "expiry_notice", expiresAt: 100 },
    },
    { database, env, addresses },
  );
  await database.query(
    "UPDATE envelopes SET expires_at = floor(extract(epoch from clock_timestamp()))::bigint + 600 WHERE id = $1",
    [envelopeId],
  );
  const invite = await enqueueEmail(
    {
      message: { ...message, template: "signing_invitation" },
      dedupeKey: dedupeKey(),
      envelopeId,
      userId,
      guard: { kind: "signer_token", signerId, tokenHash },
    },
    { database, env, addresses },
  );
  await database.query(
    "UPDATE signers SET signing_token_hash = repeat('8', 64) WHERE id = $1",
    [signerId],
  );
  for (const { id } of [notice, invite]) {
    await runRecoveryJobs({
      database,
      env,
      jobId: id,
      emailService: sendNever,
    });
    const { rows } = await database.query(
      "SELECT state, payload_ciphertext FROM recovery_jobs WHERE id = $1",
      [id],
    );
    assert.deepEqual(rows, [{ state: "cancelled", payload_ciphertext: null }]);
  }
  await database.query(
    "UPDATE envelopes SET status = 'completed', expires_at = NULL WHERE id = $1",
    [envelopeId],
  );
});

test("a malformed provider result stays retryable and cannot start retention grace", async (t) => {
  const previous = (await readStoredSettings(database))?.retentionDays ?? null;
  t.after(() => saveSettings({ retentionDays: previous }, database));
  await saveSettings({ retentionDays: 60 }, database);
  await database.query(
    `UPDATE envelopes SET completed_at = floor(extract(epoch FROM clock_timestamp()))::bigint - 70 * 86400 WHERE id = $1`,
    [envelopeId],
  );
  const policy = await readRetentionPolicy(database);
  assert.ok(policy);
  const { id } = await enqueueEmail(
    {
      message: { ...message, template: "retention_notice" },
      dedupeKey: dedupeKey(),
      envelopeId,
      userId,
      acknowledgement: {
        kind: "retention_warning",
        policyGeneration: policy.generation,
      },
    },
    { database, env, addresses },
  );
  const warning = () =>
    database.query(
      "SELECT retention_warned_at AS warned FROM envelopes WHERE id = $1",
      [envelopeId],
    );
  const emailService: EmailService = {
    ...sendNever,
    send: async () => ({ accepted: [message.to], rejected: [] }),
  };
  await runRecoveryJobs({ database, env, jobId: id, emailService });
  assert.deepEqual((await warning()).rows, [{ warned: null }]);
  assert.deepEqual(
    (
      await database.query(
        "SELECT state, last_error_code FROM recovery_jobs WHERE id = $1",
        [id],
      )
    ).rows,
    [{ state: "pending", last_error_code: "provider_outcome_unknown" }],
  );
  await database.query(
    "UPDATE recovery_jobs SET available_at = clock_timestamp() WHERE id = $1",
    [id],
  );
  await runRecoveryJobs({
    database,
    env,
    jobId: id,
    emailService: {
      ...emailService,
      send: async () => ({
        accepted: [message.to],
        rejected: [],
        messageId: "confirmed-id",
      }),
    },
  });
  const now = await database.query(
    "SELECT floor(extract(epoch from clock_timestamp()))::bigint AS value",
  );
  assert.ok((await warning()).rows[0].warned >= now.rows[0].value - 1);
});

test(
  "an email associated with an uncommitted auth user waits for the account to become visible",
  { timeout: 5000 },
  async () => {
    const pendingUserId = `test-uncommitted-${randomUUID()}`;
    let id = "";
    try {
      await withTransaction(async (authTx) => {
        await authTx.query(
          'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
          [pendingUserId, "Auth fixture", `${pendingUserId}@example.test`],
        );
        ({ id } = await enqueueEmail(
          { message, dedupeKey: dedupeKey(), userId: pendingUserId },
          { database, env, addresses },
        ));
        await runRecoveryJobs({
          database,
          env,
          jobId: id,
          emailService: sendNever,
        });
        const withheld = await authTx.query(
          "SELECT state, last_error_code FROM recovery_jobs WHERE id = $1",
          [id],
        );
        assert.deepEqual(withheld.rows, [
          { state: "pending", last_error_code: "missing_parent" },
        ]);
      }, database);
      await database.query(
        "UPDATE recovery_jobs SET available_at = clock_timestamp() WHERE id = $1",
        [id],
      );
      await runRecoveryJobs({
        database,
        env,
        jobId: id,
        emailService: {
          ...sendNever,
          send: async () => ({
            accepted: [message.to],
            rejected: [],
            messageId: "auth-fixture-id",
          }),
        },
      });
      const delivered = await database.query(
        "SELECT state, payload_ciphertext FROM recovery_jobs WHERE id = $1",
        [id],
      );
      assert.deepEqual(delivered.rows, [
        { state: "succeeded", payload_ciphertext: null },
      ]);
    } finally {
      if (id)
        await database.query("DELETE FROM recovery_jobs WHERE id = $1", [id]);
      await database.query('DELETE FROM "user" WHERE id = $1', [pendingUserId]);
    }
  },
);

test(
  "the worker budget aborts an outstanding provider request and leaves it reclaimable",
  { timeout: 5000 },
  async () => {
    let requestArrived = false;
    let disconnected = false;
    const server = createServer((request, response) => {
      request.resume();
      requestArrived = true;
      response.on("close", () => {
        disconnected = true;
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = server.address();
    assert.ok(endpoint && typeof endpoint !== "string");
    const previousBaseUrl = process.env.RESEND_BASE_URL;
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${endpoint.port}`;
    try {
      const { id } = await enqueueEmail(
        { message, dedupeKey: dedupeKey(), userId },
        { database, env, addresses },
      );
      const result = await runRecoveryJobs({
        database,
        env: {
          ...env,
          EMAIL_DRIVER: "resend",
          RESEND_API_KEY: "re_local_fixture",
        },
        jobId: id,
        maxDurationMs: 600,
      });
      assert.deepEqual(result, {
        enabled: true,
        processed: 1,
        failed: 0,
        budgetExhausted: true,
      });
      const recorded = await database.query(
        "SELECT state, last_error_code FROM recovery_jobs WHERE id = $1",
        [id],
      );
      assert.deepEqual(recorded.rows, [
        { state: "running", last_error_code: null },
      ]);
      assert.equal(requestArrived, true);
      assert.equal(disconnected, true);
    } finally {
      if (previousBaseUrl === undefined) delete process.env.RESEND_BASE_URL;
      else process.env.RESEND_BASE_URL = previousBaseUrl;
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  },
);

test("a corrupt attachment snapshot cannot reach the provider", async () => {
  const { id } = await enqueueRecoveryJob(
    {
      kind: "email",
      dedupeKey: dedupeKey(),
      userId,
      payload: {
        addresses,
        message: {
          ...message,
          attachments: [
            {
              filename: "signed.pdf",
              contentType: "application/pdf",
              content: "!!invalid-base64!!",
            },
          ],
        },
      },
    },
    { database, env },
  );
  let requests = 0;
  await runRecoveryJobs({
    database,
    env,
    jobId: id,
    emailService: {
      ...sendNever,
      send: async () => {
        requests += 1;
        return { accepted: [message.to], rejected: [], messageId: "unwanted" };
      },
    },
  });
  assert.equal(requests, 0);
  const recorded = await database.query(
    "SELECT state, last_error_code FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.deepEqual(recorded.rows, [
    { state: "needs_attention", last_error_code: "payload_invalid" },
  ]);
});

test("the deadline stops a blocked acknowledgement and a replacement reuses the accepted provider key", async () => {
  const { id } = await enqueueEmail(
    {
      message,
      dedupeKey: dedupeKey(),
      userId,
      envelopeId,
      acknowledgement: { kind: "email_audit" },
    },
    { database, env, addresses },
  );
  const blocker = await database.connect();
  const auditCount = async () =>
    (
      await database.query(
        "SELECT id FROM audit_events WHERE envelope_id = $1 AND event = 'email_sent'",
        [envelopeId],
      )
    ).rowCount;
  const before = await auditCount();
  const requests: { message: TransactionalEmailMessage; key?: string }[] = [];
  const provider = "fixture-delivery-id";
  let run: ReturnType<typeof runRecoveryJobs> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM envelopes WHERE id = $1 FOR NO KEY UPDATE",
      [envelopeId],
    );
    run = runRecoveryJobs({
      database,
      env,
      jobId: id,
      maxDurationMs: 300,
      emailService: {
        ...sendNever,
        async send(frozen, options) {
          requests.push({ message: frozen, key: options?.idempotencyKey });
          return { accepted: [message.to], rejected: [], messageId: provider };
        },
      },
    });
    const stopped = await Promise.race([
      run,
      once(AbortSignal.timeout(1100), "abort").then(() =>
        assert.fail(
          "Worker remained blocked after its acknowledgement budget.",
        ),
      ),
    ]);
    assert.deepEqual(stopped, {
      enabled: true,
      processed: 1,
      failed: 0,
      budgetExhausted: true,
    });
    assert.equal(requests.length, 1);
    assert.equal(await auditCount(), before);
    assert.deepEqual(
      (
        await database.query("SELECT state FROM recovery_jobs WHERE id = $1", [
          id,
        ])
      ).rows,
      [{ state: "running" }],
    );
    await blocker.query("ROLLBACK");
    assert.equal(await auditCount(), before);
    await database.query(
      "UPDATE recovery_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [id],
    );
    await runRecoveryJobs({
      database,
      env,
      jobId: id,
      emailService: {
        ...sendNever,
        async send(frozen, options) {
          requests.push({ message: frozen, key: options?.idempotencyKey });
          return { accepted: [message.to], rejected: [], messageId: provider };
        },
      },
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(await auditCount(), (before ?? 0) + 1);
  } finally {
    await blocker.query("ROLLBACK");
    await run?.catch(() => undefined);
    blocker.release();
  }
});

test("a successful guard crossing the retry cutoff cannot reach the provider", async () => {
  const { id } = await enqueueEmail(
    {
      message,
      dedupeKey: dedupeKey(),
      envelopeId,
      userId,
      guard: { kind: "envelope_status", allowedStatuses: ["completed"] },
    },
    { database, env, addresses },
  );
  let guardReads = 0;
  const delayed = afterStatement(
    database,
    (sql, values) =>
      sql.includes(
        'retention_warning_policy_generation AS "warningGeneration"',
      ) && values[0] === envelopeId,
    async () => {
      guardReads += 1;
      await database.query(
        `UPDATE recovery_jobs SET first_attempt_at = clock_timestamp() - interval '23 hours' + interval '50 milliseconds'
          WHERE id = $1`,
        [id],
      );
      await database.query("SELECT pg_sleep(0.075)");
    },
  );
  let sends = 0;
  await runRecoveryJobs({
    database: delayed,
    env,
    jobId: id,
    emailService: {
      ...sendNever,
      async send(message) {
        sends += 1;
        return { accepted: [message.to], rejected: [], messageId: "fixture" };
      },
    },
  });

  assert.equal(guardReads, 1);
  assert.equal(sends, 0);
  const job = await database.query(
    "SELECT state, last_error_code FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.deepEqual(job.rows, [
    { state: "needs_attention", last_error_code: "retry_window_elapsed" },
  ]);
});
