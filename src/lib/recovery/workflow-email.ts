import { type DbPool, queryOne } from "../db/connection.ts";
import { type EmailService } from "../services/email.ts";
import { type EnvSource } from "../utils/env.ts";
import { runRecoveryJobs } from "./worker.ts";
import {
  createBoundedRecoveryDatabase,
  createRecoveryBudget,
} from "./worker-database.ts";

const INLINE_DELIVERY_BUDGET_MS = 3_000;

/** Best-effort delivery after commit. Anything left is owned by the queue. */
export async function tryDeliverWorkflowEmails(
  jobIds: readonly string[],
  {
    database,
    emailService,
    env,
  }: {
    database: DbPool;
    emailService?: EmailService;
    env?: EnvSource;
  },
): Promise<Set<string>> {
  const sent = new Set<string>();
  if (!jobIds.length) return sent;

  const budget = createRecoveryBudget(INLINE_DELIVERY_BUDGET_MS);
  try {
    const scopedDatabase = createBoundedRecoveryDatabase(database, budget);
    for (const jobId of jobIds) {
      if (budget.expired()) break;
      const run = await runRecoveryJobs({
        database,
        emailService,
        env,
        jobId,
        limit: 1,
        maxDurationMs: budget.remainingMs(),
      });
      if (!run.budgetExhausted && run.failed === 0) {
        const delivered = await queryOne<{ id: string }>(
          scopedDatabase,
          "SELECT id FROM recovery_jobs WHERE id = $1 AND state = 'succeeded'",
          [jobId],
        );
        if (delivered) sent.add(jobId);
      }
    }
  } catch {
    // The next scheduled pass can retry. Queue diagnostics classify errors
    // without logging message contents or provider response text.
    console.error("[recovery] Inline email delivery could not finish.");
  } finally {
    budget.dispose();
  }
  return sent;
}
