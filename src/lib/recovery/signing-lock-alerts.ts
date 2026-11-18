import {
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
  return withTransaction(async (tx) => {
    // Same ordering as lockout and account purge: owner first, then audit
    // and queue. A purge that wins leaves a retired audit with no payload.
    const user = await queryOne<{ name: string; lockedAt: number | null }>(
      tx,
      `SELECT name, signing_locked_at AS "lockedAt" FROM "user"
        WHERE id = $1 FOR NO KEY UPDATE`,
      [audit.userId],
    );
    const pending = await queryOne<{ id: string }>(
      tx,
      `SELECT id FROM system_audit_events WHERE id = $1
        AND ${PENDING_SIGNING_LOCK_ALERT} FOR UPDATE`,
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
  }, database);
}

/** Uses the caller's scoped executor during a scheduled recovery run. */
export async function reconcileSigningLockAlerts({
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
  const pending = await queryMany<LockAudit>(
    database,
    `SELECT id, target_user_id AS "userId", actor_email AS email, sequence,
        created_at AS "lockedAt", (metadata->>'failedAttempts')::int AS "failedAttempts"
      FROM system_audit_events
      WHERE ${PENDING_SIGNING_LOCK_ALERT}
        AND ($1::text IS NULL OR id = $1)
        AND (signing_lock_alert_retry_at IS NULL OR signing_lock_alert_retry_at <= clock_timestamp())
      ORDER BY signing_lock_alert_retry_at NULLS FIRST, sequence LIMIT $2`,
    [auditId ?? null, limit],
  );
  const jobs: string[] = [];
  for (const audit of pending) {
    if (signal.aborted) break;
    try {
      jobs.push(...(await reconcileSigningLockAlert(audit, database, env)));
    } catch {
      if (signal.aborted) break;
      console.error("[recovery] Signing lock alert reconciliation deferred.");
      if (!auditId) {
        await database.query(
          `UPDATE system_audit_events SET signing_lock_alert_retry_at = clock_timestamp() + interval '30 seconds'
            WHERE id = $1 AND signing_lock_alert_reconciled_at IS NULL`,
          [audit.id],
        );
      }
    }
  }
  return jobs;
}

/** Accelerates one committed lock without delaying unrelated credential checks. */
export async function tryReconcileSigningLockAlert(
  auditId: string,
  database: DbPool,
) {
  const budget = createRecoveryBudget(1000);
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
