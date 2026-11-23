const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const fullCommit = /^[0-9a-f]{40}$/;

export function planPackageRelease({
  refType,
  refName,
  commit,
  appVersion,
  versionTagExists,
  releaseExists,
}) {
  if (!stableVersion.test(appVersion)) {
    throw new Error(
      `package.json version must be stable SemVer: ${appVersion}`,
    );
  }
  if (!fullCommit.test(commit)) {
    throw new Error("commit must be a full commit SHA");
  }
  if (refType !== "branch" && refType !== "tag") {
    throw new Error(`unsupported ref type: ${refType}`);
  }

  const releaseTag = `v${appVersion}`;
  if (refType === "tag" && refName !== releaseTag) {
    throw new Error(
      `tag ${refName} does not match package version ${appVersion}`,
    );
  }
  if (releaseExists && !versionTagExists) {
    throw new Error(`GitHub Release ${releaseTag} exists without its Git tag`);
  }

  if (refType === "tag") {
    return {
      releaseTag,
      createTag: false,
      createRelease: !releaseExists,
      imageTags: [commit, appVersion],
      chartVersion: appVersion,
      chartLatestTag: null,
    };
  }

  if (refName === "main") {
    const isNewVersion = !versionTagExists;
    const chartVersion = isNewVersion
      ? appVersion
      : `${appVersion}-sha-${commit}`;
    return {
      releaseTag,
      createTag: isNewVersion,
      createRelease: isNewVersion && !releaseExists,
      imageTags: [commit, ...(isNewVersion ? [appVersion] : []), "latest"],
      chartVersion,
      chartLatestTag: chartVersion,
    };
  }

  const chartVersion = `${appVersion}-sha-${commit}`;
  return {
    releaseTag,
    createTag: false,
    createRelease: false,
    imageTags: [commit],
    chartVersion,
    chartLatestTag: null,
  };
}
