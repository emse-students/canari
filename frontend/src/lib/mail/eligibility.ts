/**
 * WHO MAY USE THE MAIL TAB (owner, 2026-11-27; docs/wiki/mail-client.md D1): an account whose
 * MiConnect address is on one of these domains, EXACTLY (no subdomain). The relay admits a socket
 * on the same list (apps/chat-gateway/src/mail_relay.rs, `MAIL_DOMAINS`); both equal
 * `libs/contracts/mail-domains.json`, which each side's test reads, so the tab and the relay cannot
 * disagree about who is eligible.
 */
export const MAIL_DOMAINS: readonly string[] = ['etu.emse.fr', 'emse.fr'];

/**
 * Whether `domain` is one of {@link MAIL_DOMAINS}, case-insensitively. PURE and silent: the caller
 * that shows or hides the tab logs its decision.
 */
export function isMailEligibleDomain(domain: string | null | undefined): boolean {
  return !!domain && MAIL_DOMAINS.includes(domain.trim().toLowerCase());
}

/**
 * Whether the mailbox `address` is on an eligible domain (D1): the part after its LAST `@`. The
 * mail session refuses an ineligible address before any byte is sent, and re-checks the canonical
 * address the server names once signed in (an alias may differ from the address typed).
 */
export function isMailEligibleAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const at = address.lastIndexOf('@');
  return at > 0 && isMailEligibleDomain(address.slice(at + 1));
}
