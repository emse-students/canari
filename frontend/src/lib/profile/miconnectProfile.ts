import { m } from '$lib/paraglide/messages';

/** The campuses MiConnect enrols a person on. Mirrors `core-service` `CAMPUSES`. */
export const CAMPUSES = ['saint-etienne', 'gardanne'] as const;
/** The posts a person may hold, cumulative with a cursus. Mirrors `core-service` `POSTS`. */
export const POSTS = ['EMSE', 'ME', 'ALUMNI'] as const;

export type Campus = (typeof CAMPUSES)[number];
export type Post = (typeof POSTS)[number];

/** One line of a person's schooling: a formation and the year they entered it. */
export interface CursusEntry {
  formation: string;
  promo: number;
}

/** The localized name of a campus. */
export function campusLabel(campus: Campus): string {
  return campus === 'gardanne' ? m.profile_campus_gardanne() : m.profile_campus_saint_etienne();
}

/** The localized name of a post. */
export function postLabel(post: Post): string {
  switch (post) {
    case 'EMSE':
      return m.profile_post_emse();
    case 'ME':
      return m.profile_post_me();
    case 'ALUMNI':
      return m.profile_post_alumni();
  }
}
