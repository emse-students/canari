/**
 * WHERE A RESTORE KEY MAY COME FROM, AND FOR WHICH SITE - two facts this estate already holds
 * (docs/wiki/account-restore.md, "Configuration").
 *
 * - The ORIGIN of an Android credential is `android:apk-key-hash:<base64url(SHA-256 of the signing
 *   certificate)>`. The certificates are the ones `ANDROID_APP_LINK_SHA256` names - the same value
 *   the frontend build writes into `/.well-known/assetlinks.json` - so the site and this service
 *   cannot vouch for different apps.
 * - The RP ID is the host of the estate's canonical name, the FIRST entry of `FRONTEND_URL`.
 *
 * An estate with no fingerprint is UNAVAILABLE, never permissive: there is no origin to accept, so
 * nothing is accepted (fails closed).
 */

/** The parsed configuration, or the reason restore is off on this estate. */
export type RestoreConfig =
  | { available: true; rpId: string; origins: string[] }
  | { available: false; reason: string };

const FINGERPRINT_HEX = /^[0-9A-F]{64}$/;

/**
 * Turns one fingerprint into the origin Android writes into `clientDataJSON`. Accepted exactly as
 * the frontend's `parseAndroidSha256Fingerprints` accepts it - 32 hex bytes, colons optional, any
 * case - because both read the SAME secret. Throws on anything else: a malformed value is a
 * configuration error to see at boot, not an origin that silently never matches.
 */
export function apkKeyHashOrigin(fingerprint: string): string {
  const hex = fingerprint.trim().toUpperCase().replace(/:/g, '');
  if (!FINGERPRINT_HEX.test(hex)) {
    throw new Error(
      `ANDROID_APP_LINK_SHA256: "${fingerprint}" is not a SHA-256 fingerprint (32 hex bytes)`
    );
  }
  const bytes = Buffer.from(hex, 'hex');
  return `android:apk-key-hash:${bytes.toString('base64url')}`;
}

/**
 * Reads the restore configuration from the two variables. Pure, so the boot decision is tested
 * without an environment.
 */
export function readRestoreConfig(
  fingerprints: string | undefined,
  frontendUrl: string | undefined
): RestoreConfig {
  const list = (fingerprints ?? '')
    // Comma- or whitespace-separated, as `parseAndroidSha256Fingerprints` splits it.
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (list.length === 0) {
    return { available: false, reason: 'ANDROID_APP_LINK_SHA256 is empty' };
  }
  const first = (frontendUrl ?? '').split(',')[0]?.trim() ?? '';
  let rpId: string;
  try {
    rpId = new URL(first).hostname;
  } catch {
    return { available: false, reason: `FRONTEND_URL has no usable first entry ("${first}")` };
  }
  if (!rpId) return { available: false, reason: 'FRONTEND_URL names no host' };
  return { available: true, rpId, origins: [...new Set(list.map(apkKeyHashOrigin))] };
}
