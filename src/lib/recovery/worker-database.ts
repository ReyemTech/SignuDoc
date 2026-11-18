import { type PoolClient } from "pg";

import {
  type DbPool,
  type TransactionPool,
  withTransaction,
} from "../db/connection.ts";

class RecoveryBudgetExceeded extends Error {
  constructor() {
    super("Recovery budget exhausted.");
  }
}

export function createRecoveryBudget(maxDurationMs: number) {
  const deadline = performance.now() + maxDurationMs;
  const controller = new AbortController();
  const exhaust = () => controller.abort();
  const timer = setTimeout(exhaust, maxDurationMs);
  timer.unref();

  function remainingMs() {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) exhaust();
    if (controller.signal.aborted) throw new RecoveryBudgetExceeded();
    return remaining;
  }

  return {
    signal: controller.signal,
    exhaust,
    remainingMs,
    expired() {
      if (deadline - performance.now() < 1) exhaust();
      return controller.signal.aborted;
    },
    dispose: () => clearTimeout(timer),
  };
}

type RecoveryBudget = ReturnType<typeof createRecoveryBudget>;

function boundedClient(client: PoolClient, budget: RecoveryBudget): PoolClient {
  let released = false;
  function release(error?: Error | boolean) {
    if (released) return;
    released = true;
    budget.signal.removeEventListener("abort", abort);
    client.release(error);
  }
  const abort = () => release(true);
  budget.signal.addEventListener("abort", abort, { once: true });

  return new Proxy(client, {
    get(target, key, receiver) {
      if (key === "release") return release;
      if (key === "query") {
        return async (text: string, values?: unknown[]) => {
          // A disposed client rolls back on disconnect. Sending ROLLBACK
          // through it would mask the original cancellation.
          if (released && text === "ROLLBACK") return;
          try {
            const remaining = budget.remainingMs();
            if (text !== "BEGIN" && text !== "ROLLBACK") {
              // This applies on the server even while waiting on a table,
              // row or advisory lock. Refresh it from the common deadline
              // before each statement, including the commit.
              await client.query(
                "SELECT set_config('statement_timeout', $1, true)",
                [String(remaining)],
              );
              budget.remainingMs();
            }
            return await client.query(text, values);
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "57014"
            ) {
              budget.exhaust();
            }
            if (budget.signal.aborted) throw new RecoveryBudgetExceeded();
            throw error;
          }
        };
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function boundedConnect(
  database: DbPool,
  budget: RecoveryBudget,
): Promise<PoolClient> {
  budget.remainingMs();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new RecoveryBudgetExceeded());
    budget.signal.addEventListener("abort", abort, { once: true });

    void database.connect().then(
      (client) => {
        budget.signal.removeEventListener("abort", abort);
        if (budget.expired()) {
          // Pool checkout itself may finish after the worker has returned.
          // Return the client without issuing any SQL.
          client.release();
          abort();
        } else {
          resolve(boundedClient(client, budget));
        }
      },
      (error: unknown) => {
        budget.signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * The worker's query and withTransaction calls use transaction-local
 * deadlines. The pool and connections used by other requests are unchanged.
 */
export function createBoundedRecoveryDatabase(
  database: DbPool,
  budget: RecoveryBudget,
): TransactionPool {
  const scoped: TransactionPool = {
    connect: () => boundedConnect(database, budget),
    query: (text, values) =>
      withTransaction((client) => client.query(text, values), scoped),
  };
  return scoped;
}
