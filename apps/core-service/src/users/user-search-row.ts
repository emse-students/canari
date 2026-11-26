import type { CursusEntry } from './miconnect-profile';

/**
 * One row of `GET /users/search`, the answer every person picker reads (D56,
 * profiles-and-access.md). `promo` and `formation` are the person's EARLIEST cursus entry: the pickers
 * show them only to tell two people of the same name apart (`distinguishHomonyms` on the client).
 */
export interface UserSearchRow {
  id: string;
  displayName: string | null;
  promo: number | null;
  formation: string | null;
}

/**
 * The earliest well-formed `cursus` entry (lowest promo, the first on a tie), else the legacy
 * `promo`/`formation` columns a person the WP3 backfill has not reached still carries. Pure and
 * silent on purpose: it runs on every search hit, and `cursusViewsOf` already accuses a malformed or
 * lagging cursus where a price is read - a second accusation per keystroke would only be noise.
 */
export function earliestCursus(user: {
  cursus?: unknown;
  promo?: number | null;
  formation?: string | null;
}): Pick<UserSearchRow, 'promo' | 'formation'> {
  const entries = (Array.isArray(user.cursus) ? (user.cursus as unknown[]) : []).filter(
    (e): e is CursusEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as CursusEntry).formation === 'string' &&
      (e as CursusEntry).formation !== '' &&
      Number.isInteger((e as CursusEntry).promo)
  );
  if (entries.length === 0) {
    return { promo: user.promo ?? null, formation: user.formation ?? null };
  }
  const earliest = entries.reduce((a, b) => (b.promo < a.promo ? b : a));
  return { promo: earliest.promo, formation: earliest.formation };
}
