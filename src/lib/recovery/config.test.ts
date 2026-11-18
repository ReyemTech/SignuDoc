import assert from "node:assert/strict";
import { test } from "node:test";

import { assertRecoveryConfigured, isDurableJobsEnabled } from "./config.ts";

test("durable jobs require an explicit boolean opt-in and stable credentials", () => {
  assert.equal(isDurableJobsEnabled({}), false);
  assert.equal(isDurableJobsEnabled({ DURABLE_JOBS_ENABLED: "false" }), false);
  assert.equal(isDurableJobsEnabled({ DURABLE_JOBS_ENABLED: "true" }), true);
  assert.throws(
    () => isDurableJobsEnabled({ DURABLE_JOBS_ENABLED: "1" }),
    /DURABLE_JOBS_ENABLED/,
  );
  assert.throws(
    () => isDurableJobsEnabled({ DURABLE_JOBS_ENABLED: "" }),
    /DURABLE_JOBS_ENABLED/,
  );
  assert.doesNotThrow(() => assertRecoveryConfigured({}));
  assert.throws(
    () =>
      assertRecoveryConfigured({
        DURABLE_JOBS_ENABLED: "true",
        DATABASE_URL: "postgres://example:derived-credential@localhost/db",
      }),
    /BETTER_AUTH_SECRET/,
  );
  assert.throws(
    () =>
      assertRecoveryConfigured({
        DURABLE_JOBS_ENABLED: "true",
        BETTER_AUTH_SECRET: "x".repeat(32),
      }),
    /CRON_SECRET/,
  );
  assert.doesNotThrow(() =>
    assertRecoveryConfigured({
      DURABLE_JOBS_ENABLED: "true",
      BETTER_AUTH_SECRET: "x".repeat(32),
      CRON_SECRET: "test-only",
    }),
  );
});

test("enabled recovery requires a Cron secret that fits a single Bearer token", () => {
  const env = {
    DURABLE_JOBS_ENABLED: "true",
    BETTER_AUTH_SECRET: "x".repeat(32),
  };
  for (const secret of [
    "name:value",
    "two words",
    "invalid=middle",
    "x,y",
    "replace-with-secret",
  ]) {
    assert.throws(
      () => assertRecoveryConfigured({ ...env, CRON_SECRET: secret }),
      /CRON_SECRET/,
    );
  }
  assert.doesNotThrow(() =>
    assertRecoveryConfigured({ ...env, CRON_SECRET: "  e2e_token-._~+/==  " }),
  );

  assert.doesNotThrow(() =>
    assertRecoveryConfigured({
      DURABLE_JOBS_ENABLED: "false",
      CRON_SECRET: "legacy:secret",
    }),
  );
});
