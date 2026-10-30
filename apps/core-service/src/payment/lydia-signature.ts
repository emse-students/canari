import { createHash, timingSafeEqual } from 'crypto';

/**
 * Computes a Lydia API signature: MD5 of the given fields sorted alphabetically by key, joined as
 * "key=value" pairs with "&", followed by "&" and the business/provider private token.
 * The field set to sign is call-specific (see each endpoint's "signature" parameter description in
 * the Lydia API doc) - `fields` must already contain exactly those fields, never the "sig" key itself.
 *
 * The values are joined RAW, because this verifies what LYDIA signs: its callbacks are signed over
 * the raw values (an `order_ref` with `:` verified that way on the sandbox and in production). A
 * request Canari SENDS is checked by Lydia over the URL-ENCODED values instead (PHP `urlencode`,
 * measured 2026-10-30), so it must not be signed with this as-is - see docs/wiki/lydia-api.md
 * section 5b. No outgoing call is signed today.
 */
export function signLydiaParams(fields: Record<string, string>, privateToken: string): string {
  const sortedKeys = Object.keys(fields).sort();
  const pairs = sortedKeys.map((key) => `${key}=${fields[key]}`);
  const payload = `${pairs.join('&')}&${privateToken}`;
  return createHash('md5').update(payload).digest('hex');
}

/**
 * The shape of an MD5 signature: exactly 32 hex digits. Checked BEFORE decoding, because
 * `Buffer.from(value, 'hex')` stops at the first non-hex character and keeps what it read: a
 * correct signature followed by junk (`<32 hex>zz`, `<32 hex>
`) used to decode to the same 16
 * bytes and verify.
 */
export const LYDIA_SIGNATURE_RE = /^[0-9a-f]{32}$/i;

/**
 * Verifies a signature received from Lydia (callbacks, `request/state` answers) against the
 * expected fields. A received value that is not exactly 32 hex digits is refused before any
 * comparison; the comparison itself is constant-time.
 */
export function verifyLydiaSignature(
  fields: Record<string, string>,
  privateToken: string,
  receivedSignature: string
): boolean {
  if (typeof receivedSignature !== 'string' || !LYDIA_SIGNATURE_RE.test(receivedSignature)) {
    return false;
  }
  const expectedBuf = Buffer.from(signLydiaParams(fields, privateToken), 'hex');
  const receivedBuf = Buffer.from(receivedSignature, 'hex');
  return timingSafeEqual(expectedBuf, receivedBuf);
}
