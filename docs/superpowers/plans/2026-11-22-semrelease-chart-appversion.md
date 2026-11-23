# Keep Helm appVersion aligned with SignuDoc releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each generated upstream-release PR set the Helm chart `appVersion` to the imported `package.json` version.

**Architecture:** Extend the existing `update-signudoc.yml` merge step to synchronize the fork-owned chart metadata after upstream files are merged. Add integration coverage to the existing shell-workflow harness and align the current 0.9.0 sync branch metadata.

**Tech Stack:** GitHub Actions YAML, Bash, `jq`, Node.js test runner, Git fixtures.

**Spec:** `docs/superpowers/specs/2026-11-22-semrelease-chart-appversion-design.md`

## Global Constraints

- Keep `charts/signudoc/Chart.yaml` `version` independent from application `appVersion`.
- Update `appVersion` from the imported `package.json` version before the generated release commit.
- Leave installs without `charts/signudoc/Chart.yaml` working unchanged.
- Current sync branch package and chart app versions must both be `0.9.0`.

## Review Focus

- A release updates `appVersion` but leaves chart `version` unchanged: assert both in the generated branch.
- A copy without the fork-only chart remains supported: retain a passing no-chart fixture.
- A later release continues to update the value: run the existing multi-release workflow tests.
- The current 0.9.0 branch stops failing package validation: run chart validation and package version check.
- The generated release branch includes the version update in its commit: assert the resulting tree and commit diff.

---

### Task 1: Synchronize the chart in release updates

**Files:**
- Modify: `.github/workflows/update-signudoc.yml`
- Modify: `src/lib/update-workflow.test.ts`
- Modify: `charts/signudoc/Chart.yaml`

**Interfaces:**
- Consumes: `package.json` version from the merged upstream release tree.
- Produces: generated update branch with `charts/signudoc/Chart.yaml` `appVersion` matching the package version when the chart exists.

- [ ] **Step 1: Add chart fixtures and failing integration assertions**

Add a fork-owned chart to the update-workflow fixture at app version `0.1.0`, with an independent chart version. Assert the generated `v0.2.0` branch changes only `appVersion` to `0.2.0` and leaves `version` unchanged. Add a fixture without the chart and assert that update still succeeds.

- [ ] **Step 2: Run the focused integration test and confirm the expected failure**

Run: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test src/lib/update-workflow.test.ts`

Expected: the chart alignment assertion fails because the generated branch retains appVersion `0.1.0`; the no-chart case remains successful.

- [ ] **Step 3: Synchronize appVersion in the workflow merge step**

In `.github/workflows/update-signudoc.yml`, after applying the merged release tree, read `package.json`'s version with `jq`. When `charts/signudoc/Chart.yaml` exists, update only its `appVersion` field. Keep its independent chart `version` untouched. Skip this operation when the chart is absent.

- [ ] **Step 4: Align the current 0.9.0 chart metadata**

Set `charts/signudoc/Chart.yaml` `appVersion` to `0.9.0`; leave chart `version` unchanged.

- [ ] **Step 5: Run focused and release validation**

Run: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test src/lib/update-workflow.test.ts`

Expected: all update workflow tests pass.

Run: `node charts/signudoc/tests/validate.mjs`

Expected: chart validation succeeds.

Run: `bash deploy/reyemtech/package-chart.sh 0123456789012345678901234567890123456789 branch test /tmp`

Expected: a chart archive is produced successfully using app version `0.9.0`.

- [ ] **Step 6: Commit the change**

```bash
git add .github/workflows/update-signudoc.yml src/lib/update-workflow.test.ts charts/signudoc/Chart.yaml docs/superpowers/specs/2026-11-22-semrelease-chart-appversion-design.md docs/superpowers/plans/2026-11-22-semrelease-chart-appversion.md
git commit -m "Keep chart appVersion aligned with releases"
```
