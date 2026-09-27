export type AgentRelease = {
  fetchLatestVersion: () => Promise<string>;
  prepareReplacement: (version: string) => Promise<void>;
};

export type AgentUpdateResult = { currentVersion: string; targetVersion: string };

const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function releaseVersionParts(version: string): readonly [number, number, number] | null {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isExactReleaseVersion(version: string): boolean {
  return releaseVersionParts(version) !== null;
}

export function isNewerReleaseVersion(candidateVersion: string, currentVersion: string): boolean {
  const candidateParts = releaseVersionParts(candidateVersion);
  const currentParts = releaseVersionParts(currentVersion);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index]! > currentParts[index]!) return true;
    if (candidateParts[index]! < currentParts[index]!) return false;
  }
  return false;
}
