import {
  type DbExecutor,
  type DbPool,
  queryMany,
  queryOne,
  withTransaction,
} from "../db/connection.ts";
import { getBranding } from "../settings.ts";
import { type EnvSource } from "../utils/env.ts";
import { enqueueEmail } from "./email.ts";
import { PENDING_SIGNING_LOCK_ALERT } from "./jobs.ts";
import {
  createBoundedRecoveryDatabase,
  createRecoveryBudget,
} from "./worker-database.ts";

const INLINE_RECONCILIATION_BUDGET_MS = 1000;

function isLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "55P03"
  );
}

function withShortLockWait<T>(
  database: DbPool,
  run: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  return withTransaction(async (tx) => {
    // Keep table locks and other contended statements brief while allowing
    // a healthy cohort to use its work budget for all of its recipients.
    await tx.query("SET LOCAL lock_timeout = '100ms'");
    return run(tx);
  }, database);
}

export function buildSigningLockAlert(
  person: { email: string; name: string },
  productName: string,
  recipient: string,
  failedAttempts: number,
) {
  const textBody = [
    `${person.name} <${person.email}> gave the wrong password ${failedAttempts} times in a row while signing on ${productName}.`,
    "",
    "Their account can no longer sign until an administrator unlocks it under Settings, People.",
    "If this was not them, someone may be trying to sign in their name. Check with them before unlocking.",
  ].join("\n");

  return {
    subject: `Signing locked for ${person.name}`,
    template: "signing_lock_alert",
    textBody,
    to: recipient,
  } as const;
}

type LockAudit = {
  id: string;
  userId: string;
  email: string;
  lockedAt: number;
  sequence: number;
  failedAttempts: number;
};

async function reconcileSigningLockAlert(
  audit: LockAudit,
  database: DbPool,
  env: EnvSource,
): Promise<string[]> {
  return withShortLockWait(database, async (tx) => {
    // Same ordering as lockout and account purge: owner first, then audit
    // and queue. A purge that wins leaves a retired audit with no payload.
    const user = await queryOne<{ name: string; lockedAt: number | null }>(
      tx,
      `SELECT name, signing_locked_at AS "lockedAt" FROM "user"
        WHERE id = $1 FOR NO KEY UPDATE NOWAIT`,
      [audit.userId],
    );
    const pending = await queryOne<{ id: string }>(
      tx,
      `SELECT id FROM system_audit_events WHERE id = $1
        AND ${PENDING_SIGNING_LOCK_ALERT} FOR UPDATE NOWAIT`,
      [audit.id],
    );
    if (!pending) return [];

    const jobs: string[] = [];
    if (user && user.lockedAt === audit.lockedAt) {
      const newer = await queryOne<{ id: string }>(
        tx,
        `SELECT id FROM system_audit_events WHERE target_user_id = $1 AND sequence > $2
          AND event IN ('signing_locked', 'signing_unlocked', 'account_deleted')
          ORDER BY sequence DESC LIMIT 1`,
        [audit.userId, audit.sequence],
      );
      if (!newer) {
        const admins = await queryMany<{ id: string; email: string }>(
          tx,
          `SELECT id, email FROM "user" WHERE role = 'admin' ORDER BY id`,
        );
        if (admins.length === 0) {
          throw new Error(
            "No administrator is currently available for the signing lock alert.",
          );
        }
        const { productName } = await getBranding(env, tx);
        for (const admin of admins) {
          const { id } = await enqueueEmail(
            {
              message: buildSigningLockAlert(
                { email: audit.email, name: user.name },
                productName,
                admin.email,
                audit.failedAttempts,
              ),
              dedupeKey: `signing-lock/${audit.id}/${admin.id}`,
              userId: audit.userId,
              guard: {
                kind: "signing_lock",
                adminId: admin.id,
                lockedAt: audit.lockedAt,
                auditSequence: audit.sequence,
              },
            },
            { database: tx, env },
          );
          jobs.push(id);
        }
      }
    }
    await tx.query(
      `UPDATE system_audit_events
        SET signing_lock_alert_reconciled_at = clock_timestamp(), signing_lock_alert_retry_at = NULL
        WHERE id = $1`,
      [audit.id],
    );
    return jobs;
  });
}

const LOCK_AUDIT_COLUMNS = `
  audit.id, audit.target_user_id AS "userId", audit.actor_email AS email, audit.sequence,
  audit.created_at AS "lockedAt", (audit.metadata->>'failedAttempts')::int AS "failedAttempts"
`;

async function discoverSigningLockAlerts({
  auditId,
  database,
  limit,
}: {
  auditId?: string;
  database: DbPool;
  limit: number;
}): Promise<LockAudit[]> {
  return withShortLockWait(database, (tx) =>
    auditId
      ? queryMany<LockAudit>(
          tx,
          `SELECT ${LOCK_AUDIT_COLUMNS}
          FROM system_audit_events audit
          WHERE id = $1 AND ${PENDING_SIGNING_LOCK_ALERT}
            AND (signing_lock_alert_retry_at IS NULL OR signing_lock_alert_retry_at <= clock_timestamp())`,
          [auditId],
        )
      : queryMany<LockAudit>(
          tx,
          `WITH due AS (
            SELECT id FROM system_audit_events
            WHERE ${PENDING_SIGNING_LOCK_ALERT}
              AND (signing_lock_alert_retry_at IS NULL OR signing_lock_alert_retry_at <= clock_timestamp())
            ORDER BY signing_lock_alert_retry_at NULLS FIRST, sequence LIMIT $1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE system_audit_events AS audit
          SET signing_lock_alert_retry_at = clock_timestamp() + interval '30 seconds'
          FROM due WHERE audit.id = due.id
          RETURNING ${LOCK_AUDIT_COLUMNS}`,
          [limit],
        ),
  );
}

/** Uses the caller's scoped executor during a scheduled recovery run. */
async function reconcileSigningLockAlerts({
  auditId,
  database,
  env = process.env,
  limit,
  signal,
}: {
  auditId?: string;
  database: DbPool;
  env?: EnvSource;
  limit: number;
  signal: AbortSignal;
}): Promise<string[]> {
  let pending: LockAudit[];
  try {
    // The discovery transaction commits before locking any account. Its
    // retry time survives a contended owner, exhausted budget, or restart.
    pending = await discoverSigningLockAlerts({ auditId, database, limit });
  } catch (error) {
    if (isLockContention(error)) return [];
    throw error;
  }
  const jobs: string[] = [];
  for (const audit of pending) {
    if (signal.aborted) break;
    try {
      jobs.push(...(await reconcileSigningLockAlert(audit, database, env)));
    } catch (error) {
      if (signal.aborted) break;
      if (isLockContention(error)) continue;
      console.error("[recovery] Signing lock alert reconciliation deferred.");
    }
  }
  return jobs;
}

/** Reserves most of the drain for claiming ready jobs. */
export async function reconcileSigningLockAlertsBeforeClaims({
  database,
  env,
  limit,
  runBudget,
}: {
  database: DbPool;
  env: EnvSource;
  limit: number;
  runBudget: ReturnType<typeof createRecoveryBudget>;
}): Promise<void> {
  const allowance = Math.floor(runBudget.remainingMs() / 4);
  if (allowance < 1) return;

  const budget = createRecoveryBudget(allowance);
  runBudget.signal.addEventListener("abort", budget.exhaust, { once: true });
  try {
    await reconcileSigningLockAlerts({
      database: createBoundedRecoveryDatabase(database, budget),
      env,
      limit,
      signal: budget.signal,
    });
  } catch (error) {
    if (!budget.expired()) throw error;
  } finally {
    runBudget.signal.removeEventListener("abort", budget.exhaust);
    budget.dispose();
  }
}

/** Accelerates one committed lock without delaying unrelated credential checks. */
export async function tryReconcileSigningLockAlert(
  auditId: string,
  database: DbPool,
) {
  const budget = createRecoveryBudget(INLINE_RECONCILIATION_BUDGET_MS);
  try {
    return await reconcileSigningLockAlerts({
      auditId,
      database: createBoundedRecoveryDatabase(database, budget),
      limit: 1,
      signal: budget.signal,
    });
  } catch {
    console.error("[recovery] Signing lock alert reconciliation deferred.");
    return [];
  } finally {
    budget.dispose();
  }
}
