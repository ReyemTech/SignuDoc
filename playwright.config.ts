import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { containerApp } from "./e2e/support/container-app";

// One end-to-end test that walks the whole product against a real Postgres,
// with files on local disk and emails captured to JSON instead of sent.
//
//   npm run db:start   (once, for a local Postgres)
//   npm run test:e2e
//
// The test database is wiped on every run. It must have "e2e" in its name.
//
// The app is built and started in production mode, so the test sees the same
// headers, bundles and Content Security Policy as a real deployment. Set
// E2E_DEV=1 to run against "next dev" instead, which starts faster.
const port = Number(process.env.E2E_PORT ?? 3100);
export const e2eAppUrl = `http://localhost:${String(port)}`;
export const e2eRecoveryEnabled = process.env.E2E_DURABLE_JOBS === "1";
export const e2eCronSecret = "fixture-playwright-recovery-secret";

export const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
export const e2eDataDir = path.resolve(".data", "e2e");
export const e2eOutboxDir = path.join(e2eDataDir, "outbox");
// First-run setup asks for this, as it does on a deployment that sets one.
export const e2eSetupToken = "e2e-setup-token";
// A stand-in for eID Easy, so the test can sign with a qualified
// certificate in the signer's own name without the real service.
const providerPort = Number(process.env.E2E_PROVIDER_PORT ?? port + 1);

const appEnv = {
  APP_URL: e2eAppUrl,
  BETTER_AUTH_SECRET: "e2e-only-secret-not-used-anywhere-else-0123456789",
  BETTER_AUTH_URL: e2eAppUrl,
  DATABASE_URL: e2eDatabaseUrl,
  EMAIL_CAPTURE_DIR: e2eOutboxDir,
  EIDEASY_API_URL: `http://127.0.0.1:${String(providerPort)}/eideasy`,
  EIDEASY_CLIENT_ID: "test-client",
  EIDEASY_SECRET: "test-secret",
  EMAIL_DRIVER: "capture",
  NEXT_TELEMETRY_DISABLED: "1",
  // The breach check calls an outside service; the test must not.
  PASSWORD_BREACH_CHECK: "off",
  SETUP_TOKEN: e2eSetupToken,
  // "local" unless E2E_STORAGE_DRIVER says otherwise. With "blob" and a
  // BLOB_READ_WRITE_TOKEN in the environment, the same test runs against
  // a real Vercel Blob store, direct browser upload included.
  STORAGE_DRIVER: process.env.E2E_STORAGE_DRIVER ?? "local",
  STORAGE_LOCAL_DIR: path.join(e2eDataDir, "storage"),
  DURABLE_JOBS_ENABLED: e2eRecoveryEnabled ? "true" : "false",
  CRON_SECRET: e2eRecoveryEnabled ? e2eCronSecret : "",
  AUDIT_LOG: "off",
};
const appImage = process.env.E2E_APP_IMAGE;
const container = appImage
  ? containerApp(appImage, { port, env: appEnv, outbox: e2eOutboxDir })
  : undefined;

export default defineConfig({
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  globalSetup: "./e2e/global-setup.ts",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { height: 900, width: 1440 },
      },
    },
  ],
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "./e2e",
  timeout: 180_000,
  use: {
    baseURL: e2eAppUrl,
    launchOptions: container?.launchOptions,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        container?.command ??
        (process.env.E2E_DEV === "1"
          ? `npx next dev --port ${String(port)}`
          : `npx next build && npx next start --port ${String(port)}`),
      env: container?.env ?? appEnv,
      gracefulShutdown: container?.gracefulShutdown,
      reuseExistingServer: false,
      timeout: 300_000,
      // Playwright starts the server before the test database is prepared:
      // on a first run, as in CI, it has no tables at all, and on later runs
      // it holds the last run's data. So the readiness check must be
      // something that never touches the database. A page would remember for
      // a minute that the site is already set up, and an API route can fail
      // outright for want of tables.
      url: `${e2eAppUrl}/icon.svg`,
    },
    {
      command:
        "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/support/provider-stand-in.ts",
      env: { E2E_PROVIDER_PORT: String(providerPort) },
      reuseExistingServer: false,
      timeout: 60_000,
      url: `http://127.0.0.1:${String(providerPort)}/health`,
    },
  ],
  workers: 1,
});
