import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { PDFDocument } from "pdf-lib";

import { afterStatement, openTestDatabase } from "../db/test-database.ts";
import type { DbPool } from "../db/connection.ts";
import {
  runRetentionSweep,
  queueFileDeletions,
  deletePendingFile,
  listEnvelopeStorageKeys,
} from "../retention.ts";
import { verifyAuditChain } from "../services/audit.ts";
import { readCms } from "../services/pdf-ltv.ts";
import { sha256Hex } from "../services/pdf-seal.ts";
import { findSignatures } from "../services/pdf-incremental.ts";
import {
  createStorageService,
  type StorageService,
} from "../services/storage.ts";
import { getRecipientCertificateKey } from "../services/storage-keys.ts";
import { issueSigningLink } from "../services/signing-links.ts";
import { submitSigningForToken } from "../signing.ts";
import { claimRecoveryJob } from "./jobs.ts";
import { runRecoveryJobs } from "./worker.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nc9sAAAAASUVORK5CYII=";
let database: DbPool;
let storage: StorageService;
let directory: string;
const users: string[] = [];
const keys = new Set<string>();
before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  directory = await mkdtemp(path.join(tmpdir(), "signudoc-finalization-"));
  Object.assign(process.env, {
    APP_URL: "https://sign.example.test",
    BETTER_AUTH_SECRET: "fixture-secret-for-durable-workflow",
    CRON_SECRET: "fixture-cron",
    DURABLE_JOBS_ENABLED: "true",
    EMAIL_DRIVER: "capture",
    EMAIL_CAPTURE_DIR: path.join(directory, "outbox"),
    STORAGE_LOCAL_DIR: directory,
    STORAGE_DRIVER: process.env.S3_INTEGRATION_TEST === "1" ? "s3" : "local",
  });
  delete process.env.SEAL_TIMESTAMP_URL;
  storage = createStorageService();
});
after(async () => {
  await database.query('DELETE FROM "user" WHERE id=ANY($1)', [users]);
  for (const key of keys) await storage.deleteObject(key);
  await database.query(
    "DELETE FROM pending_file_deletions WHERE storage_key=ANY($1)",
    [[...keys]],
  );
  await database.end();
  await rm(directory, { force: true, recursive: true });
});

async function fixture(sourceStorage = storage) {
  const [user, account, envelope, signer, field] = Array.from(
    { length: 5 },
    () => randomUUID(),
  );
  users.push(user, account);
  const email = account + "@example.test";
  const source = await PDFDocument.create();
  source.addPage();
  const body = await source.save();
  const key = "recovery-fixtures/" + envelope + "/original.pdf";
  keys.add(key);
  await sourceStorage.putObject({ key, body, contentType: "application/pdf" });
  const link = await issueSigningLink({ expiresInSeconds: 3600 });
  await database.query(
    `INSERT INTO "user"(id,name,email,"emailVerified",identity_verified_at) VALUES($1,'Owner',$1||'@example.test',true,1),($2,'Signing Person',$3,true,1)`,
    [user, account, email],
  );
  await database.query(
    `INSERT INTO account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES($1,$2,'credential',$2,'fixture-hash',now(),now())`,
    [randomUUID(), account],
  );
  await database.query(
    `INSERT INTO envelopes(id,user_id,title,status,source_pdf_key,source_pdf_filename,source_pdf_size_bytes,page_count,source_pdf_hash,part11)
    VALUES($1,$2,'Audit record','sent',$3,'source.pdf',$4,1,$5,true)`,
    [envelope, user, key, body.length, sha256Hex(body)],
  );
  await database.query(
    `INSERT INTO signers(id,envelope_id,user_id,name,email,sign_order,status,signing_token_hash,signing_token_expires_at,consented_at,signature_meaning)
    VALUES($1,$2,$3,'Signing Person',$4,1,'notified',$5,$6,1,'approval')`,
    [signer, envelope, account, email, link.tokenHash, link.exp],
  );
  await database.query(
    `INSERT INTO fields(id,envelope_id,signer_id,type,page,x,y,width,height) VALUES($1,$2,$3,'signature',1,0.1,0.1,0.2,0.08)`,
    [field, envelope, signer],
  );
  return {
    userId: user,
    envelopeId: envelope,
    signer,
    sourceKey: key,
    email,
    token: link.token,
    submission: {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          type: "signature",
          fieldId: field,
          inputMethod: "drawn",
          imageDataUrl: "data:image/png;base64," + png,
        },
      ],
      reauthentication: {
        email,
        password: "fixture-signature-password",
        meaningConfirmed: true,
      },
    },
  };
}
async function pausedProcess(
  t: TestContext,
  input: {
    phase: string;
    envelopeId: string;
    jobId?: string;
    token?: string;
    submission?: unknown;
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  const child = fork(
    new URL("./fixtures/finalization-process.ts", import.meta.url),
    [],
    {
      execArgv: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"],
      env: { ...env, DATABASE_URL: process.env.E2E_DATABASE_URL },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let errors = "";
  child.stderr?.on("data", (chunk) => (errors += String(chunk)));
  const exited = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  const paused = once(child, "message", {
    signal: AbortSignal.timeout(20_000),
  });
  child.send(input);
  const result = await Promise.race([paused, exited]);
  assert.equal(result[0], input.phase, errors);
  return {
    async kill() {
      child.kill("SIGKILL");
      assert.deepEqual(await exited, [null, "SIGKILL"]);
    },
    async resume() {
      child.send("resume");
      assert.deepEqual(await exited, [0, null], errors);
    },
  };
}
async function expire(jobId: string) {
  await database.query(
    "UPDATE recovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND state='running'",
    [jobId],
  );
}
async function auditText(bytes: Uint8Array) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({
    data: bytes.slice(),
    verbosity: 0,
    useSystemFonts: false,
  }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(
      content.items.map((item: { str?: string }) => item.str ?? "").join(" "),
    );
  }
  await pdf.destroy();
  return pages.join(" ");
}

test("SIGKILL after acceptance, partial and full uploads, and publication preserves one Part 11 signature", async (t) => {
  const f = await fixture();
  await assert.rejects(
    submitSigningForToken(f.token, f.submission, {
      database,
      verifiedMethods: ["account"],
      verifyPassword: async () => false,
    }),
    /password/i,
  );
  assert.equal(
    (
      await database.query(
        "SELECT id FROM recovery_jobs WHERE envelope_id=$1",
        [f.envelopeId],
      )
    ).rowCount,
    0,
  );
  const acceptance = await pausedProcess(t, { phase: "accept", ...f });
  await acceptance.kill();
  const signed = await database.query(
    "SELECT s.status,s.signing_token_hash,f.image_key FROM signers s JOIN fields f ON f.signer_id=s.id WHERE s.id=$1",
    [f.signer],
  );
  assert.equal(signed.rows[0].status, "signed");
  assert.equal(signed.rows[0].signing_token_hash, null);
  keys.add(signed.rows[0].image_key);
  const jobId = (
    await database.query("SELECT id FROM recovery_jobs WHERE envelope_id=$1", [
      f.envelopeId,
    ])
  ).rows[0].id;
  const claim = await claimRecoveryJob({ database, jobId });
  assert.ok(claim);
  assert.ok(
    !JSON.stringify(claim.payload).includes(
      f.submission.reauthentication.password,
    ),
  );
  await expire(jobId);
  const abandoned: string[] = [];
  const sealCertificates = new Set<string>();
  for (const writes of [1, 3]) {
    const child = await pausedProcess(t, {
      phase: "put" + writes,
      envelopeId: f.envelopeId,
      jobId,
    });
    const attempt = (
      await database.query(
        "SELECT storage_keys FROM finalization_attempts WHERE job_id=$1",
        [jobId],
      )
    ).rows[0].storage_keys as string[];
    assert.equal(attempt.length, 3);
    for (const key of attempt) keys.add(key);
    abandoned.push(...attempt);
    const exists = await Promise.all(
      attempt.map(async (key) => (await storage.headObject(key)).exists),
    );
    assert.equal(exists.filter(Boolean).length, writes);
    const partialPdf = (await storage.getObject(attempt[0])).body;
    sealCertificates.add(
      sha256Hex(
        readCms(findSignatures(partialPdf)[0].contents).certificates[0],
      ),
    );
    assert.equal(
      (
        await database.query(
          "SELECT signed_pdf_key FROM envelopes WHERE id=$1",
          [f.envelopeId],
        )
      ).rows[0].signed_pdf_key,
      null,
    );
    await queueFileDeletions(f.envelopeId, [attempt[0]], 1, database);
    assert.equal(await deletePendingFile(attempt[0], database, storage), false);
    assert.equal((await storage.headObject(attempt[0])).exists, true);
    await child.kill();
    await expire(jobId);
  }
  const stale = await pausedProcess(t, {
    phase: "stale",
    envelopeId: f.envelopeId,
    jobId,
  });
  const staleKeys = (
    await database.query(
      "SELECT storage_keys FROM finalization_attempts WHERE job_id=$1",
      [jobId],
    )
  ).rows[0].storage_keys;
  abandoned.push(...staleKeys);
  await expire(jobId);
  const publisher = await pausedProcess(t, {
    phase: "published",
    envelopeId: f.envelopeId,
    jobId,
  });
  await publisher.kill();
  await stale.resume();
  assert.equal((await runRecoveryJobs({ database, jobId })).processed, 0);
  const final = (
    await database.query(
      `SELECT status,finalization_pending,signed_pdf_key,evidence_key,signed_pdf_sha256,evidence_sha256,recipient_evidence_sha256 FROM envelopes WHERE id=$1`,
      [f.envelopeId],
    )
  ).rows[0];
  assert.equal(final.status, "completed");
  assert.equal(final.finalization_pending, false);
  const winners = [
    final.signed_pdf_key,
    final.evidence_key,
    getRecipientCertificateKey(final.evidence_key),
  ];
  const queued = await database.query(
    "SELECT storage_key FROM pending_file_deletions WHERE envelope_id=$1",
    [f.envelopeId],
  );
  assert.deepEqual(
    queued.rows.map((row) => row.storage_key).sort(),
    abandoned.sort(),
  );
  for (const key of abandoned) {
    assert.ok(!winners.includes(key));
    await deletePendingFile(key, database, storage);
    assert.equal((await storage.headObject(key)).exists, false);
  }
  // An accidentally queued live sibling must survive a cleanup, including
  // the redacted certificate that is reached through its internal sibling.
  await queueFileDeletions(f.envelopeId, winners, 1, database);
  for (const key of winners)
    assert.equal(await deletePendingFile(key, database, storage), false);
  const bodies = [];
  const deletable = await listEnvelopeStorageKeys(f.envelopeId, database);
  for (const key of winners) {
    keys.add(key);
    assert.ok(deletable.includes(key));
    const { body } = await storage.getObject(key);
    assert.equal(findSignatures(body).length, 1);
    sealCertificates.add(
      sha256Hex(readCms(findSignatures(body)[0].contents).certificates[0]),
    );
    bodies.push(body);
  }
  assert.equal(
    sealCertificates.size,
    1,
    "the install seal identity survives each worker restart",
  );
  assert.deepEqual(bodies.map(sha256Hex), [
    final.signed_pdf_sha256,
    final.evidence_sha256,
    final.recipient_evidence_sha256,
  ]);
  assert.match(await auditText(bodies[1]), /192\.0\.2\.12/);
  const redacted = await auditText(bodies[2]);
  assert.doesNotMatch(redacted, /192\.0\.2\.12|finalization-fixture-agent/);
  assert.ok(!redacted.includes(f.email));
  assert.match(redacted, /Signing Person/);
  assert.equal((await verifyAuditChain(f.envelopeId, database)).ok, true);
  const events = await database.query(
    "SELECT event,metadata FROM audit_events WHERE envelope_id=$1 AND event IN ('signed','completed') ORDER BY sequence",
    [f.envelopeId],
  );
  assert.deepEqual(
    events.rows.map((row) => row.event),
    ["signed", "completed"],
  );
  assert.equal(events.rows[0].metadata.part11.meaning, "approval");
  assert.equal(events.rows[0].metadata.part11.credential, "account_password");
  const mail = await database.query(
    "SELECT id,dedupe_key FROM recovery_jobs WHERE kind='email' AND envelope_id=$1",
    [f.envelopeId],
  );
  assert.deepEqual(mail.rows.map((row) => row.dedupe_key).sort(), [
    "completion/" + f.envelopeId + "/sender",
    "completion/" + f.envelopeId + "/signer/" + f.signer,
  ]);
  for (const row of mail.rows)
    assert.equal(
      (await runRecoveryJobs({ database, jobId: row.id })).failed,
      0,
    );
  assert.equal(
    (
      await database.query(
        "SELECT id FROM audit_events WHERE envelope_id=$1 AND event='email_sent'",
        [f.envelopeId],
      )
    ).rowCount,
    2,
  );
});

test("invalid drawn data leaves the signer's link and acceptance transaction available", async () => {
  const f = await fixture();
  f.submission.fields[0].imageDataUrl = "data:image/png;base64,aW52YWxpZA==";
  await assert.rejects(
    submitSigningForToken(f.token, f.submission, {
      database,
      verifiedMethods: ["account"],
      verifyPassword: async () => true,
    }),
    /PNG/,
  );
  assert.equal(
    (await database.query("SELECT status FROM signers WHERE id=$1", [f.signer]))
      .rows[0].status,
    "notified",
  );
  assert.equal(
    (
      await database.query(
        "SELECT id FROM recovery_jobs WHERE envelope_id=$1",
        [f.envelopeId],
      )
    ).rowCount,
    0,
  );
});

for (const changed of ["original", "image"]) {
  test(`changed ${changed} cannot publish an accepted signature`, async () => {
    const f = await fixture();
    await submitSigningForToken(f.token, f.submission, {
      database,
      verifiedMethods: ["account"],
      verifyPassword: async () => true,
    });
    const image = (
      await database.query("SELECT image_key FROM fields WHERE signer_id=$1", [
        f.signer,
      ])
    ).rows[0].image_key;
    keys.add(image);
    const key = changed === "original" ? f.sourceKey : image;
    await storage.putObject({
      key,
      body: Uint8Array.of(1),
      contentType: "application/octet-stream",
    });
    const id = (
      await database.query(
        "SELECT id FROM recovery_jobs WHERE envelope_id=$1",
        [f.envelopeId],
      )
    ).rows[0].id;
    assert.equal((await runRecoveryJobs({ database, jobId: id })).failed, 1);
    const state = (
      await database.query(
        "SELECT state,last_error_code FROM recovery_jobs WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.deepEqual(state, {
      state: "needs_attention",
      last_error_code: "finalization_artifact_mismatch",
    });
    assert.equal(
      (
        await database.query(
          "SELECT count(*) FROM audit_events WHERE envelope_id=$1 AND event='completed'",
          [f.envelopeId],
        )
      ).rows[0].count,
      0,
    );
    const abandoned = await database.query(
      "SELECT storage_key FROM pending_file_deletions WHERE envelope_id=$1",
      [f.envelopeId],
    );
    for (const row of abandoned.rows) keys.add(row.storage_key);
  });
}

test("ambiguous acceptance keeps the bound drawn image and a publication rollback keeps only accepted state", async () => {
  const f = await fixture();
  let enqueued = false;
  const lostAck = afterStatement(
    database,
    (sql) => {
      if (sql.includes("INSERT INTO recovery_jobs")) enqueued = true;
      return enqueued && sql === "COMMIT";
    },
    async () => {
      enqueued = false;
      throw new Error("lost acceptance acknowledgement");
    },
  );
  await assert.rejects(
    submitSigningForToken(f.token, f.submission, {
      database: lostAck,
      verifiedMethods: ["account"],
      verifyPassword: async () => true,
    }),
    /lost acceptance acknowledgement/,
  );
  const image = (
    await database.query("SELECT image_key FROM fields WHERE signer_id=$1", [
      f.signer,
    ])
  ).rows[0].image_key;
  keys.add(image);
  assert.ok((await storage.headObject(image)).exists);
  const jobId = (
    await database.query("SELECT id FROM recovery_jobs WHERE envelope_id=$1", [
      f.envelopeId,
    ])
  ).rows[0].id;
  const rollback = afterStatement(
    database,
    (sql) => sql.includes("INSERT INTO recovery_jobs"),
    async () => {
      throw new Error("completion enqueue unavailable");
    },
  );
  assert.equal(
    (await runRecoveryJobs({ database: rollback, jobId })).failed,
    1,
  );
  const current = await database.query(
    `SELECT e.status,e.finalization_pending,e.signed_pdf_key,j.state,
    (SELECT count(*) FROM recipient_download_tokens WHERE envelope_id=e.id) AS links,
    (SELECT count(*) FROM audit_events WHERE envelope_id=e.id AND event='completed') AS completed
    FROM envelopes e JOIN recovery_jobs j ON j.envelope_id=e.id WHERE e.id=$1`,
    [f.envelopeId],
  );
  assert.deepEqual(current.rows, [
    {
      status: "sent",
      finalization_pending: true,
      signed_pdf_key: null,
      state: "pending",
      links: 0,
      completed: 0,
    },
  ]);
  const abandoned = await database.query(
    "SELECT storage_key FROM pending_file_deletions WHERE envelope_id=$1",
    [f.envelopeId],
  );
  assert.equal(abandoned.rowCount, 3);
  for (const row of abandoned.rows) keys.add(row.storage_key);
  await database.query(
    "UPDATE recovery_jobs SET available_at=clock_timestamp() WHERE id=$1",
    [jobId],
  );
  assert.equal((await runRecoveryJobs({ database, jobId })).failed, 0);
  for (const key of await listEnvelopeStorageKeys(f.envelopeId, database))
    keys.add(key);
});

test("hosted account purge queues an interrupted attempt before discarding its manifest", async (t) => {
  const f = await fixture();
  await submitSigningForToken(f.token, f.submission, {
    database,
    verifiedMethods: ["account"],
    verifyPassword: async () => true,
  });
  const jobId = (
    await database.query("SELECT id FROM recovery_jobs WHERE envelope_id=$1", [
      f.envelopeId,
    ])
  ).rows[0].id;
  const child = await pausedProcess(t, {
    phase: "put1",
    envelopeId: f.envelopeId,
    jobId,
  });
  const attempt = (
    await database.query(
      "SELECT storage_keys FROM finalization_attempts WHERE job_id=$1",
      [jobId],
    )
  ).rows[0].storage_keys as string[];
  assert.ok((await storage.headObject(attempt[0])).exists);
  for (const key of attempt) keys.add(key);
  await child.kill();
  await database.query(
    "INSERT INTO account_closure_requests(user_id,requested_at,export_expires_at,purge_after_at,updated_at) VALUES($1,1,1,1,1)",
    [f.userId],
  );
  const previous = process.env.HOSTED_MODE;
  process.env.HOSTED_MODE = "true";
  try {
    const result = await runRetentionSweep({
      database,
      storageService: storage,
    });
    assert.ok(!result.accountPurgeFailures.includes(f.userId));
  } finally {
    if (previous === undefined) delete process.env.HOSTED_MODE;
    else process.env.HOSTED_MODE = previous;
  }
  assert.equal(
    (
      await database.query("SELECT id FROM envelopes WHERE id=$1", [
        f.envelopeId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await database.query(
        "SELECT job_id FROM finalization_attempts WHERE job_id=$1",
        [jobId],
      )
    ).rowCount,
    0,
  );
  const queued = await database.query(
    "SELECT storage_key FROM pending_file_deletions WHERE envelope_id=$1",
    [f.envelopeId],
  );
  assert.deepEqual(
    queued.rows.map((row) => row.storage_key).sort(),
    attempt.sort(),
  );
  for (const key of attempt) {
    assert.equal(await deletePendingFile(key, database, storage), true);
    assert.equal((await storage.headObject(key)).exists, false);
  }
});

test("hosted purge waits for live publication and retries the winning files after storage failure", async (t) => {
  const f = await fixture();
  await submitSigningForToken(f.token, f.submission, {
    database,
    verifiedMethods: ["account"],
    verifyPassword: async () => true,
  });
  const jobId = (
    await database.query("SELECT id FROM recovery_jobs WHERE envelope_id=$1", [
      f.envelopeId,
    ])
  ).rows[0].id;
  await database.query(
    "INSERT INTO account_closure_requests(user_id,requested_at,export_expires_at,purge_after_at,updated_at) VALUES($1,1,1,1,1)",
    [f.userId],
  );
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const publication = runRecoveryJobs({
    database: afterStatement(
      database,
      (sql) => sql.includes("UPDATE envelopes SET status = 'completed'"),
      async () => {
        publishing.resolve();
        await release.promise;
      },
    ),
    jobId,
  });
  await Promise.race([
    publishing.promise,
    publication.then(() =>
      assert.fail("publisher never acquired the envelope"),
    ),
  ]);
  const attempt = (
    await database.query(
      "SELECT storage_keys FROM finalization_attempts WHERE job_id=$1",
      [jobId],
    )
  ).rows[0].storage_keys as string[];
  for (const key of attempt) keys.add(key);
  const applicationName = "purge-" + randomUUID();
  const purgePool = new Pool({
    connectionString: process.env.E2E_DATABASE_URL,
    application_name: applicationName,
  });
  const previous = process.env.HOSTED_MODE;
  process.env.HOSTED_MODE = "true";
  const outputError = console.error;
  const errors = t.mock.method(console, "error", (...args: unknown[]) => {
    if (
      !args.some((value) =>
        String(value).includes("fixture storage temporarily offline"),
      )
    )
      outputError(...args);
  });
  let queueAtFirstDelete: string[] | undefined;
  const purging = runRetentionSweep({
    database: purgePool,
    storageService: {
      ...storage,
      async deleteObject(key) {
        const first =
          key.includes(f.envelopeId) && queueAtFirstDelete === undefined;
        if (first) {
          queueAtFirstDelete = (
            await database.query(
              "SELECT storage_key FROM pending_file_deletions WHERE envelope_id=$1",
              [f.envelopeId],
            )
          ).rows.map((row) => row.storage_key);
        }
        if (first || attempt.includes(key))
          throw new Error("fixture storage temporarily offline");
        return storage.deleteObject(key);
      },
    },
  });
  try {
    let blocked = false;
    for (let count = 0; count < 300 && !blocked; count++) {
      blocked =
        (
          await database.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
            [applicationName],
          )
        ).rowCount === 1;
      if (!blocked) await delay(10);
    }
    assert.equal(
      blocked,
      true,
      "purge overlapped the fenced publication transaction",
    );
    release.resolve();
    assert.equal((await publication).failed, 0);
    assert.ok(!(await purging).accountPurgeFailures.includes(f.userId));
    assert.equal(
      (
        await database.query("SELECT id FROM envelopes WHERE id=$1", [
          f.envelopeId,
        ])
      ).rowCount,
      0,
    );
    assert.deepEqual(
      queueAtFirstDelete?.filter((key) => attempt.includes(key)).sort(),
      [...attempt].sort(),
    );
    assert.ok(
      errors.mock.calls.some((call) =>
        call.arguments.some((value) =>
          String(value).includes("fixture storage temporarily offline"),
        ),
      ),
    );
    for (const key of attempt)
      assert.ok((await storage.headObject(key)).exists);
    const result = await runRetentionSweep({
      database,
      storageService: storage,
    });
    assert.ok(result.pendingFileDeletionsDone >= 3);
    for (const key of attempt)
      assert.equal((await storage.headObject(key)).exists, false);
  } finally {
    release.resolve();
    await Promise.allSettled([publication, purging]);
    if (previous === undefined) delete process.env.HOSTED_MODE;
    else process.env.HOSTED_MODE = previous;
    await purgePool.end();
  }
});

for (const phase of ["data-rename", "metadata-rename"]) {
  test(`local SIGKILL during ${phase} leaves no staged files after recovery cleanup`, async (t) => {
    const env = { ...process.env, STORAGE_DRIVER: "local" };
    const local = createStorageService({ env });
    const f = await fixture(local);
    await submitSigningForToken(f.token, f.submission, {
      database,
      storageService: local,
      verifiedMethods: ["account"],
      verifyPassword: async () => true,
    });
    const jobId = (
      await database.query(
        "SELECT id FROM recovery_jobs WHERE envelope_id=$1",
        [f.envelopeId],
      )
    ).rows[0].id;
    const child = await pausedProcess(
      t,
      { phase, envelopeId: f.envelopeId, jobId },
      env,
    );
    const attempt = (
      await database.query(
        "SELECT storage_keys FROM finalization_attempts WHERE job_id=$1",
        [jobId],
      )
    ).rows[0].storage_keys as string[];
    const root = path.dirname(path.join(directory, attempt[0]));
    const raw = await readdir(root);
    const tmp = raw.find((name) => name.endsWith(".tmp"));
    assert.ok(tmp);
    const bytes = await readFile(path.join(root, tmp));
    if (phase === "data-rename")
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    else
      assert.equal(JSON.parse(bytes.toString()).contentType, "application/pdf");
    await child.kill();
    await expire(jobId);
    assert.equal((await runRecoveryJobs({ database, env, jobId })).failed, 0);
    const queued = (
      await database.query(
        "SELECT storage_key FROM pending_file_deletions WHERE envelope_id=$1",
        [f.envelopeId],
      )
    ).rows.map((row) => row.storage_key);
    assert.deepEqual(queued.sort(), attempt.sort());
    for (const key of queued)
      assert.ok(await deletePendingFile(key, database, local));
    assert.deepEqual(await readdir(root, { recursive: true }), []);
    const winner = (
      await database.query("SELECT signed_pdf_key FROM envelopes WHERE id=$1", [
        f.envelopeId,
      ])
    ).rows[0].signed_pdf_key;
    assert.equal((await local.headObject(winner)).exists, true);
  });
}
