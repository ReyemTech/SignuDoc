import { readEnv, type EnvSource } from "../utils/env.ts";

export function isDurableJobsEnabled(env: EnvSource = process.env): boolean {
  const value = env.DURABLE_JOBS_ENABLED;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("DURABLE_JOBS_ENABLED must be true or false.");
}

export function assertRecoveryConfigured(env: EnvSource = process.env): void {
  if (!isDurableJobsEnabled(env)) return;

  if ((readEnv(env, "BETTER_AUTH_SECRET")?.length ?? 0) < 32) {
    throw new Error(
      "Durable jobs require a stable BETTER_AUTH_SECRET of at least 32 characters.",
    );
  }

  if (!readEnv(env, "CRON_SECRET")) {
    throw new Error("Durable jobs require CRON_SECRET.");
  }
}
