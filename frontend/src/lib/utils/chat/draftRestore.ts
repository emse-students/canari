/**
 * What the composer holds after a send was REFUSED (WP-OFF-1).
 *
 * The composer is emptied synchronously on click, so a community-salon message the server never
 * took (offline, 5xx) used to be gone for good: no bubble, no queue, no text. The failed text goes
 * back where it came from. If the member has already typed something new meanwhile, the failed text
 * is put in FRONT of it rather than over it, so neither is lost.
 *
 * @param current What the composer holds now.
 * @param failed The text whose send was refused.
 */
export function restoreFailedDraft(current: string, failed: string): string {
  if (!current.trim()) return failed;
  if (current.includes(failed)) return current;
  return `${failed}\n${current}`;
}
