// Process boundaries for the integration test. All coordination happens in
// this fixture, while the application runs its ordinary transactions and PUTs.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { getDb } from "../../db/connection.ts";
import { afterStatement } from "../../db/test-database.ts";
import { createStorageService } from "../../services/storage.ts";
import { submitSigningForToken } from "../../signing.ts";
import { processFinalizationJob } from "../finalization.ts";
import { runRecoveryJobs } from "../worker.ts";

type Input = {
  phase: string;
  envelopeId: string;
  jobId?: string;
  token?: string;
  submission?: unknown;
};
const message = await new Promise<Input>((resolve) =>
  process.once("message", resolve),
);
const db = getDb();
async function pause() {
  process.send?.(message.phase);
  await new Promise<void>((resolve) => process.once("message", resolve));
}
// Pause the real local adapter between its completed staging write and rename.
if (message.phase === "data-rename" || message.phase === "metadata-rename") {
  const original = fs.rename;
  const suffix =
    message.phase === "data-rename" ? "/final.pdf" : "/final.pdf.meta.json";
  fs.rename = async (from, to) => {
    if (String(to).endsWith(suffix)) await pause();
    return original(from, to);
  };
  syncBuiltinESMExports();
}
try {
  if (message.phase === "accept" || message.phase === "published") {
    const database = afterStatement(
      db,
      (sql) => sql === "COMMIT",
      async () => {
        const state = await db.query(
          "SELECT state FROM recovery_jobs WHERE kind='finalize_envelope' AND envelope_id=$1",
          [message.envelopeId],
        );
        if (
          state.rows[0]?.state ===
          (message.phase === "accept" ? "pending" : "succeeded")
        )
          await pause();
      },
    );
    if (message.phase === "accept") {
      await submitSigningForToken(message.token!, message.submission, {
        database,
        verifiedMethods: ["account"],
        verifyPassword: async ({ password, hash }) =>
          password === "fixture-signature-password" && hash === "fixture-hash",
        requestMeta: {
          ipAddress: "192.0.2.12",
          userAgent: "finalization-fixture-agent",
        },
      });
    } else {
      await runRecoveryJobs({ database, jobId: message.jobId });
    }
  } else {
    let puts = 0;
    let paused = false;
    await runRecoveryJobs({
      database: db,
      jobId: message.jobId,
      handlers: {
        finalize_envelope: async (job, options) => {
          const service = createStorageService({ signal: options.signal });
          await processFinalizationJob(job, {
            ...options,
            storageService: {
              ...service,
              async getObject(key) {
                const object = await service.getObject(key);
                if (message.phase === "stale" && !paused) {
                  paused = true;
                  await pause();
                }
                return object;
              },
              async putObject(input) {
                const stored = await service.putObject(input);
                puts++;
                if (message.phase === `put${puts}`) await pause();
                return stored;
              },
            },
          });
        },
      },
    });
  }
} finally {
  await db.end();
  process.disconnect?.();
}
