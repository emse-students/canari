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
