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
