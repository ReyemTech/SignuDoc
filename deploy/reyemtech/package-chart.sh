#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 4 || ! $1 =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 COMMIT_SHA branch|tag REF_NAME OUTPUT_DIRECTORY" >&2
  exit 1
fi

commit=$1
ref_type=$2
ref_name=$3
output_directory=$4
chart=charts/signudoc
chart_version=$(yq -er '.version' "$chart/Chart.yaml")
chart_app_version=$(yq -er '.appVersion' "$chart/Chart.yaml")
app_version=$(jq -er '.version' package.json)
stable_version='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

if [[ ! $chart_version =~ $stable_version ]]; then
  echo "The chart version must be a stable SemVer base." >&2
  exit 1
fi

if [[ $chart_app_version != "$app_version" ]]; then
  echo "The chart appVersion must match package.json version." >&2
  exit 1
fi

case "$ref_type" in
  branch)
    version="$chart_version-sha-$commit"
    ;;
  tag)
    if [[ $ref_name != "v$app_version" || ! $app_version =~ $stable_version ]]; then
      echo "Release tag must match the stable app version (v$app_version)." >&2
      exit 1
    fi
    version="$chart_version"
    ;;
  *)
    echo "Unsupported ref type: $ref_type" >&2
    exit 1
    ;;
esac

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cp -R "$chart" "$work/signudoc"
export SIGNUDOC_COMMIT="$commit"
yq -i '
  .image.repository = "ghcr.io/reyemtech/signudoc" |
  .image.tag = strenv(SIGNUDOC_COMMIT) |
  .migration.image.repository = "ghcr.io/reyemtech/signudoc-migrate" |
  .migration.image.tag = strenv(SIGNUDOC_COMMIT)
' "$work/signudoc/values.yaml"
# Share ownership with the fork when GHCR creates the chart package.
yq -i '
  .sources = ["https://github.com/ReyemTech/SignuDoc"] |
  .annotations."org.opencontainers.image.source" = "https://github.com/ReyemTech/SignuDoc"
' "$work/signudoc/Chart.yaml"

mkdir -p "$output_directory"
helm package "$work/signudoc" --version "$version" --destination "$output_directory" >&2
printf '%s\n' "$version"
