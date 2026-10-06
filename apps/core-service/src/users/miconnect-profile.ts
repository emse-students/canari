import { Logger } from '@nestjs/common';

/** The campuses MiConnect enrols a person on (D6: the person's own choice, never deduced). */
export const CAMPUSES = ['saint-etienne', 'gardanne'] as const;
/** The posts a person may hold (D1: cumulative with a cursus). */
export const POSTS = ['EMSE', 'ME', 'ALUMNI'] as const;

export type Campus = (typeof CAMPUSES)[number];
export type Post = (typeof POSTS)[number];

/** One line of a person's schooling: a formation and the year they entered it. */
export interface CursusEntry {
  formation: string;
  promo: number;
}

/** What Canari stores of the MiConnect profile - the four columns the OIDC callback replaces. */
export interface MiconnectProfile {
  miconnectUuid: string | null;
  campus: Campus | null;
  cursus: CursusEntry[];
  posts: Post[];
}

/** The claims authentik emits on scope `profile` for Canari (WP1), all optional by contract. */
export interface MiconnectClaims {
  miconnect_uuid?: unknown;
  campus?: unknown;
  cursus?: unknown;
  posts?: unknown;
}

const logger = new Logger('MiconnectProfile');

/**
 * Reads the profile claims into the stored shape. A claim that is absent or malformed yields the
 * EMPTY value, never the previous one: the caller replaces the columns wholesale, so a claim that
 * disappeared at the provider clears here too (WP3). A malformed ENTRY is dropped with a warning,
 * not guessed at - a value the provider should never send is the provider's defect to see.
 */
export function parseProfileClaims(claims: MiconnectClaims): MiconnectProfile {
  const campus = CAMPUSES.find((c) => c === claims.campus) ?? null;
  if (claims.campus !== undefined && campus === null) {
    logger.warn(`profile claim: unknown campus ${JSON.stringify(claims.campus)} dropped`);
  }

  const cursus: CursusEntry[] = [];
  if (Array.isArray(claims.cursus)) {
    for (const entry of claims.cursus as unknown[]) {
      const e = entry as Partial<CursusEntry> | null;
      if (e && typeof e.formation === 'string' && e.formation && Number.isInteger(e.promo)) {
        cursus.push({ formation: e.formation, promo: e.promo as number });
      } else {
        logger.warn(`profile claim: malformed cursus entry ${JSON.stringify(entry)} dropped`);
      }
    }
  } else if (claims.cursus !== undefined) {
    logger.warn(`profile claim: cursus is not a list (${typeof claims.cursus}), cleared`);
  }

  const posts: Post[] = [];
  if (Array.isArray(claims.posts)) {
    for (const p of claims.posts as unknown[]) {
      const known = POSTS.find((k) => k === p);
      if (known) {
        if (!posts.includes(known)) posts.push(known);
      } else {
        logger.warn(`profile claim: unknown post ${JSON.stringify(p)} dropped`);
      }
    }
  } else if (claims.posts !== undefined) {
    logger.warn(`profile claim: posts is not a list (${typeof claims.posts}), cleared`);
  }

  const miconnectUuid =
    typeof claims.miconnect_uuid === 'string' && claims.miconnect_uuid
      ? claims.miconnect_uuid
      : null;
  return { miconnectUuid, campus, cursus, posts };
}

/**
 * The `promo` / `formation` columns derived from a cursus (WP3): its FIRST entry, null for none.
 * ONE definition, shared by the sign-in upsert and the admin edit, until WP6 moves every consumer
 * onto `cursus` and the columns go.
 */
export function legacyColumns(cursus: CursusEntry[]): {
  promo: number | null;
  formation: string | null;
} {
  return { promo: cursus[0]?.promo ?? null, formation: cursus[0]?.formation ?? null };
}

/** The formations a cursus may name (D4): `Autre` is the one bucket for masters, doctorates, the rest. */
export const FORMATIONS = ['ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre'] as const;

/** The oldest and newest entry year an edit accepts - a typo guard, not a school rule. */
const PROMO_MIN = 1900;
const PROMO_MAX = 2100;
const NAME_MAX = 100;

/**
 * The version-1 profile as authentik stores it in `attributes.profile` and as an edit records it
 * before and after: the five facts an admin may set, with the explicit names (D10).
 */
export interface ProfileSnapshot {
  version: 1;
  campus: Campus;
  cursus: CursusEntry[];
  posts: Post[];
  firstName: string;
  lastName: string;
}

/** One reason an edit was refused, naming the field so the form can show it where it belongs. */
export interface ProfileEditProblem {
  field: 'campus' | 'cursus' | 'posts' | 'firstName' | 'lastName' | 'profile';
  reason: string;
}

/**
 * Validates an admin's edit into the stored shape, or reports EVERY problem at once.
 *
 * It refuses rather than repairs: an unknown formation or post is a typo to show the admin, not a
 * value to drop (the sign-in parser drops, because the provider is the one at fault there). D11
 * is enforced here too - a profile needs a cursus or a post - because this write is the only one
 * authentik's enrolment flow does not guard.
 */
export function validateProfileEdit(
  input: unknown
): { ok: true; profile: ProfileSnapshot } | { ok: false; problems: ProfileEditProblem[] } {
  const problems: ProfileEditProblem[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, problems: [{ field: 'profile', reason: 'not an object' }] };
  }
  const body = input as Record<string, unknown>;

  const campus = CAMPUSES.find((c) => c === body.campus);
  if (!campus) problems.push({ field: 'campus', reason: 'unknown campus' });

  const cursus: CursusEntry[] = [];
  if (!Array.isArray(body.cursus)) {
    problems.push({ field: 'cursus', reason: 'not a list' });
  } else {
    for (const entry of body.cursus as unknown[]) {
      const e = entry as Partial<CursusEntry> | null;
      const formation = FORMATIONS.find((f) => f === e?.formation);
      const promo = e?.promo;
      if (
        !formation ||
        !Number.isInteger(promo) ||
        (promo as number) < PROMO_MIN ||
        (promo as number) > PROMO_MAX
      ) {
        problems.push({ field: 'cursus', reason: 'unknown formation or impossible entry year' });
      } else {
        cursus.push({ formation, promo: promo as number });
      }
    }
  }

  const posts: Post[] = [];
  if (!Array.isArray(body.posts)) {
    problems.push({ field: 'posts', reason: 'not a list' });
  } else {
    for (const p of body.posts as unknown[]) {
      const known = POSTS.find((k) => k === p);
      if (!known) problems.push({ field: 'posts', reason: 'unknown post' });
      else if (!posts.includes(known)) posts.push(known);
    }
  }

  // Only when nothing above already explains the emptiness: a list of typos is not "none".
  if (!problems.length && !cursus.length && !posts.length) {
    problems.push({ field: 'profile', reason: 'a profile needs a cursus or a post' });
  }

  const names: Record<'firstName' | 'lastName', string> = { firstName: '', lastName: '' };
  for (const key of ['firstName', 'lastName'] as const) {
    const value = typeof body[key] === 'string' ? (body[key] as string).trim() : '';
    if (!value || value.length > NAME_MAX) {
      problems.push({ field: key, reason: `required, at most ${NAME_MAX} characters` });
    }
    names[key] = value;
  }

  if (problems.length || !campus) return { ok: false, problems };
  return {
    ok: true,
    profile: { version: 1, campus, cursus, posts, ...names },
  };
}

/** The profile of an account MiConnect told us nothing about: every column empty. */
export const EMPTY_PROFILE: MiconnectProfile = {
  miconnectUuid: null,
  campus: null,
  cursus: [],
  posts: [],
};
