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

/** The profile of an account MiConnect told us nothing about: every column empty. */
export const EMPTY_PROFILE: MiconnectProfile = {
  miconnectUuid: null,
  campus: null,
  cursus: [],
  posts: [],
};
