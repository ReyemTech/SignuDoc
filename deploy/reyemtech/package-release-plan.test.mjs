import assert from "node:assert/strict";
import { test } from "node:test";
import { planPackageRelease } from "./package-release-plan.mjs";

const commit = "a".repeat(40);
const version = "0.9.0";

function plan(overrides = {}) {
  return planPackageRelease({
    refType: "branch",
    refName: "main",
    commit,
    appVersion: version,
    versionTagExists: false,
    releaseExists: false,
    ...overrides,
  });
}

test("first main build creates the version release and all release tags", () => {
  assert.deepEqual(plan(), {
    releaseTag: "v0.9.0",
    createTag: true,
    createRelease: true,
    imageTags: [commit, "0.9.0", "latest"],
    chartVersion: "0.9.0",
    chartLatestTag: "0.9.0",
  });
});

test("later main builds advance latest without moving released SemVer tags", () => {
  assert.deepEqual(plan({ versionTagExists: true, releaseExists: true }), {
    releaseTag: "v0.9.0",
    createTag: false,
    createRelease: false,
    imageTags: [commit, "latest"],
    chartVersion: `0.9.0-sha-${commit}`,
    chartLatestTag: `0.9.0-sha-${commit}`,
  });
});

test("a main rebuild never creates an absent release from a newer commit", () => {
  assert.deepEqual(plan({ versionTagExists: true, releaseExists: false }), {
    releaseTag: "v0.9.0",
    createTag: false,
    createRelease: false,
    imageTags: [commit, "latest"],
    chartVersion: `0.9.0-sha-${commit}`,
    chartLatestTag: `0.9.0-sha-${commit}`,
  });
});

test("a tag with no GitHub Release is completed without repointing SemVer", () => {
  assert.deepEqual(
    plan({
      refType: "tag",
      refName: "v0.9.0",
      versionTagExists: true,
      releaseExists: false,
    }),
    {
      releaseTag: "v0.9.0",
      createTag: false,
      createRelease: true,
      imageTags: [commit, "0.9.0"],
      chartVersion: "0.9.0",
      chartLatestTag: null,
    },
  );
});

test("historical version tags publish their version without moving latest", () => {
  assert.deepEqual(
    plan({
      refType: "tag",
      refName: "v0.9.0",
      versionTagExists: true,
      releaseExists: true,
    }),
    {
      releaseTag: "v0.9.0",
      createTag: false,
      createRelease: false,
      imageTags: [commit, "0.9.0"],
      chartVersion: "0.9.0",
      chartLatestTag: null,
    },
  );
});

test("a tag that disagrees with package.json is rejected", () => {
  assert.throws(
    () => plan({ refType: "tag", refName: "v0.8.0" }),
    /does not match package version 0\.9\.0/,
  );
});

test("a manual non-main build publishes only immutable artifacts", () => {
  assert.deepEqual(plan({ refName: "feature/docs" }), {
    releaseTag: "v0.9.0",
    createTag: false,
    createRelease: false,
    imageTags: [commit],
    chartVersion: `0.9.0-sha-${commit}`,
    chartLatestTag: null,
  });
});

test("invalid package versions and short SHAs are rejected", () => {
  assert.throws(() => plan({ appVersion: "v0.9.0" }), /stable SemVer/);
  assert.throws(() => plan({ commit: "abc123" }), /full commit SHA/);
  assert.throws(
    () => plan({ versionTagExists: false, releaseExists: true }),
    /exists without its Git tag/,
  );
});
