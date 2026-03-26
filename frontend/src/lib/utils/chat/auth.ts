/**
 * PIN utilities for the delivery service / MLS layer.
 * Authentication (JWT) is handled by src/lib/stores/auth.ts via core-service.
 */
export async function computePinVerifier(uid: string, userPin: string): Promise<string> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(userPin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode('canari:' + uid),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
