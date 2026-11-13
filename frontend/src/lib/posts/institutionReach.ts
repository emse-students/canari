/**
 * THE REACH OF AN INSTITUTION'S POST, AS THE COMPOSERS OFFER IT (owner, 2026-11-10;
 * docs/wiki/backlog.d/institution-post-reach.md). An institution chooses, for EACH post, the spaces
 * (formation x campus, inside its own audience) and the public (everyone, students, staff) it
 * reaches; nothing is pre-selected and the choice is mandatory. The server decides who reads it in
 * its one visibility predicate, and refuses a reach, typed, anywhere else. Every constant equals
 * `libs/contracts/institution-reach.json`, which the server's spec reads too.
 */

/** The entity types whose posts carry a reach: an institution only. */
export const INSTITUTION_REACH_ASSOCIATION_TYPES: readonly string[] = ['institution'];

/** The three publics, in the order the picker draws them. */
export const INSTITUTION_REACH_PUBLICS = ['all', 'students', 'staff'] as const;

export type InstitutionReachPublic = (typeof INSTITUTION_REACH_PUBLICS)[number];

/** The server's stable code: an institution's post was sent with no reach. */
export const INSTITUTION_REACH_REQUIRED = 'institution_reach_required';
/** The server's stable code: a reach was sent on a post that is not an institution's. */
export const INSTITUTION_REACH_NOT_OFFERED = 'institution_reach_not_offered';
/** The server's stable code: a reach with no space, an unknown space or an unknown public. */
export const INSTITUTION_REACH_INVALID = 'institution_reach_invalid';
/** The server's stable code: a ticked space is outside the institution's audience. */
export const INSTITUTION_REACH_OUTSIDE_AUDIENCE = 'institution_reach_outside_audience';

/** One space as the API names it. */
export interface ReachSpace {
  formation: string;
  campus: string;
}

/** A complete reach, as sent and as served. */
export interface InstitutionReach {
  spaces: ReachSpace[];
  public: InstitutionReachPublic;
}

/** What the picker holds while the author chooses: the public may still be missing. */
export interface InstitutionReachDraft {
  spaces: ReachSpace[];
  public: InstitutionReachPublic | null;
}

/** The empty draft: no space, no public - there is no default (owner, 2026-11-10). */
export function emptyReachDraft(): InstitutionReachDraft {
  return { spaces: [], public: null };
}

/**
 * Whether a post published as an entity of `type` carries a reach. `undefined` (a personal post, or
 * a server older than the served `type`) never does. PURE and silent: it runs in `$derived`s.
 */
export function institutionReachOffered(type: string | null | undefined): boolean {
  return !!type && INSTITUTION_REACH_ASSOCIATION_TYPES.includes(type);
}

/** At least one space and a public: the only draft the composers may send. */
export function isReachComplete(
  reach: InstitutionReachDraft | null | undefined
): reach is InstitutionReach {
  return !!reach && reach.spaces.length > 0 && reach.public !== null;
}

/**
 * The reach as a PLAIN object, ready to leave the component: fresh arrays and objects, never the
 * `$state` proxies the picker mutates. What the publish queue stores goes through IndexedDB's
 * structured clone, which throws `DataCloneError` on a proxy (review of #3314) - so every payload,
 * draft or hand-over to another step is built here, and a later edit of the picker cannot reach it.
 */
export function plainReach(reach: InstitutionReach): InstitutionReach;
export function plainReach(reach: InstitutionReachDraft): InstitutionReachDraft;
export function plainReach(reach: InstitutionReachDraft): InstitutionReachDraft {
  return {
    spaces: reach.spaces.map((s) => ({ formation: s.formation, campus: s.campus })),
    public: reach.public,
  };
}

/** The two spaces are the same pair. */
export function sameSpace(a: ReachSpace, b: ReachSpace): boolean {
  return a.formation === b.formation && a.campus === b.campus;
}

/** The two reaches name the same public and the same set of spaces, whatever their order. */
export function sameReach(
  a: InstitutionReachDraft | null | undefined,
  b: InstitutionReachDraft | null | undefined
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.public === b.public &&
    a.spaces.length === b.spaces.length &&
    a.spaces.every((s) => b.spaces.some((t) => sameSpace(s, t)))
  );
}

/**
 * A draft read back from storage or from a served post, with anything malformed dropped: a public
 * the contract does not name becomes "not chosen", a space without both sides is dropped.
 */
export function reachDraftFrom(value: unknown): InstitutionReachDraft {
  if (!value || typeof value !== 'object') return emptyReachDraft();
  const raw = value as { spaces?: unknown; public?: unknown };
  const spaces = Array.isArray(raw.spaces)
    ? raw.spaces.filter(
        (s): s is ReachSpace =>
          !!s &&
          typeof (s as ReachSpace).formation === 'string' &&
          typeof (s as ReachSpace).campus === 'string'
      )
    : [];
  const pub = INSTITUTION_REACH_PUBLICS.find((p) => p === raw.public) ?? null;
  return { spaces: spaces.map((s) => ({ formation: s.formation, campus: s.campus })), public: pub };
}
