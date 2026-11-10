/**
 * The data key a social push carries to name the OLDEST app build that can open it. It is read
 * and REMOVED by `MessagingService.sendPushToUser` (it never reaches a device): a token whose device
 * is KNOWN to run an older build is skipped, so no phone is rung for a screen its build answers
 * with a 404 ("X est en live" below the lives floor, social-service `live-client-version.ts`).
 */
export const MIN_APP_VERSION_DATA_KEY = 'minAppVersion';

const CORE = /^(\d+)\.(\d+)\.(\d+)$/;

function core(raw: string): number[] | null {
  const m = CORE.exec(raw.trim().split(/[-+]/, 1)[0]?.trim() ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether a device's reported build (`key_package.deviceAppVersion`) is at least `floor`: `true`,
 * `false`, or `null` when the build is not known (never reported, or unreadable). The caller decides
 * what unknown means; a pre-release suffix is ignored (`1.5.4-alpha.2` is a `1.5.4` build).
 */
export function appVersionAtLeast(
  version: string | null | undefined,
  floor: string
): boolean | null {
  const have = version ? core(version) : null;
  const want = core(floor);
  if (!have || !want) return null;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

/**
 * The HTTP header a client names its build in (`X-Canari-Client-Version`, read lower-case) - the
 * same header social-service reads for the lives and the bell (`common/client-version.ts`).
 */
export const CLIENT_VERSION_HEADER = 'x-canari-client-version';

/**
 * The build a request is assumed to run when it names NONE: every build up to `1.6.9` sends no
 * {@link CLIENT_VERSION_HEADER} to this service (the header joins its calls in `1.6.10`). A fact
 * about the builds, never a setting - the twin of social-service's `HEADERLESS_CLIENT_VERSION`.
 */
export const HEADERLESS_CLIENT_VERSION = '1.6.9';

/**
 * THE KEYS OF `floors` A BUILD KNOWS: every key whose floor (`null` = every admitted build) the
 * build meets. A request that names no build is {@link HEADERLESS_CLIENT_VERSION}; one that names an
 * unreadable build knows only the `null`-floor keys - fail closed. The one implementation for every
 * per-key floor table of this service (today the notification categories).
 */
export function keysKnownBy<K extends string>(
  floors: Readonly<Record<K, string | null>>,
  clientVersion: string | undefined
): K[] {
  const version = clientVersion?.trim() || HEADERLESS_CLIENT_VERSION;
  return (Object.keys(floors) as K[]).filter((key) => {
    const floor = floors[key];
    return floor === null || appVersionAtLeast(version, floor) === true;
  });
}
