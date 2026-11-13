/**
 * THE BUILD A CLIENT NAMES, AND THE ONE COMPARISON EVERY FLOOR IN THIS SERVICE MAKES.
 *
 * A client names its build in one header, {@link CLIENT_VERSION_HEADER}. The lives calls send it
 * since `1.5.4` (`live-client-version.ts`) and the notifications read since `1.6.10`
 * (`notification-client-floor.ts`): a floor is "the first build that can use this", and the
 * comparison below is the only spelling of it here. chat-delivery compares a device's REGISTERED
 * build the same way (`app-version.ts` there), so the two services agree on what `1.6.10-alpha.2`
 * is: a `1.6.10` build - the pre-release suffix is ignored, and so is build metadata.
 */

/** The header a client names its build in (`X-Canari-Client-Version`, lower-cased as Node reads it). */
export const CLIENT_VERSION_HEADER = 'x-canari-client-version';

const CORE = /^(\d+)\.(\d+)\.(\d+)$/;

/** `major.minor.patch` of a version, or `null` when it is not one (absent, `latest`, `1.5`). */
function core(raw: string | null | undefined): number[] | null {
  const m = CORE.exec(((raw ?? '').trim().split(/[-+]/, 1)[0] ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The header's value as one string: Node hands a repeated header as a list, the first one counts. */
export function clientVersionOf(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Whether `version` is at least `floor`: `true`, `false`, or `null` when `version` is not a version
 * (absent or unreadable) - the CALLER decides what an unknown build means, because the lives guard
 * and the notifications read answer it differently. A `floor` that is not a version is a programming
 * error, and throws.
 */
export function clientVersionAtLeast(
  version: string | null | undefined,
  floor: string
): boolean | null {
  const want = core(floor);
  if (!want) throw new Error(`clientVersionAtLeast: the floor "${floor}" is not a version`);
  const have = core(version);
  if (!have) return null;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}
