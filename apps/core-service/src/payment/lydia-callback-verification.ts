import { verifyLydiaSignature } from './lydia-signature';

/**
 * How a `request/do` callback (confirm / cancel / expire) is proven to come from Lydia.
 *
 * MEASURED ON THE SANDBOX, 2026-10-16 (payments.md): the callback is `multipart/form-data` with seven
 * fields - `currency`, `request_id`, `amount`, `signed`, `vendor_token`, `order_ref`, `sig` - and `sig`
 * is `signLydiaParams` over EVERY other received field (`signed` included) with the BUSINESS private
 * token of the Business that issued the request. The Provider private token never verified one.
 *
 * So the signed set is not a list this code chooses: it is whatever arrived, minus `sig`. A field
 * Lydia adds tomorrow is signed with the rest, and a field a forger adds breaks the signature.
 */

/** The field that carries the signature, and the one field never signed. */
export const LYDIA_CALLBACK_SIGNATURE_FIELD = 'sig';

/**
 * Bounds of a body worth verifying. The route is PUBLIC and its JSON/urlencoded bodies are not
 * bounded by multer: Lydia sends seven short fields, so anything far outside that is refused before
 * a key is even looked up (same 400 as a wrong signature - nothing for a prober to tell apart).
 */
export const LYDIA_CALLBACK_MAX_FIELDS = 16;
export const LYDIA_CALLBACK_MAX_VALUE_LENGTH = 512;

/**
 * The fields a callback's signature covers - every received field except `sig` - or `null` when the
 * body cannot be a Lydia callback: a value that is not a string (an object or array from a JSON
 * body), too many fields, or a value too long. Never throws, whatever the sender put in the body.
 */
export function lydiaCallbackSignedFields(
  body: Record<string, unknown> | undefined
): Record<string, string> | null {
  const entries = Object.entries(body ?? {}).filter(
    ([name]) => name !== LYDIA_CALLBACK_SIGNATURE_FIELD
  );
  if (entries.length === 0 || entries.length > LYDIA_CALLBACK_MAX_FIELDS) return null;
  for (const [, value] of entries) {
    if (typeof value !== 'string' || value.length > LYDIA_CALLBACK_MAX_VALUE_LENGTH) return null;
  }
  // fromEntries defines OWN properties, so a sender-chosen `__proto__` name stays a plain key
  // (an assignment would hit the prototype setter and drop it from the signed set).
  return Object.fromEntries(entries as [string, string][]);
}

/** Why a callback was refused - for the server log only; the caller always gets the same 400. */
export type LydiaCallbackRefusal = 'unsignable-body' | 'no-vendor-token' | 'no-key' | 'mismatch';

/** A callback proven to come from the Business named by `vendorToken`, or why it was not. */
export type LydiaCallbackVerdict =
  | { verified: true; vendorToken: string }
  | { verified: false; reason: LydiaCallbackRefusal };

/**
 * Verifies a callback body with the Business private token of the association whose `vendor_token`
 * it names. `fetchBusinessKey` answers that key, or null when no association holds that token or
 * holds no key - two cases deliberately not told apart, here or to the caller.
 *
 * Resolving the key FROM the body is sound because the signature is the proof: a forger may name
 * any association's vendor token, but must then sign with that association's private key.
 * A transport failure of `fetchBusinessKey` propagates: it is not a verdict about the callback.
 */
export async function verifyLydiaCallback(
  body: Record<string, unknown> | undefined,
  fetchBusinessKey: (vendorToken: string) => Promise<string | null>
): Promise<LydiaCallbackVerdict> {
  const fields = lydiaCallbackSignedFields(body);
  const signature = body?.[LYDIA_CALLBACK_SIGNATURE_FIELD];
  if (!fields || typeof signature !== 'string') {
    return { verified: false, reason: 'unsignable-body' };
  }
  const vendorToken = fields.vendor_token;
  if (!vendorToken) return { verified: false, reason: 'no-vendor-token' };
  const key = await fetchBusinessKey(vendorToken);
  if (!key) return { verified: false, reason: 'no-key' };
  if (!verifyLydiaSignature(fields, key, signature)) {
    return { verified: false, reason: 'mismatch' };
  }
  return { verified: true, vendorToken };
}
