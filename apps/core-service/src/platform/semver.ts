/** Shape a client version must have to be compared at all. */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Compares two `major.minor.patch` strings.
 *
 * The frontend carries the same function (`utils/appVersion.ts`) because there is no build seam
 * between the SvelteKit bundle and the Nest build: this repo has no shared TypeScript package. It
 * had one, `libs/shared-ts`, which nothing imported; it was deleted on 2026-08-27. Both copies are
 * pure arithmetic over the same three integers and both are pinned by tests. A THIRD copy is the
 * signal to create a shared package deliberately, not to copy again.
 *
 * @returns negative if a < b, positive if a > b, else 0
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether `version` falls inside an inclusive `[min, max]` range, either bound optional.
 *
 * **With NO bound at all the version is never read**, and that is the load-bearing case rather than
 * a shortcut: every client already deployed sends no version, so a range-free announcement has to
 * reach them or the feature ships addressed at nobody. Nothing is being filtered, so there is
 * nothing an unreadable version could disqualify.
 *
 * Once a bound EXISTS, an unreadable or missing version is OUT. The bound is there to keep an
 * announcement away from clients it does not describe, and a client that cannot say what it is
 * cannot be claimed to belong. It is not an error either - the caller simply has nothing to show.
 */
export function versionInRange(version: string, min: string | null, max: string | null): boolean {
  if (!min && !max) return true;
  const v = version.trim();
  if (!SEMVER_PATTERN.test(v)) return false;
  if (min && compareSemver(v, min) < 0) return false;
  if (max && compareSemver(v, max) > 0) return false;
  return true;
}
