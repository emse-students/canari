import { m } from '$lib/paraglide/messages';

/** The campuses MiConnect enrols a person on. Mirrors `core-service` `CAMPUSES`. */
export const CAMPUSES = ['saint-etienne', 'gardanne'] as const;
/** The posts a person may hold, cumulative with a cursus. Mirrors `core-service` `POSTS`. */
export const POSTS = ['EMSE', 'ME', 'ALUMNI'] as const;

export type Campus = (typeof CAMPUSES)[number];
export type Post = (typeof POSTS)[number];

/**
 * The posts that make a person STAFF (owner, 2026-11-24): `EMSE` or `ME`, never `ALUMNI` alone, and
 * independent of a cursus - a person may be a student and staff at once. Mirrors social-service
 * `STAFF_POSTS`, which decides every audience; this copy only shapes what the client offers.
 */
export const STAFF_POSTS: readonly Post[] = ['EMSE', 'ME'];

/** Whether `posts` holds a staff post ({@link STAFF_POSTS}). Absent or empty is not staff. */
export function holdsStaffPost(posts: readonly Post[] | null | undefined): boolean {
  return (posts ?? []).some((p) => STAFF_POSTS.includes(p));
}

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

/** The formations MiConnect knows (D4). Mirrors `social-service` `SPACE_FORMATIONS`. */
export const FORMATIONS = ['ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre'] as const;
export type Formation = (typeof FORMATIONS)[number];

/** The localized name of a formation: the four acronyms stand for themselves, the rest is "Other". */
export function formationLabel(formation: Formation): string {
  return formation === 'Autre' ? m.profile_formation_other() : formation;
}
