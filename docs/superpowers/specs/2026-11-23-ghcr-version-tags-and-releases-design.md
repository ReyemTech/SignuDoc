# Versioned GitHub Releases and GHCR packages

## Intent

Make each SignuDoc application release visible and deployable from the ReyemTech fork. Argo CD tracks stable Helm chart versions with `targetRevision: "0.*"`; Docker consumers can use either a stable version or `latest`.

## Goals

- Use `package.json.version` as the release version; create a matching `vX.Y.Z` Git tag and GitHub Release when that version reaches `main`.
- Publish app and migration images with immutable commit-SHA tags, the stable app-version tag on release, and a moving `latest` tag on successful `main` builds.
- Publish the Helm chart with `Chart.yaml.version` and `appVersion` matching the app version, so a release such as 0.9.0 is available as chart version 0.9.0 to Argo CD.
- Add a GHCR `latest` OCI alias for the chart for registry discoverability. The alias is not a Helm/Argo version; Helm requires the chart's actual SemVer tag.
- Keep the existing release-update PR as the place where incoming upstream version changes update package and chart metadata. No Release Please or commit-message version inference.

## Non-goals

- Change application runtime or deployment values.
- Automatically apply releases to Kubernetes; Argo CD remains manually synced.
- Re-tag an existing SemVer image/chart release to different content.

## Approaches

1. **Use `package.json.version` as the release signal (selected):** the main-branch publishing workflow creates the GitHub tag/release when that version has not been released, publishes images and chart under the version, and updates `latest`. This matches the existing upstream sync PR, which already changes `package.json`.
2. **Infer versions from conventional commits:** adds semantic-release and a commit-message policy, with more moving parts and a different version source.
3. **Create releases manually:** keeps automation smaller but repeats the missing-tag/release problem.

## Release behavior

- Every successful `main` package build updates the app and migration image `latest` tags and keeps the commit-SHA tags. Historical tag builds never move `latest` backward.
- When `package.json.version` changes to an unreleased version, create `v<version>` and a GitHub Release, then publish both images with that version tag and the chart as that SemVer version.
- A main build for an already released version does not move its immutable version tags. Its `latest` image and chart aliases may advance; any branch chart build gets a SHA-suffixed version. Historical tag builds never update either `latest` alias.
- Synchronize `charts/signudoc/Chart.yaml` `version` and `appVersion` to the release version in the generated update PR. Argo CD's `0.*` constraint resolves the stable chart SemVer, not `latest`.

## Acceptance

- A main build for an unreleased 0.9.0 creates Git tag `v0.9.0` and a GitHub Release.
- App and migration packages expose commit SHA, 0.9.0, and latest tags for the release.
- The chart package is published as 0.9.0 with `version: 0.9.0` and `appVersion: 0.9.0`; the optional latest alias resolves to the same OCI manifest.
- Re-running publication does not change an existing version tag's content.
- Workflow tests cover version creation, repeat runs, latest, and chart metadata/tag generation.
