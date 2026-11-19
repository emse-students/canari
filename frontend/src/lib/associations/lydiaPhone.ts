/**
 * Normalises a phone typed by a person to E.164, or `null` when it is neither a French national
 * number (`06 12 34 56 78`: `0` + 9 digits) nor an international one (`+` + 8 to 15 digits).
 * Spaces, dots, dashes and parentheses are ignored. Nothing is guessed: `null` means "ask again".
 */
export function toE164Phone(raw: string): string | null {
  const compact = raw.replace(/[\s.\-()]/g, '');
  if (/^0\d{9}$/.test(compact)) return `+33${compact.slice(1)}`;
  // `+33 0 6...`: the French trunk 0 kept after the country code. E.164 has none, and the servers
  // refuse it, so the one spelling of that line is sent.
  if (/^\+330\d{9}$/.test(compact)) return `+33${compact.slice(4)}`;
  if (compact.startsWith('+330')) return null;
  if (/^\+\d{8,15}$/.test(compact)) return compact;
  return null;
}
