import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { Pool } from "pg";
import { after, before, test } from "node:test";

import { openTestDatabase } from "../db/test-database.ts";
import { type DbPool, withTransaction } from "../db/connection.ts";
import {
  cancelRecoveryJob,
  claimRecoveryJob,
  completeRecoveryJob,
  enqueueRecoveryJob,
  failRecoveryJob,
  getRecoveryQueueHealth,
  renewRecoveryLease,
} from "./jobs.ts";
import { runRecoveryJobs } from "./worker.ts";

let database: DbPool;
const env = {
  DURABLE_JOBS_ENABLED: "true",
  BETTER_AUTH_SECRET: "jobs-db-fixture-auth-secret-value",
  CRON_SECRET: "fixture",
};
const prefix = `queue-test/${randomUUID()}/`;
const input = (
  payload: unknown = { action: "https://example.test/s/private-fixture-token" },
) => ({
  kind: "email" as const,
  dedupeKey: `${prefix}${randomUUID()}`,
  payload,
});
const enqueue = (job: Parameters<typeof enqueueRecoveryJob>[0] = input()) =>
  enqueueRecoveryJob(job, { database, env });
const claim = (jobId: string) => claimRecoveryJob({ database, env, jobId });

before(async () => {
  database = await openTestDatabase();
});
after(async () => {
  if (database) {
    await database.query("DELETE FROM recovery_jobs WHERE dedupe_key LIKE $1", [
      `${prefix}%`,
    ]);
    await database.end();
  }
});

test("enqueue participates in its caller's rollback", async () => {
  const job = input();
  await assert.rejects(
    withTransaction(async (tx) => {
      await enqueueRecoveryJob(job, { database: tx, env });
      throw new Error("rollback fixture");
    }, database),
    /rollback fixture/,
  );
  const inserted = await database.query(
    "SELECT id FROM recovery_jobs WHERE dedupe_key = $1",
    [job.dedupeKey],
  );
  assert.equal(inserted.rowCount, 0);
});

test("canonical duplicate payloads reuse one row, even after the encrypted payload is cleared", async () => {
  const pending = input({ action: "private-fixture-token", other: [null, 3] });
  const { id } = await enqueue(pending);
  const equivalent = {
    ...pending,
    payload: { other: [null, 3], action: "private-fixture-token" },
  };
  assert.deepEqual(await enqueue(equivalent), { id, created: false });
  await assert.rejects(
    enqueue({ ...pending, payload: { action: "stale-replacement-token" } }),
    /dedupe/i,
  );
  const before = await database.query(
    "SELECT row_to_json(job) AS row FROM recovery_jobs job WHERE id = $1",
    [id],
  );
  assert.ok(!JSON.stringify(before.rows[0]).includes("private-fixture-token"));
  const owned = await claim(id);
  assert.ok(owned);
  assert.deepEqual(owned.payload, pending.payload);
  assert.equal(await completeRecoveryJob(owned, { database }), true);
  const after = await database.query(
    "SELECT state, payload_ciphertext FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.deepEqual(after.rows, [
    { state: "succeeded", payload_ciphertext: null },
  ]);
  assert.deepEqual(await enqueue(equivalent), { id, created: false });
  await assert.rejects(
    enqueue({ ...pending, payload: "different" }),
    /dedupe/i,
  );
});

test("a renewed lease prevents another owner and reclaimed work fences the old callback", async () => {
  const { id } = await enqueue();
  const claims = await Promise.all([claim(id), claim(id)]);
  const first = claims.find(Boolean);
  assert.ok(first);
  assert.equal(claims.filter(Boolean).length, 1);
  await database.query(
    "UPDATE recovery_jobs SET lease_expires_at = clock_timestamp() + interval '1 second' WHERE id = $1",
    [id],
  );
  assert.equal(await renewRecoveryLease(first, { database }), true);
  const renewed = await database.query(
    "SELECT lease_expires_at > clock_timestamp() + interval '110 seconds' AS renewed FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.equal(renewed.rows[0].renewed, true);
  assert.equal(await claim(id), null);
  await database.query(
    "UPDATE recovery_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [id],
  );
  assert.equal(await renewRecoveryLease(first, { database }), false);
  const second = await claim(id);
  assert.ok(second);
  assert.notEqual(first.leaseToken, second.leaseToken);
  assert.equal(second.attempts, 2);
  assert.equal(
    await failRecoveryJob(first, { database, code: "unknown_outcome" }),
    false,
  );
  assert.equal(await cancelRecoveryJob(first, { database }), false);
  assert.equal(
    await completeRecoveryJob(first, {
      database,
      onCommit: async () => {
        assert.fail("stale callback ran");
      },
    }),
    false,
  );
  await assert.rejects(
    completeRecoveryJob(second, {
      database,
      onCommit: async (tx) => {
        await tx.query(
          "UPDATE recovery_jobs SET last_error_code = 'temporary' WHERE id = $1",
          [id],
        );
        throw new Error("ack failed");
      },
    }),
    /ack failed/,
  );
  const unchanged = await database.query(
    "SELECT state, last_error_code FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.deepEqual(unchanged.rows, [
    { state: "running", last_error_code: null },
  ]);
  assert.equal(await completeRecoveryJob(second, { database }), true);
});

test("retry delays start at 30 seconds and cap at one hour", async () => {
  const { id } = await enqueue();
  for (const [previousAttempts, minimumSeconds, maximumSeconds] of [
    [0, 29, 30],
    [1, 59, 60],
    [9, 3599, 3600],
  ]) {
    await database.query(
      "UPDATE recovery_jobs SET attempts = $2, available_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [id, previousAttempts],
    );
    const owned = await claim(id);
    assert.ok(owned);
    assert.equal(
      await failRecoveryJob(owned, { database, code: "unknown_outcome" }),
      true,
    );
    assert.equal(await claim(id), null);
    const delayed = await database.query(
      "SELECT extract(epoch from available_at - clock_timestamp())::float AS seconds FROM recovery_jobs WHERE id = $1",
      [id],
    );
    assert.ok(
      delayed.rows[0].seconds <= maximumSeconds &&
        delayed.rows[0].seconds > minimumSeconds,
    );
  }
});

test("expired, exhausted, and out-of-window jobs never reach the handler", async () => {
  const expiredJob = { ...input(), expiresAt: 1 };
  const expired = await enqueue(expiredJob);
  const exhausted = await enqueue();
  const old = await enqueue();
  await database.query("UPDATE recovery_jobs SET attempts = 12 WHERE id = $1", [
    exhausted.id,
  ]);
  await database.query(
    "UPDATE recovery_jobs SET first_attempt_at = clock_timestamp() - interval '23 hours' WHERE id = $1",
    [old.id],
  );
  for (const jobId of [expired.id, exhausted.id, old.id]) {
    await runRecoveryJobs({
      database,
      env,
      jobId,
      handlers: { email: async () => assert.fail("job reached transport") },
    });
  }
  const { rows } = await database.query(
    "SELECT id, state, last_error_code, payload_ciphertext IS NULL AS cleared FROM recovery_jobs WHERE id = ANY($1)",
    [[expired.id, exhausted.id, old.id]],
  );
  const states = new Map(rows.map(({ id, ...row }) => [id, row]));
  assert.deepEqual(states.get(expired.id), {
    state: "cancelled",
    last_error_code: "expired",
    cleared: true,
  });
  assert.deepEqual(states.get(exhausted.id), {
    state: "needs_attention",
    last_error_code: "attempts_exhausted",
    cleared: false,
  });
  assert.deepEqual(states.get(old.id), {
    state: "needs_attention",
    last_error_code: "retry_window_elapsed",
    cleared: false,
  });
  assert.deepEqual(await enqueue(expiredJob), {
    id: expired.id,
    created: false,
  });
  const health = await getRecoveryQueueHealth({ database });
  assert.ok(health.attention.some((job) => job.id === old.id));
  assert.ok(!JSON.stringify(health).includes("private-fixture-token"));
});

test("wrong keys and ciphertext modifications quarantine the job without exposing plaintext", async () => {
  const wrongKey = await enqueue();
  const tampered = await enqueue();
  await database.query(
    "UPDATE recovery_jobs SET payload_ciphertext = set_byte(payload_ciphertext, 0, get_byte(payload_ciphertext,0) # 1) WHERE id = $1",
    [tampered.id],
  );
  for (const [id, workerEnv] of [
    [
      wrongKey.id,
      { ...env, BETTER_AUTH_SECRET: "fixture-different-auth-secret-value" },
    ],
    [tampered.id, env],
  ] as const) {
    const summary = await runRecoveryJobs({
      database,
      env: workerEnv,
      jobId: id,
      handlers: {
        email: async () => assert.fail("corrupt payload reached transport"),
      },
    });
    assert.equal(summary.processed, 0);
    const current = await database.query(
      "SELECT state, last_error_code FROM recovery_jobs WHERE id = $1",
      [id],
    );
    assert.deepEqual(current.rows, [
      { state: "needs_attention", last_error_code: "payload_unreadable" },
    ]);
  }
});

test("an unsupported finalization job waits for a worker with that handler", async () => {
  const { id } = await enqueueRecoveryJob(
    { ...input(), kind: "finalize_envelope" },
    { database, env },
  );
  assert.equal(
    (await runRecoveryJobs({ database, env, jobId: id })).processed,
    0,
  );
  const waiting = await database.query(
    "SELECT state, attempts FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.deepEqual(waiting.rows, [{ state: "pending", attempts: 0 }]);
});

test("link expiry clears a pending payload even while retry backoff is in effect", async () => {
  const { id } = await enqueue({ ...input(), expiresAt: 1 });
  await database.query(
    "UPDATE recovery_jobs SET available_at = clock_timestamp() + interval '1 hour' WHERE id = $1",
    [id],
  );
  assert.equal(await claim(id), null);
  const cleared = await database.query(
    "SELECT state, payload_ciphertext IS NULL AS cleared FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.deepEqual(cleared.rows, [{ state: "cancelled", cleared: true }]);
});

async function waitForBlockedQuery(filter: string, pid?: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocked = await database.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE $1 AND ($2::int IS NULL OR pid = $2)`,
      [`%${filter}%`, pid ?? null],
    );
    if (blocked.rowCount) return;
    await delay(5);
  }
  assert.fail("The recovery statement never waited on the fixture lock.");
}

for (const [name, mutate] of [
  ["renewal", renewRecoveryLease],
  ["cancellation", cancelRecoveryJob],
] as const) {
  test(`a blocked ${name} rechecks the fence after the lock releases`, async () => {
    const { id } = await enqueue();
    const owner = await claim(id);
    assert.ok(owner);
    const blocker = await database.connect();
    const writer = await database.connect();
    let pending: Promise<boolean> | undefined;
    try {
      const {
        rows: [{ pid }],
      } = await writer.query("SELECT pg_backend_pid() AS pid");
      await database.query(
        "UPDATE recovery_jobs SET lease_expires_at = clock_timestamp() + interval '800 milliseconds' WHERE id = $1",
        [id],
      );
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM recovery_jobs WHERE id = $1 FOR UPDATE",
        [id],
      );
      pending = mutate(owner, { database: writer });
      await waitForBlockedQuery("recovery_jobs", pid);
      await blocker.query(
        `SELECT pg_sleep(GREATEST(0, extract(epoch FROM lease_expires_at - clock_timestamp())) + 0.04)
          FROM recovery_jobs WHERE id = $1`,
        [id],
      );
      await blocker.query("ROLLBACK");
      assert.equal(await pending, false);
      const retained = await database.query(
        "SELECT state, lease_token, payload_ciphertext IS NOT NULL AS retained FROM recovery_jobs WHERE id = $1",
        [id],
      );
      assert.deepEqual(retained.rows, [
        { state: "running", lease_token: owner.leaseToken, retained: true },
      ]);
      const replacement = await claim(id);
      assert.ok(replacement);
      assert.notEqual(replacement.leaseToken, owner.leaseToken);
    } finally {
      await blocker.query("ROLLBACK");
      await pending?.catch(() => undefined);
      blocker.release();
      writer.release();
    }
  });
}

test("a quarantined credential is cleared when it expires and keeps its dedupe tombstone", async () => {
  const {
    rows: [{ expiresAt }],
  } = await database.query(
    'SELECT floor(extract(epoch FROM clock_timestamp()))::bigint + 2 AS "expiresAt"',
  );
  const credential = { ...input(), expiresAt };
  const { id } = await enqueue(credential);
  const owner = await claim(id);
  assert.ok(owner);
  assert.equal(
    await failRecoveryJob(owner, {
      database,
      code: "payload_invalid",
      permanent: true,
    }),
    true,
  );
  assert.equal(await claim(id), null);
  const state = () =>
    database.query(
      "SELECT state, payload_ciphertext IS NULL AS cleared, last_error_code FROM recovery_jobs WHERE id = $1",
      [id],
    );
  assert.deepEqual((await state()).rows, [
    {
      state: "needs_attention",
      cleared: false,
      last_error_code: "payload_invalid",
    },
  ]);
  await database.query(
    "SELECT pg_sleep(GREATEST(0, $1 - extract(epoch FROM clock_timestamp())) + 0.04)",
    [expiresAt],
  );
  assert.equal(await claim(id), null);
  assert.deepEqual((await state()).rows, [
    { state: "cancelled", cleared: true, last_error_code: "expired" },
  ]);
  assert.deepEqual(await enqueue(credential), { id, created: false });
});

async function finishWithinTestWindow<T>(run: Promise<T>): Promise<T> {
  return Promise.race([
    run,
    once(AbortSignal.timeout(1100), "abort").then(() =>
      assert.fail(
        "Recovery ran after its deadline while the DB lock was held.",
      ),
    ),
  ]);
}

test("the worker deadline cancels a claim blocked by a table lock", async () => {
  const { id } = await enqueue();
  const blocker = await database.connect();
  let run: ReturnType<typeof runRecoveryJobs> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE recovery_jobs IN ACCESS EXCLUSIVE MODE");
    run = runRecoveryJobs({
      database,
      env,
      jobId: id,
      maxDurationMs: 300,
      handlers: {
        email: async () => assert.fail("a blocked claim reached its handler"),
      },
    });
    await waitForBlockedQuery("discarded AS");
    assert.deepEqual(await finishWithinTestWindow(run), {
      enabled: true,
      processed: 0,
      failed: 0,
      budgetExhausted: true,
    });
  } finally {
    await blocker.query("ROLLBACK");
    await run?.catch(() => undefined);
    blocker.release();
  }
  const pending = await database.query(
    "SELECT state, attempts FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.deepEqual(pending.rows, [{ state: "pending", attempts: 0 }]);
});

test("the worker deadline bounds blocked failure recording and heartbeat cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { id } = await enqueue();
  const blocker = await database.connect();
  let run: ReturnType<typeof runRecoveryJobs> | undefined;
  let allowFailure: () => void = () => {};
  const handlerEntered = Promise.withResolvers();
  try {
    await blocker.query("BEGIN");
    const canFail = new Promise<void>((resolve) => {
      allowFailure = resolve;
    });
    run = runRecoveryJobs({
      database,
      env,
      jobId: id,
      maxDurationMs: 600,
      handlers: {
        email: async () => {
          await blocker.query(
            "SELECT id FROM recovery_jobs WHERE id = $1 FOR UPDATE",
            [id],
          );
          handlerEntered.resolve(undefined);
          await canFail;
          throw new Error("synthetic handler failure");
        },
      },
    });
    await handlerEntered.promise;
    const lease = () =>
      database.query(
        "SELECT state, lease_expires_at, last_error_code FROM recovery_jobs WHERE id = $1",
        [id],
      );
    const before = (await lease()).rows;
    t.mock.timers.tick(30_000);
    await waitForBlockedQuery("lease_expires_at = clock_timestamp()");
    allowFailure();
    await waitForBlockedQuery("next_state");
    assert.deepEqual(await finishWithinTestWindow(run), {
      enabled: true,
      processed: 1,
      failed: 0,
      budgetExhausted: true,
    });
    assert.deepEqual((await lease()).rows, before);
    await blocker.query("ROLLBACK");
    assert.deepEqual((await lease()).rows, before);
  } finally {
    allowFailure();
    await blocker.query("ROLLBACK");
    await run?.catch(() => undefined);
    blocker.release();
  }
});

test("a worker that times out waiting for a pool checkout never claims later", async () => {
  const { id } = await enqueue();
  const limited = new Pool({ ...database.options, max: 1 });
  const occupied = await limited.connect();
  let run: ReturnType<typeof runRecoveryJobs> | undefined;
  try {
    run = runRecoveryJobs({
      database: limited,
      env,
      jobId: id,
      maxDurationMs: 120,
      handlers: {
        email: async () =>
          assert.fail("pool checkout after deadline reached a handler"),
      },
    });
    assert.deepEqual(await finishWithinTestWindow(run), {
      enabled: true,
      processed: 0,
      failed: 0,
      budgetExhausted: true,
    });
  } finally {
    occupied.release();
    await run?.catch(() => undefined);
    await limited.end();
  }
  const pending = await database.query(
    "SELECT state, attempts FROM recovery_jobs WHERE id = $1",
    [id],
  );
  assert.deepEqual(pending.rows, [{ state: "pending", attempts: 0 }]);
});
