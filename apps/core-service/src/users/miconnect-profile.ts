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
  /**
   * Whether the MiConnect account holds the Alumni link (claim `alumni_linked`, D44). `null` is
   * UNKNOWN - a provider that does not emit the claim yet - and never reads as "not linked": the
   * reminder banner shows only on an explicit `false`.
   */
  alumniLinked: boolean | null;
}

/** The claims authentik emits on scope `profile` for Canari (WP1), all optional by contract. */
export interface MiconnectClaims {
  miconnect_uuid?: unknown;
  campus?: unknown;
  cursus?: unknown;
  posts?: unknown;
  alumni_linked?: unknown;
}

const logger = new Logger('MiconnectProfile');

/**
 * Reads the profile claims into the stored shape. A claim that is absent or malformed yields the
 * EMPTY value, never the previous one: the caller replaces the columns wholesale, so a claim that
 * disappeared at the provider clears here too (WP3). A malformed ENTRY is dropped with a warning,
 * not guessed at - a value the provider should never send is the provider's defect to see. A
 * well-formed cursus entry whose FORMATION no space names is kept and said (see below).
 *
 * @param who - A short label of the account for the warnings (never the full id).
 */
export function parseProfileClaims(claims: MiconnectClaims, who = 'an account'): MiconnectProfile {
  const campus = CAMPUSES.find((c) => c === claims.campus) ?? null;
  if (claims.campus !== undefined && campus === null) {
    logger.warn(`profile claim: unknown campus ${JSON.stringify(claims.campus)} dropped`);
  }

  const cursus: CursusEntry[] = [];
  if (Array.isArray(claims.cursus)) {
    for (const entry of claims.cursus as unknown[]) {
      const e = entry as Partial<CursusEntry> | null;
      if (e && typeof e.formation === 'string' && e.formation && Number.isInteger(e.promo)) {
        // A FORMATION NO SPACE NAMES ('icm', a value the provider gained before Canari did) IS
        // KEPT, AND SAID (owner, 2026-11-14: "L'ignorer et alerter"). Kept, because the entry is
        // what tells a student from staff: dropping it would leave a campus and an empty cursus,
        // which is the definition of staff - and hand the person the staff public and the whole
        // campus agenda. Ignored, because it matches no space (`isReaderSpaceSql` is an exact
        // containment). Said, because until now such a person had no space and nothing told why.
        if (!FORMATIONS.some((f) => f === e.formation)) {
          logger.warn(
            `[UNKNOWN_FORMATION] ${who}: cursus formation ${JSON.stringify(e.formation)} matches no space - kept, opens nothing`
          );
        }
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
  const alumniLinked = typeof claims.alumni_linked === 'boolean' ? claims.alumni_linked : null;
  if (claims.alumni_linked !== undefined && alumniLinked === null) {
    logger.warn(
      `profile claim: alumni_linked is not a boolean (${typeof claims.alumni_linked}), read as unknown`
    );
  }
  return { miconnectUuid, campus, cursus, posts, alumniLinked };
}

/**
 * Whether two cursus lists say the same thing, field by field. NOT `JSON.stringify`: the column is
 * `jsonb`, which hands its keys back in its own order (shorter first), so a stored entry and the
 * same entry freshly parsed from the claims stringify differently and every sign-in read as a
 * profile change - a log line and an `UPDATE` that changed nothing.
 */
export function sameCursus(a: CursusEntry[], b: CursusEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => e.formation === b[i].formation && e.promo === b[i].promo)
  );
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

/** One cursus as a price, a question or an audience reads it: promo and formation of ONE entry. */
export interface CursusView {
  promo: number | null;
  formation: string | null;
}

/**
 * The stable tag of the line saying a person's legacy `promo`/`formation` columns name a pair that
 * no cursus entry carries (the WP3 backfill not applied to them, no sign-in since). Its RATE is what
 * says when the columns can go (`legacy-compatibility.md`).
 */
export const PROFILE_CURSUS_BEHIND = '[PROFILE_CURSUS_BEHIND]';

/**
 * EVERY cursus a person is priced, shown questions and admitted through (D32), built in ONE place
 * for social-service (`internal/users/:id/public-profile`):
 *
 * - every WELL-FORMED entry of `users.cursus` (formation a non-empty string, promo an integer), in
 *   order. A `cursus` that is not a list counts as none (ERROR: the column is `jsonb NOT NULL` of a
 *   list, so this is a write that broke it); a malformed entry is dropped (WARN);
 * - PLUS the legacy pair (`users.promo`, `users.formation`) when either is set and that exact pair is
 *   not among the entries. D32 ONLY EVER ADDS: the legacy pair is exactly what every price read
 *   before it, so nobody is priced higher or closed out more than before - a person the WP3
 *   backfill has not reached keeps their price. Logged WARN under `PROFILE_CURSUS_BEHIND`. This
 *   shim goes with the columns (WP6; `legacy-compatibility.md`).
 *
 * Empty for a person with neither (staff, a post only): social-service reads that as one view with
 * nothing in it.
 */
export function cursusViewsOf(user: {
  id: string;
  cursus?: unknown;
  promo?: number | null;
  formation?: string | null;
}): CursusView[] {
  const views: CursusView[] = [];
  if (Array.isArray(user.cursus)) {
    for (const entry of user.cursus as unknown[]) {
      const e = entry as Partial<CursusEntry> | null;
      if (
        e &&
        typeof e === 'object' &&
        typeof e.formation === 'string' &&
        e.formation &&
        Number.isInteger(e.promo)
      ) {
        views.push({ promo: e.promo as number, formation: e.formation });
      } else {
        logger.warn(
          `cursus views: malformed cursus entry dropped user=${user.id.slice(0, 8)} ` +
            JSON.stringify(entry)
        );
      }
    }
  } else {
    logger.error(
      `cursus views: cursus is not a list (${user.cursus === null ? 'null' : typeof user.cursus}) ` +
        `user=${user.id.slice(0, 8)} - read as none`
    );
  }
  const promo = user.promo ?? null;
  const formation = user.formation ?? null;
  const legacyAmong = views.some((v) => v.promo === promo && v.formation === formation);
  if ((promo !== null || formation !== null) && !legacyAmong) {
    logger.warn(
      `${PROFILE_CURSUS_BEHIND} user=${user.id.slice(0, 8)} legacy promo=${promo ?? 'null'} ` +
        `formation=${formation ?? 'null'} is in no cursus entry (${views.length} entr` +
        `${views.length === 1 ? 'y' : 'ies'}) - added as a view`
    );
    views.push({ promo, formation });
  }
  return views;
}

/** The formations a cursus may name (D4): `Autre` is the one bucket for masters, doctorates, the rest. */
export const FORMATIONS = ['ICM', 'ISMIN', 'FISA', 'PDIS', 'Autre'] as const;

/** The oldest and newest entry year an edit accepts - a typo guard, not a school rule. */
const PROMO_MIN = 1900;
const PROMO_MAX = 2100;
/** The longest first or last name an edit accepts; MiConnect's write flow allows two and a space. */
export const NAME_MAX = 100;

/** The most cursus entries an edit accepts, so the biggest valid edit fits MiConnect's write cap. */
export const CURSUS_MAX = 20;

/**
 * Whether `value` holds a control character, as MiConnect's write policy defines one (80-profile-editor.yaml,
 * `is_control`): C0, DEL, C1 and the two Unicode line separators. A name holding one is refused
 * HERE, as a field problem, rather than by MiConnect as a malformed write.
 */
export function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

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
  } else if (body.cursus.length > CURSUS_MAX) {
    problems.push({ field: 'cursus', reason: `at most ${CURSUS_MAX} entries` });
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
    } else if (hasControlCharacter(value)) {
      problems.push({ field: key, reason: 'holds a control character or a line break' });
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
  alumniLinked: null,
};
