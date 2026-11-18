import { createHash, timingSafeEqual } from "node:crypto";

import { getDb } from "../../../../lib/db/connection.ts";
import {
  assertRecoveryConfigured,
  isDurableJobsEnabled,
} from "../../../../lib/recovery/config.ts";
import { getRecoveryQueueHealth } from "../../../../lib/recovery/jobs.ts";
import {
  createBoundedRecoveryDatabase,
  createRecoveryBudget,
} from "../../../../lib/recovery/worker-database.ts";
import { runRecoveryJobs } from "../../../../lib/recovery/worker.ts";
import { readEnv } from "../../../../lib/utils/env.ts";

export const runtime = "nodejs";
export const maxDuration = 240;

const DRAIN_LIMIT = 20;
const DRAIN_BUDGET_MS = 200_000;
const HEALTH_BUDGET_MS = 5_000;

function json(body: object, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isAuthorized(request: Request) {
  const secret = readEnv(process.env, "CRON_SECRET");
  const token = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];

  if (!secret || !token) return false;

  // Fixed-length digests avoid rejecting a differently sized credential early.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(token), digest(secret));
}

async function readHealth() {
  const budget = createRecoveryBudget(HEALTH_BUDGET_MS);
  try {
    return await getRecoveryQueueHealth({
      database: createBoundedRecoveryDatabase(getDb(), budget),
    });
  } finally {
    budget.dispose();
  }
}

async function handle(request: Request, drain: boolean) {
  if (!isAuthorized(request)) return json({ error: "unauthorized" }, 401);

  try {
    if (!isDurableJobsEnabled())
      return json({ status: "disabled", enabled: false });
    assertRecoveryConfigured();
  } catch {
    return json({ error: "recovery_misconfigured" }, 503);
  }

  try {
    if (!drain)
      return json({
        status: "ready",
        enabled: true,
        health: await readHealth(),
      });

    const summary = await runRecoveryJobs({
      limit: DRAIN_LIMIT,
      maxDurationMs: DRAIN_BUDGET_MS,
    });
    const health = await readHealth();
    const healthy =
      summary.enabled &&
      summary.failed === 0 &&
      !summary.budgetExhausted &&
      health.counts.needs_attention === 0 &&
      health.attention.length === 0 &&
      health.pendingSigningLockAlerts === 0;

    return json({ status: "ran", ...summary, health }, healthy ? 200 : 503);
  } catch {
    // Never expose driver errors, request bodies, or job payloads to callers or logs.
    console.error(
      "[recovery] The scheduled run or queue status was unavailable.",
    );
    return json({ error: "recovery_unavailable" }, 503);
  }
}

export function GET(request: Request) {
  return handle(request, false);
}

export function POST(request: Request) {
  return handle(request, true);
}
