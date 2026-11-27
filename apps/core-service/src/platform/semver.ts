import { compareSemver } from './semver-compare';

export { compareSemver };

/** Shape a client version must have to be compared at all. */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Shape of a CLIENT FLOOR (`minClientVersion`): `major.minor.patch`, optionally followed by an
 * `-alpha.N` pre-release. A pre-release orders BELOW its stable, so a floor naming the first ALPHA
 * that shipped a reader (`1.8.3-alpha.1`) admits every build from that alpha on, while a floor of
 * the bare `1.8.3` would lock out the estate's own pre-release builds. Only `alpha.N` is accepted
 * (the one shape `release_kind()` cuts), with no leading zero on N, so a typo cannot slip in as a
 * floor nobody can satisfy.
 */
export const FLOOR_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-alpha\.(?:0|[1-9]\d*))?$/;

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
