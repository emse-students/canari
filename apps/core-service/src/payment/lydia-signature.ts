import { createHash, timingSafeEqual } from 'crypto';

/**
 * The ONE shape of every Lydia signature: MD5 of the given `key=value` pairs sorted alphabetically
 * by key, joined with "&", followed by "&" and the private token. Its two callers differ only in how
 * a key and a value are WRITTEN into the pair (docs/wiki/lydia-api.md, section 5b): raw for what
 * Lydia signs, URL-encoded for what Canari sends.
 */
function md5OfSortedPairs(
  fields: Record<string, string>,
  privateToken: string,
  write: (text: string) => string
): string {
  const sortedKeys = Object.keys(fields).sort();
  const pairs = sortedKeys.map((key) => `${write(key)}=${write(fields[key])}`);
  const payload = `${pairs.join('&')}&${privateToken}`;
  return createHash('md5').update(payload).digest('hex');
}

/**
 * Computes a Lydia signature over the RAW values: the signature Lydia puts on what IT sends
 * (`request/do` callbacks, `request/state` answers). Measured raw: every callback carried an
 * `order_ref` with `:` and verified unencoded (sandbox 2026-10-16, production 2026-10-23,
 * docs/wiki/lydia-api.md section 3). It serves verification only - a request Canari SENDS is
 * signed by {@link signLydiaRequest}, and encoding this one would refuse every callback.
 * The field set to sign is call-specific - `fields` must already contain exactly those fields,
 * never the "sig" key itself.
 */
export function signLydiaParams(fields: Record<string, string>, privateToken: string): string {
  return md5OfSortedPairs(fields, privateToken, (text) => text);
}

/**
 * PHP's `urlencode` (RFC 1738): a space becomes `+`, every byte outside `[A-Za-z0-9_.-]` becomes
 * `%XX` in upper case. `encodeURIComponent` leaves `!'()*~` alone and writes a space `%20`, so it is
 * corrected for both.
 */
export function phpUrlencode(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/**
 * Computes the signature of a request Canari SENDS to Lydia (`business/addcashier`,
 * `auth/create_account`, ...): over the URL-ENCODED keys and values, as PHP's `urlencode` /
 * `http_build_query` write them. Measured on homologation 2026-10-30 (docs/wiki/lydia-api.md
 * section 5b): `business/addcashier` signed over the raw values answered `444` every time and
 * passed signed over the encoded ones, with a deliberately wrong signature as the control.
 * The fields are the call's documented signed set; the private token is the one the call names.
 */
export function signLydiaRequest(fields: Record<string, string>, privateToken: string): string {
  return md5OfSortedPairs(fields, privateToken, phpUrlencode);
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
