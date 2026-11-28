/**
 * WHO MAY USE THE MAIL TAB (owner, 2026-11-27; docs/wiki/mail-client-transport.md#eligibility): an
 * account MiConnect hands a SCHOOL address for (claim `school_mail`, CAS accounts only), on one of
 * these domains EXACTLY (no subdomain). core-service stores the CLASS at sign-in and the relay admits
 * a socket on it (apps/chat-gateway/src/mail_relay.rs, `MAIL_CLASSES`); every side equals
 * `libs/contracts/mail-domains.json`, which each side's test reads, so the tab, core-service and the
 * relay cannot disagree about who is eligible.
 */
export const MAIL_CLASS_BY_DOMAIN: Readonly<Record<string, MailClass>> = {
  'etu.emse.fr': 'student',
  'emse.fr': 'staff',
};

/** The class of a school address: what the relay admits on, and all the server keeps of it. */
export type MailClass = 'student' | 'staff';

/**
 * THE ONE NORMALISATION OF A MAILBOX ADDRESS: trimmed, lower case. The session's comparison, the
 * cursor file and the Android native watcher (`nativeAddress` in `NativeMailWatch.kt`, the same
 * rule) all go through it, so a spelling never makes two mailboxes of one.
 */
export function normalizeMailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The class of `address` (`local@domain`, case-insensitive), or `null` when it is not ONE school
 * address: exactly one `@`, a local part, no whitespace, a listed domain exactly - the rule of the
 * MiConnect mapping and of core-service's `readSchoolMail`. PURE and silent: the caller logs its
 * decision, and never the address.
 */
export function mailClassOf(address: string | null | undefined): MailClass | null {
  const normalized = normalizeMailAddress(address ?? '');
  const at = normalized.indexOf('@');
  if (at <= 0 || normalized.indexOf('@', at + 1) !== -1 || /\s/.test(normalized)) return null;
  return MAIL_CLASS_BY_DOMAIN[normalized.slice(at + 1)] ?? null;
}
