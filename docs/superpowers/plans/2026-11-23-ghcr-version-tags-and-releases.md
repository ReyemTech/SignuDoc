# GHCR Version Tags and GitHub Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create GitHub Releases from the package version and publish versioned app, migration, and Helm chart packages that Argo CD can track with `0.*`.

**Architecture:** Treat `package.json.version` as the release source. The generated upstream update PR synchronizes both Helm `version` and `appVersion`; the GHCR workflow publishes immutable SHA tags, release SemVer tags, and moving `latest` tags, and creates the corresponding GitHub Release. The chart’s `latest` alias is OCI-only; Argo uses the stable SemVer chart tag.

**Tech Stack:** GitHub Actions, Node.js test runner, Bash, Helm, Buildx, GHCR, ORAS.

**Spec:** `docs/superpowers/specs/2026-11-23-ghcr-version-tags-and-releases-design.md`

## Global Constraints

- `package.json.version`, chart `version`, and chart `appVersion` match for stable releases.
- Every successful `main` package build advances image `latest`; SHA tags remain immutable.
- Existing release SemVer tags are never repointed to different content.
- Argo CD uses the chart SemVer tag matching `targetRevision: "0.*"`; chart `latest` is informational only.
- Do not add Release Please or require conventional commit messages.

## Review Focus

- A first main build for an unreleased package version creates one matching GitHub tag/release and version tags.
- Rerunning a release never moves existing SemVer tags.
- A main build after a release updates `latest` while preserving the release version tag.
- A historical tag build cannot move image or chart `latest` backward.
- A tag/package/chart metadata mismatch fails before publishing.
- Both app and migration images, plus the OCI chart alias, receive the intended tags.

---

### Task 1: Synchronize stable chart metadata

**Files:**
- Modify: `.github/workflows/update-signudoc.yml`
- Modify: `src/lib/update-workflow.test.ts`
- Modify: `charts/signudoc/Chart.yaml`

**Interfaces:**
- Consumes: `package.json.version` from the upstream release tree.
- Produces: generated release branch with chart `version` and `appVersion` both equal to the package version.

- [x] Extend the fixture assertions so a 0.2.0 upstream update changes both chart fields to 0.2.0; keep the chart-absent fixture and add a later 0.3.0 assertion.
- [x] Run `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test src/lib/update-workflow.test.ts` and observe the new chart-version assertion fail.
- [x] Update the workflow’s guarded chart edit to set exactly one `version` and one `appVersion` from package.json, and fail if either field is absent or duplicated.
- [x] Set the current 0.9.0 sync branch chart `version` to 0.9.0, preserving the existing appVersion.
- [x] Re-run the focused workflow tests.

### Task 2: Test release metadata and chart packaging

**Files:**
- Create: `deploy/reyemtech/package-release-plan.mjs`
- Create: `deploy/reyemtech/package-release-plan.test.mjs`
- Modify: `package.json`
- Modify: `deploy/reyemtech/package-chart.sh`
- Modify: `charts/signudoc/tests/validate.mjs`

**Interfaces:**
- `planPackageRelease(input)` consumes event/ref/version/tag-existence facts and returns the immutable image tags, chart version, whether a GitHub Release is due, and the chart alias target.
- The chart packaging script consumes the full commit SHA and ref details; stable packages use the package version and branch packages use a SHA-suffixed version.

- [x] Add tests for a first 0.9.0 main release, a rerun with an existing release, a later main build, a matching and mismatched version tag, and a historical tag that cannot move `latest`.
- [x] Register the new test in `npm test` and run it to verify expected failures.
- [x] Implement the pure release-plan function and validate strict `X.Y.Z` versions.
- [x] Require chart `version` and `appVersion` to match `package.json.version`; verify stable package mode creates a `0.9.0` chart and branch mode creates a SHA-suffixed chart.
- [x] Run the new tests and `node charts/signudoc/tests/validate.mjs`.

### Task 3: Publish packages and create GitHub Releases

**Files:**
- Modify: `.github/workflows/publish-packages.yml`

**Interfaces:**
- Consumes: the release plan from Task 2 and the chart archive from `package-chart.sh`.
- Produces: SHA, SemVer, and `latest` image tags; SemVer and OCI `latest` chart tags; a GitHub Release for each newly published package version.

- [ ] Give the publishing job the minimum `contents: write` and `packages: write` permissions needed for release creation and package publishing.
- [ ] Compute the release plan before build/push; validate tag refs against `package.json.version` and chart metadata before publishing.
- [ ] Build app and migration images with commit SHA tags, add the matching app-version tag for a new stable release, and move `latest` only on successful main builds.
- [ ] Push the Helm chart at its stable SemVer for a new version, otherwise use the SHA-suffixed branch version; move the GHCR-only `latest` alias only on main builds.
- [ ] Create the GitHub Release with generated notes when the package version has not been released; keep retries idempotent and do not overwrite existing SemVer content.
- [ ] Run package workflow validation, full unit tests, typecheck, lint, chart validation, and package smoke checks.

### Task 4: Document release and Argo tracking behavior

**Files:**
- Modify: `docs/reyemtech-deployment.md`

- [ ] Document that a package-version change on main creates the GitHub Release and SemVer package tags, while `latest` tracks successful main builds.
- [ ] Document that Argo’s `0.*` selects chart SemVer and cannot select the OCI `latest` alias.
- [ ] Run `git diff --check` and review the final PR diff for unrelated files.
