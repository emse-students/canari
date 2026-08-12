import { createHash, timingSafeEqual } from 'crypto';

/**
 * Computes a Lydia API signature: MD5 of the given fields sorted alphabetically by key, joined as
 * "key=value" pairs with "&", followed by "&" and the business/provider private token.
 * The field set to sign is call-specific (see each endpoint's "signature" parameter description in
 * the Lydia API doc) - `fields` must already contain exactly those fields, never the "sig" key itself.
 */
export function signLydiaParams(fields: Record<string, string>, privateToken: string): string {
  const sortedKeys = Object.keys(fields).sort();
  const pairs = sortedKeys.map((key) => `${key}=${fields[key]}`);
  const payload = `${pairs.join('&')}&${privateToken}`;
  return createHash('md5').update(payload).digest('hex');
}

/** Verifies a signature received from Lydia (webhooks, callbacks) against the expected fields. */
export function verifyLydiaSignature(
  fields: Record<string, string>,
  privateToken: string,
  receivedSignature: string
): boolean {
  const expected = signLydiaParams(fields, privateToken);
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(receivedSignature, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}
