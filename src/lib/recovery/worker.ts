import { getDb, type DbPool } from "../db/connection.ts";
import { type EmailService } from "../services/email.ts";
import { type EnvSource } from "../utils/env.ts";
import { assertRecoveryConfigured, isDurableJobsEnabled } from "./config.ts";
import { processEmailJob } from "./email.ts";
import {
  claimRecoveryJob,
  failRecoveryJob,
  RECOVERY_HEARTBEAT_MS,
  RecoveryJobError,
  renewRecoveryLease,
  type ClaimedRecoveryJob,
  type RecoveryJobKind,
} from "./jobs.ts";
import {
  createBoundedRecoveryDatabase,
  createRecoveryBudget,
} from "./worker-database.ts";

export type RecoveryHandler = (
  job: ClaimedRecoveryJob,
  options: { database: DbPool; env: EnvSource; signal: AbortSignal },
) => Promise<void>;

export type RecoveryRunSummary = {
  enabled: boolean;
  /** Claimed jobs passed to a handler, including cancellation and retry. */
  processed: number;
  /** Handlers that threw and had a fenced failure recorded. */
  failed: number;
  /** Work still leased at cutoff can be reclaimed after its lease expires. */
  budgetExhausted: boolean;
};

type RecoveryRunOptions = {
  database?: DbPool;
  env?: EnvSource;
  jobId?: string;
  limit?: number;
  maxDurationMs?: number;
  handlers?: Partial<Record<RecoveryJobKind, RecoveryHandler>>;
  emailService?: EmailService;
};

async function runClaim(
  job: ClaimedRecoveryJob,
  handler: RecoveryHandler,
  {
    database,
    env,
    signal,
  }: { database: DbPool; env: EnvSource; signal: AbortSignal },
): Promise<boolean> {
  const lease = new AbortController();
  let heartbeat: Promise<void> | null = null;
  const interval = setInterval(() => {
    if (heartbeat || lease.signal.aborted || signal.aborted) return;
    heartbeat = renewRecoveryLease(job, { database })
      .then(
        (renewed) => {
          if (!renewed) lease.abort();
        },
        () => lease.abort(),
      )
      .finally(() => {
        heartbeat = null;
      });
  }, RECOVERY_HEARTBEAT_MS);
  interval.unref();
  const stopHeartbeat = () => clearInterval(interval);
  signal.addEventListener("abort", stopHeartbeat, { once: true });

  try {
    const active = AbortSignal.any([signal, lease.signal]);
    if (active.aborted) throw new RecoveryJobError("deadline_exceeded");
    await handler(job, { database, env, signal: active });
    return false;
  } catch (error) {
    if (signal.aborted) return false;
    // The handler may have reached the provider before failing. Only the
    // fenced state and sanitized classification belong in diagnostics.
    return await failRecoveryJob(job, {
      database,
      code: error instanceof RecoveryJobError ? error.code : "handler_failed",
      permanent: error instanceof RecoveryJobError && error.permanent,
    });
  } finally {
    stopHeartbeat();
    signal.removeEventListener("abort", stopHeartbeat);
    await heartbeat;
  }
}

export async function runRecoveryJobs({
  database,
  env = process.env,
  jobId,
  limit = 20,
  maxDurationMs = 200_000,
  handlers,
  emailService,
}: RecoveryRunOptions = {}): Promise<RecoveryRunSummary> {
  const enabled = isDurableJobsEnabled(env);
  const summary = { enabled, processed: 0, failed: 0, budgetExhausted: false };
  if (!enabled) return summary;
  assertRecoveryConfigured(env);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > 2_147_483_647
  ) {
    throw new Error("Invalid recovery run bounds.");
  }
  if (limit === 0) return summary;

  const available = {
    email:
      handlers?.email ??
      ((job, options) => processEmailJob(job, { ...options, emailService })),
    finalize_envelope: handlers?.finalize_envelope,
  } satisfies Partial<Record<RecoveryJobKind, RecoveryHandler>>;
  const kinds: RecoveryJobKind[] = available.finalize_envelope
    ? ["email", "finalize_envelope"]
    : ["email"];
  const budget = createRecoveryBudget(maxDurationMs);
  try {
    const db = createBoundedRecoveryDatabase(database ?? getDb(), budget);
    while (summary.processed < limit && !budget.expired()) {
      const job = await claimRecoveryJob({ database: db, env, jobId, kinds });
      if (!job || budget.expired()) break;
      const handler = available[job.kind];
      if (!handler) break;
      summary.processed += 1;
      if (
        await runClaim(job, handler, {
          database: db,
          env,
          signal: budget.signal,
        })
      ) {
        summary.failed += 1;
      }
    }
  } catch (error) {
    if (!budget.expired()) throw error;
  } finally {
    summary.budgetExhausted = budget.expired();
    budget.dispose();
  }
  return summary;
}
