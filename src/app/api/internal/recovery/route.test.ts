import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { GET, POST } from "./route.ts";

const secret = "fixture-secret-for-cron";
const origin = "http://localhost/api/internal/recovery";

function request(method: string, authorization?: string) {
  return new Request(origin, {
    method,
    headers: authorization ? { authorization } : undefined,
  });
}

const envKeys = ["CRON_SECRET", "BETTER_AUTH_SECRET", "DURABLE_JOBS_ENABLED"];
const originalEnv = { ...process.env };

function configure(env: Record<string, string | undefined>) {
  for (const key of envKeys) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => configure(originalEnv));

test("status and drain reject anonymous or malformed Cron authorization", async () => {
  configure({ CRON_SECRET: secret, DURABLE_JOBS_ENABLED: "false" });

  for (const authorization of [
    undefined,
    secret,
    "Bearer",
    "Bearer ",
    `bearer ${secret}`,
    `Bearer  ${secret}`,
    `Bearer\t${secret}`,
    "Bearer fixture-secret-for-croh",
    `Bearer ${secret}, Bearer ${secret}`,
  ]) {
    for (const route of [GET, POST]) {
      const response = await route(request(route.name, authorization));
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
  }
});

test("empty, placeholder and unset secrets never allow either method", async () => {
  for (const value of [undefined, "   ", "replace-with-cron-secret"]) {
    configure({ CRON_SECRET: value, DURABLE_JOBS_ENABLED: "true" });
    for (const route of [GET, POST]) {
      for (const authorization of [
        undefined,
        `Bearer ${secret}`,
        "Bearer replace-with-cron-secret",
      ]) {
        const response = await route(request(route.name, authorization));
        assert.equal(response.status, 401);
      }
    }
  }
});

test("authenticated disabled recovery explicitly skips without accessing the database", async () => {
  configure({ CRON_SECRET: `  ${secret}  `, DURABLE_JOBS_ENABLED: "false" });
  for (const route of [GET, POST]) {
    const response = await route(request(route.name, `Bearer ${secret}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "disabled",
      enabled: false,
    });
  }
});

test("authenticated invalid feature configuration fails closed with a fixed error", async () => {
  for (const flag of ["yes", "true"]) {
    configure({
      CRON_SECRET: secret,
      DURABLE_JOBS_ENABLED: flag,
      BETTER_AUTH_SECRET: "private-fixture",
    });
    for (const route of [GET, POST]) {
      const response = await route(request(route.name, `Bearer ${secret}`));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "recovery_misconfigured",
      });
    }
  }
});
