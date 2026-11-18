import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { getDb, type DbPool } from "../../../../lib/db/connection.ts";
import { openTestDatabase } from "../../../../lib/db/test-database.ts";
import { enqueueEmail } from "../../../../lib/recovery/email.ts";
import { enqueueRecoveryJob } from "../../../../lib/recovery/jobs.ts";
import { GET, POST } from "./route.ts";

const cronSecret = "fixture-secret-for-cron";
const dedupePrefix = `recovery-route/${randomUUID()}/`;
const env = {
  BETTER_AUTH_SECRET: "fixture-auth-secret-only-for-recovery-route",
  CRON_SECRET: cronSecret,
  DURABLE_JOBS_ENABLED: "true",
  EMAIL_DRIVER: "capture",
};

let database: DbPool;
let directory: string;

function request(method: string) {
  return new Request("http://localhost/api/internal/recovery", {
    method,
    headers: { Authorization: `Bearer ${cronSecret}` },
    // Trigger callers do not control the queue query or the drain limits.
    ...(method === "POST"
      ? { body: JSON.stringify({ limit: 0, jobId: randomUUID() }) }
      : {}),
  });
}

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  assert.equal(getDb(), database);
  directory = await mkdtemp(path.join(tmpdir(), "signudoc-recovery-route-"));
  Object.assign(process.env, env, { EMAIL_CAPTURE_DIR: directory });
});

after(async () => {
  if (database) {
    await database.query("DELETE FROM recovery_jobs WHERE dedupe_key LIKE $1", [
      `${dedupePrefix}%`,
    ]);
    await database.end();
  }
  if (directory) await rm(directory, { force: true, recursive: true });
});

test("authenticated status is read-only and a bounded POST delivers the queued capture", async () => {
  const { id } = await enqueueEmail(
    {
      dedupeKey: `${dedupePrefix}delivery`,
      message: {
        to: "recipient@example.test",
        subject: "private-fixture-subject",
        textBody: "https://example.test/s/private-fixture-token",
        htmlBody: "<p>private-fixture-token</p>",
        template: "signing_invitation",
      },
    },
    {
      database,
      env,
      addresses: {
        senderAddress: "sender@example.test",
        supportAddress: "support@example.test",
      },
    },
  );

  const status = await GET(request("GET"));
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  const health = await status.json();
  assert.equal(health.status, "ready");
  assert.ok(health.health.counts.pending > 0);
  assert.deepEqual(await readdir(directory), []);

  const response = await POST(request("POST"));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(
    body,
    /private-fixture|recipient@example\.test|dedupe|payload|lease_token/,
  );
  const summary = JSON.parse(body);
  assert.equal(summary.status, "ran");
  assert.equal(summary.enabled, true);
  assert.equal(summary.failed, 0);
  assert.equal(summary.budgetExhausted, false);
  assert.ok(summary.processed >= 1 && summary.processed <= 20);
  const result = await database.query(
    "SELECT state, payload_ciphertext FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.deepEqual(result.rows, [
    { state: "succeeded", payload_ciphertext: null },
  ]);
  assert.equal((await readdir(directory)).length, 1);

  const idle = await POST(request("POST"));
  assert.equal(idle.status, 200);
  assert.equal((await idle.json()).processed, 0);
});

test("attention rejects an otherwise idle drain and status only exposes its allowlisted fields", async () => {
  const { id } = await enqueueRecoveryJob(
    {
      kind: "email",
      dedupeKey: `${dedupePrefix}attention`,
      payload: { message: "private-fixture-payload" },
    },
    { database, env },
  );
  try {
    await database.query(
      "UPDATE recovery_jobs SET state = 'needs_attention', last_error_code = $2, attempts = 12 WHERE id = $1",
      [id, "private-fixture-provider-error recipient@example.test"],
    );
    const response = await POST(request("POST"));
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.doesNotMatch(
      body,
      /private-fixture|recipient@example\.test|dedupe|payload/,
    );
    const summary = JSON.parse(body);
    assert.equal(summary.status, "ran");
    assert.equal(summary.processed, 0);
    assert.equal(summary.health.counts.needs_attention, 1);
    assert.deepEqual(summary.health.attention, [
      { id, kind: "email", code: "job_failed", attempts: 12 },
    ]);
    assert.equal(summary.health.pendingSigningLockAlerts, 0);

    const status = await GET(request("GET"));
    assert.equal(status.status, 200);
    assert.deepEqual((await status.json()).health, summary.health);
  } finally {
    await database.query("DELETE FROM recovery_jobs WHERE id = $1", [id]);
  }
});

test("status returns a sanitized 503 under PostgreSQL DDL contention", async () => {
  const blocking = await database.connect();
  try {
    await blocking.query("BEGIN");
    await blocking.query("LOCK TABLE recovery_jobs IN ACCESS EXCLUSIVE MODE");
    const start = performance.now();
    const response = await GET(request("GET"));
    assert.ok(performance.now() - start < 7_000);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "recovery_unavailable" });
  } finally {
    await blocking.query("ROLLBACK");
    blocking.release();
  }

  const unlocked = await GET(request("GET"));
  assert.equal(unlocked.status, 200);
});
