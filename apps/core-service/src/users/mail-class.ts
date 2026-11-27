/**
 * WHO THE MAIL CLIENT IS FOR, AS CANARI STORES IT (owner, 2026-11-27;
 * docs/wiki/mail-client-transport.md#eligibility).
 *
 * MiConnect hands Canari's providers the SCHOOL address of a CAS-created account (claim
 * `school_mail`, its own scope; never the Alumni address). Canari keeps only its CLASS, never the
 * address (charter principle 1): `users.mailClass`, refreshed at every sign-in. The address itself
 * goes to the client in the callback answer, once, to prefill the mail sign-in.
 *
 * The domain -> class table equals `libs/contracts/mail-domains.json` (`mail-class.spec.ts`), the
 * one the MiConnect mapping, the relay and the client are held to as well.
 */

/** A domain that may use the mail client, and the class it gives. Exact domain, lowercase. */
export const MAIL_CLASS_BY_DOMAIN = {
  'etu.emse.fr': 'student',
  'emse.fr': 'staff',
} as const;

/** The class of an account that may use the mail client. `null` (stored NULL) is "not offered". */
export type MailClass = (typeof MAIL_CLASS_BY_DOMAIN)[keyof typeof MAIL_CLASS_BY_DOMAIN];

/** The classes, for a column's or a route's validation. */
export const MAIL_CLASSES: readonly MailClass[] = [...new Set(Object.values(MAIL_CLASS_BY_DOMAIN))];

/**
 * The school address of a `school_mail` claim, normalised, with its class - or `null` when the claim
 * is absent or is not one address on a listed domain (exactly: no subdomain). PURE and silent: the
 * caller logs what it decides, never the address.
 */
export function readSchoolMail(claim: unknown): { address: string; mailClass: MailClass } | null {
  if (typeof claim !== 'string') return null;
  const address = claim.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || /\s/.test(address)) return null;
  const domain = address.slice(at + 1);
  const mailClass = (MAIL_CLASS_BY_DOMAIN as Record<string, MailClass>)[domain];
  return mailClass ? { address, mailClass } : null;
}
