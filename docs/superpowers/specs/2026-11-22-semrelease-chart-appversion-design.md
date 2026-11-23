# Keep Helm appVersion aligned with SignuDoc releases

## Intent

When the fork imports a new upstream SignuDoc release, its release pull request should update the Helm chart's `appVersion` to the version in `package.json`. This prevents the package publisher from failing on a stale chart version.

## Goals

- Update `charts/signudoc/Chart.yaml` in the generated release branch before its commit is created.
- Keep the chart's independent `version` unchanged.
- Cover the behavior in the existing update-workflow integration tests.
- Set the current upstream 0.9.0 sync branch's `appVersion` to `0.9.0`.

## Non-goals

- Change the chart package versioning policy.
- Rewrite chart metadata only inside the temporary package.
- Change upstream SignuDoc or publish directly from this work.

## Approaches

1. **Update the generated release PR** (selected): synchronize chart `appVersion` from the imported `package.json`. The source branch and eventual published package stay consistent.
2. Update only the temporary chart during packaging. This avoids a publish failure but leaves the repository chart stale.
3. Continue updating the chart manually per release. This keeps the current workflow but repeats the mismatch risk.

## Implementation notes

The update workflow already merges the upstream release into a generated branch and tests its shell steps against throwaway Git repositories. Extend that workflow and fixture to assert a new upstream package version is reflected in the generated chart. Keep `Chart.yaml`'s chart `version` independent from the application version.

## Acceptance

- The update-workflow integration test fails before the change and passes after it.
- The generated release branch has matching `package.json` and chart `appVersion` values.
- The current sync branch's chart `appVersion` matches package version `0.9.0`.
