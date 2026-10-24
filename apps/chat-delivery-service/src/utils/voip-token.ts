/**
 * What a push registration says about the device's PushKit VoIP token (the native ring, WP-C6).
 *
 * A voipToken on a `push_token` row is the device's statement that its binary carries the native
 * ring and reports every VoIP push to CallKit - Apple terminates an app that does not, and stops
 * delivering VoIP pushes to it. So the field has THREE meanings, never two:
 *
 * - a non-empty string: the token to ring through (bounded to the column's 255);
 * - `null`: this binary has NO native ring (`CALLS_NATIVE_RING_COMPILED` off) - any stored token
 *   is cleared, so a phone that went back to a build without the ring is never sent a VoIP push;
 * - absent (or anything else): the device said nothing - an older client, or a ring build whose
 *   PushKit has not delivered its token yet (it follows over `refresh-token`) - and the stored
 *   value is left alone.
 *
 * @returns the token, `null` to clear, or `undefined` to leave the column as it is.
 */
export function parseVoipTokenField(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 255);
  return undefined;
}
