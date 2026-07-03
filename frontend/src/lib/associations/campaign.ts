/**
 * A promo list is "campaigning for" the mandate that starts the summer of its
 * `promo` year. Its active window ends on 1 August of that year: after that the
 * mandate has begun and the list belongs to the past (it should drop out of
 * "Mes associations" and instead be recorded under the associative history).
 *
 * Shared by Canari (profile) and mirrored in Sky so both use the same rule.
 */
export function isPastCampaignList(
  entity: { type?: string | null; promo?: number | null },
  now: Date = new Date()
): boolean {
  if (entity.type !== 'list' || entity.promo == null) return false;
  // 1 August of the promo year, 00:00 UTC (close enough to the Europe/Paris cutoff).
  const cutoff = new Date(Date.UTC(entity.promo, 7, 1));
  return now.getTime() >= cutoff.getTime();
}
