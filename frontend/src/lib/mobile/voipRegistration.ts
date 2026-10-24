/**
 * The `voipToken` field of a push registration (`POST /api/mls/push/register`), the TS half of the
 * native ring on the iPhone (WP-C6, `docs/wiki/frontend/modules/calls.md`).
 *
 * A voipToken on the server is this device's statement that its binary reports EVERY VoIP push to
 * CallKit - Apple terminates an app that does not, and stops delivering VoIP pushes to it. So the
 * field follows {@link import('$lib/features').CALLS_NATIVE_RING_COMPILED}, not the token file:
 *
 * - not an iPhone: nothing (Android rings over FCM, there is no VoIP token);
 * - an iPhone WITHOUT the native ring: `null`, which clears any token the server holds for this
 *   device (`parseVoipTokenField` server-side), so a phone back on a build without the ring is never
 *   sent a VoIP push it cannot honour;
 * - an iPhone WITH the ring and a token: the token;
 * - an iPhone with the ring and no token yet (PushKit has not answered): nothing - the native
 *   `refresh-token` path attaches it when it arrives, and a stored one is left alone.
 */
export function voipRegistrationField(
  platform: 'android' | 'ios',
  nativeRingCompiled: boolean,
  voipToken: string | null
): { voipToken?: string | null } {
  if (platform !== 'ios') return {};
  if (!nativeRingCompiled) return { voipToken: null };
  return voipToken ? { voipToken } : {};
}
