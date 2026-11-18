import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { containerApp } from "./container-app.ts";

test("the browser container can access only the fixture directory", async (t) => {
  if (!process.getuid?.())
    return t.skip("container fixture requires a non-root host user");
  const root = await mkdtemp(path.join(tmpdir(), "signudoc-bind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "e2e");
  const { command } = containerApp("image", {
    port: 3100,
    outbox: path.join(fixture, "outbox"),
    env: {
      DATABASE_URL: "postgres://localhost/db",
      EIDEASY_API_URL: "http://localhost",
    },
  });
  assert.ok(command.includes("source=" + fixture + ",target=/app/.data/e2e"));
  assert.ok(!command.includes("source=" + root + ","));
});
