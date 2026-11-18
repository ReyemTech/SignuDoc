import { readEnv, type EnvSource } from "../utils/env.ts";

const BEARER_TOKEN = /^[A-Za-z0-9._~+\/-]+=*$/;

function readBearerToken(value: string | undefined): string | undefined {
  return value && BEARER_TOKEN.test(value) ? value : undefined;
}

export function readRecoveryCronSecret(
  env: EnvSource = process.env,
): string | undefined {
  return readBearerToken(readEnv(env, "CRON_SECRET"));
}

export function readRecoveryAuthorization(
  authorization: string | null,
): string | undefined {
  const prefix = "Bearer ";
  return authorization?.startsWith(prefix)
    ? readBearerToken(authorization.slice(prefix.length))
    : undefined;
}

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

  if (!readRecoveryCronSecret(env)) {
    throw new Error(
      "Durable jobs require a Bearer-compatible CRON_SECRET. Generate one with openssl rand -hex 32.",
    );
  }
}
