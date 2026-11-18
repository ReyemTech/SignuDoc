import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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

test("fixture cleanup and the container reject a linked root and preserve an ordinary root", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "signudoc-fixture-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fixture = path.join(scratch, "fixture");
  const external = path.join(scratch, "external");
  await mkdir(external);
  const sentinel = path.join(external, "sentinel");
  await writeFile(sentinel, "untouched");
  await symlink(external, fixture, "dir");
  if (process.getuid?.()) {
    assert.throws(
      () =>
        containerApp("image", {
          port: 3100,
          outbox: path.join(fixture, "outbox"),
          env: {
            DATABASE_URL: "postgres://localhost/db",
            EIDEASY_API_URL: "http://localhost",
          },
        }),
      /fixture directory/,
    );
  }
  const { clearFixtureDirectory } = await import("./fixture-directory.ts");
  await assert.rejects(clearFixtureDirectory(fixture), /fixture directory/);
  assert.equal(await readFile(sentinel, "utf8"), "untouched");
  await rm(fixture);
  await mkdir(fixture);
  await symlink(external, path.join(fixture, "child"), "dir");
  const before = await stat(fixture);
  await clearFixtureDirectory(fixture);
  assert.equal((await stat(fixture)).ino, before.ino);
  assert.equal(await readFile(sentinel, "utf8"), "untouched");
  await assert.rejects(stat(path.join(fixture, "child")), { code: "ENOENT" });
});
