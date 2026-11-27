/**
 * Semver PRECEDENCE, the one comparison every client and server gate on a version reads.
 *
 * THIS FILE IS COPIED BYTE FOR BYTE between `frontend/src/lib/utils/semverCompare.ts` and
 * `apps/core-service/src/platform/semver-compare.ts`: there is no shared TypeScript package, and a
 * server that orders `1.8.3-alpha.1` differently from the client that is judged against it is a
 * floor that locks out the wrong builds. The pair is a declared duplicate group
 * (`.github/scripts/lib/declared-duplicates.mjs`) pinned to the same bytes.
 */

/**
 * Splits a version into the numeric core and the pre-release identifiers that decide ties.
 *
 * Build metadata is dropped here and nowhere else: semver gives `+...` no part in precedence, and
 * `deploy-build.ts` is the reason a `+` should never reach this function at all.
 */
function semverParts(version: string): { core: number[]; pre: string[] } {
  const withoutBuild = version.trim().split('+', 1)[0] ?? '';
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  return {
    core: core.split('.').map((n) => parseInt(n, 10) || 0),
    pre: pre ? pre.split('.') : [],
  };
}

/**
 * Compares two semver strings by PRECEDENCE, pre-releases included.
 *
 * WHY THE PRE-RELEASE HALF EXISTS. Until 2026-09-03 every release here was a bare
 * `major.minor.patch`, and this function split on `.` and `parseInt`ed the pieces. The
 * deploy-at-bump model introduced `X.Y.Z-alpha.N` to feed the store tester channels, and that shape
 * broke the naive version IN THE REASSURING DIRECTION: `parseInt('0-alpha')` is `0`, so
 * `0.15.0-alpha.1` read as `[0, 15, 0, 1]` and compared ABOVE its own stable `0.15.0`. A tester
 * would have considered themselves newer than the release they were testing for and never been
 * offered it - a population stuck on a pre-release for ever, with nothing to say so. The same bug
 * made `-alpha.1` and `-beta.1` compare EQUAL, the suffix contributing nothing at all.
 *
 * Semver 2.0.0 precedence, in the order applied: the numeric core; then a version WITH a
 * pre-release ranks BELOW the same core without one; then the identifiers left to right, numeric
 * ones compared numerically, the rest ASCII-lexically, numeric ranking below alphanumeric, and a
 * shorter identifier list losing once every shared identifier is equal.
 *
 * @returns negative if a < b, positive if a > b, else 0
 */
export function compareSemver(a: string, b: string): number {
  const va = semverParts(a);
  const vb = semverParts(b);

  const len = Math.max(va.core.length, vb.core.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  // Equal cores: the one carrying a pre-release is the earlier version.
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;

  const preLen = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < preLen; i++) {
    const ia = va.pre[i];
    const ib = vb.pre[i];
    // Running out of identifiers first is ranking lower - `alpha` precedes `alpha.1`.
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    if (ia === ib) continue;

    const aNumeric = /^\d+$/.test(ia);
    const bNumeric = /^\d+$/.test(ib);
    if (aNumeric && bNumeric) {
      const diff = parseInt(ia, 10) - parseInt(ib, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // A numeric identifier always ranks below an alphanumeric one.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}
