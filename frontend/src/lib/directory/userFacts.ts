/**
 * The facts a person's row states under their name - each cursus entry, each post, the campus - in
 * that order. ONE list for the directory's row and the universal search's Personnes section, so a
 * person reads the same in both.
 */
import type { DirectoryUserRow } from '$lib/profile/api';
import { campusLabel, postLabel } from '$lib/profile/miconnectProfile';
import { m } from '$lib/paraglide/messages';

export function directoryUserFacts(
  user: Pick<DirectoryUserRow, 'cursus' | 'posts' | 'campus'>
): string[] {
  return [
    ...user.cursus.map((c) => `${c.formation} ${m.directory_user_promo({ year: c.promo })}`),
    ...user.posts.map((p) => postLabel(p)),
    ...(user.campus ? [campusLabel(user.campus)] : []),
  ];
}
