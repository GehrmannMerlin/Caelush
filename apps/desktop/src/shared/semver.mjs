const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** @typedef {{ major: bigint, minor: bigint, patch: bigint, prerelease: string[], build: string[] }} ParsedSemVer */

/** @param {unknown} version */
export function isValidSemVer(version) {
  return typeof version === "string" && version.length <= 256 && SEMVER_PATTERN.test(version);
}

/** @param {string} version @returns {ParsedSemVer} */
export function parseSemVer(version) {
  if (!isValidSemVer(version)) throw new TypeError("Invalid SemVer 2.0.0 version.");
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) throw new TypeError("Invalid SemVer 2.0.0 version.");
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
    build: match[5] === undefined ? [] : match[5].split("."),
  };
}

/**
 * Compare SemVer precedence. Build metadata is intentionally ignored, as required by SemVer 2.0.0.
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1}
 */
export function compareSemVer(left, right) {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^(0|[1-9]\d*)$/.test(leftIdentifier);
    const rightNumeric = /^(0|[1-9]\d*)$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const aNumber = BigInt(leftIdentifier);
      const bNumber = BigInt(rightIdentifier);
      if (aNumber < bNumber) return -1;
      if (aNumber > bNumber) return 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

/** @param {string} version */
export function getSemVerPrerelease(version) {
  return parseSemVer(version).prerelease;
}
