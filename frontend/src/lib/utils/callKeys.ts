/** Bytes of the SHA-256 digest a fingerprint keeps: enough to compare two logs, nothing to attack. */
const FINGERPRINT_BYTES = 4;

/**
 * A log-safe fingerprint of a call's media key: the first 4 bytes of its SHA-256, in hex.
 *
 * WHY A HASH. The call log used to print the first 4 bytes of the KEY ITSELF, and the in-app log
 * is exported by users and pasted into reports - so key material left the device in plain text
 * (owed by the review of #1997, docs/wiki/frontend/modules/calls.md). Two devices' exported logs
 * still compare - same key, same fingerprint - and a fingerprint reveals nothing of the key.
 *
 * The hex is spelled here rather than imported from `utils/hex.ts`, whose module drags the device
 * key gate and the MLS state store into anything that imports it.
 */
export async function keyFingerprint(key: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key as BufferSource));
  return Array.from(digest.slice(0, FINGERPRINT_BYTES), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}
