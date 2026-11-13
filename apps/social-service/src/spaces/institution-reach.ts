import { BadRequestException, Logger } from '@nestjs/common';
import { ruleReachesSpaceSql } from './rule-sql';

/**
 * THE REACH AN INSTITUTION CHOOSES FOR EACH POST AND EACH CALENDAR EVENT, ITS WRITE SIDE (owner,
 * 2026-11-10 for posts, 2026-11-13 for events; docs/wiki/backlog.d/institution-post-reach.md and
 * institution-event-reach.md, amending D19 for institutions only).
 *
 * An institution's post or event names the SPACES it targets, among the spaces of the institution's
 * own audience (never wider: the server refuses anything else), and the PUBLIC in them - everyone,
 * the students, or the staff. There is no default: an item filed as an institution without a reach
 * is refused. ONE model for both (owner, 2026-11-13: "the same refusals"): the same codes, the same
 * options statement, the same parser. Who READS such an item is `institutionReachAdmitsUserSql` and
 * the space filter `institutionReachHoldsSpaceSql` inside `postVisibleToUserSql` and
 * `eventVisibleToUserSql` (`spaces/reader-spaces.ts`); this file holds only what a WRITE decides.
 *
 * Every constant here equals `libs/contracts/institution-reach.json`, which the composers and the
 * event form read too (`posts.service.institution-reach.spec.ts` asserts it).
 */

/** Who, in the ticked spaces, reads the post. */
export type InstitutionReachPublic = 'all' | 'students' | 'staff';

/** One ticked space, as `spaces` stores it. */
export interface InstitutionReachSpace {
  formation: string;
  campus: string;
}

/** A reach as the API carries it, in a request and on every served post. */
export interface InstitutionReach {
  spaces: InstitutionReachSpace[];
  public: InstitutionReachPublic;
}

/**
 * The kinds of entity whose posts carry a reach: an institution only (the owner's decision is for
 * institutions, not associations, lists or personal posts). An ALLOWLIST over
 * `CHK_associations_type`: a type added later is refused until it is listed here.
 */
export const INSTITUTION_REACH_ASSOCIATION_TYPES: readonly string[] = ['institution'];

/** The three publics, in the order the composer offers them. */
export const INSTITUTION_REACH_PUBLICS: readonly InstitutionReachPublic[] = [
  'all',
  'students',
  'staff',
];

/** The typed 400 `code`s a reach is refused with, one per cause. */
export const INSTITUTION_REACH_CODES = {
  /** An institution's post published without a reach: the choice is mandatory, at every post. */
  required: 'institution_reach_required',
  /** A reach on a post that cannot carry one: personal, an association's, a list's, a replay. */
  notOffered: 'institution_reach_not_offered',
  /** A reach whose shape is wrong: no space, an unknown public, a space that is not a pair. */
  invalid: 'institution_reach_invalid',
  /** A ticked space the institution's own audience does not reach. */
  outsideAudience: 'institution_reach_outside_audience',
} as const;

/** The upper bound of ticked spaces read from a request - far above the 10 pairs that exist. */
const MAX_REACH_SPACES = 64;

const logger = new Logger('InstitutionReach');

/** Whether a post published as an entity of `type` carries a reach (`null`: a personal post). */
export function institutionReachOffered(type: string | null): boolean {
  return type !== null && INSTITUTION_REACH_ASSOCIATION_TYPES.includes(type);
}

/**
 * THE SPACES AN INSTITUTION MAY TARGET: every space one of association `$1`'s audience rules
 * reaches, campus then formation. The composer's options and the write's ceiling are this ONE
 * statement, so what is offered and what is accepted cannot disagree.
 */
export const INSTITUTION_REACH_OPTIONS_SQL = `SELECT ro_space.formation, ro_space.campus
  FROM spaces ro_space
  WHERE EXISTS (SELECT 1 FROM association_audiences ro_rule
    WHERE ro_rule."associationId" = $1::uuid AND ${ruleReachesSpaceSql('ro_rule', 'ro_space')})
  ORDER BY ro_space.campus, ro_space.formation`;

/** What carries a reach: a post, or a calendar event. Only the refusal's English names it. */
export type InstitutionReachSubject = 'post' | 'event';

/** The noun a refusal's dev-facing message names the item with. */
const SUBJECT_NOUN: Record<InstitutionReachSubject, { a: string; the: string }> = {
  post: { a: 'A post', the: 'a post' },
  event: { a: 'An event', the: 'an event' },
};

/** The minimal query surface the reach needs (a TypeORM manager or repository). */
export interface ReachQueryable {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/** The spaces association `associationId`'s audience reaches ({@link INSTITUTION_REACH_OPTIONS_SQL}). */
export async function institutionReachOptions(
  manager: ReachQueryable,
  associationId: string
): Promise<InstitutionReachSpace[]> {
  const rows = (await manager.query(INSTITUTION_REACH_OPTIONS_SQL, [
    associationId,
  ])) as InstitutionReachSpace[];
  return rows.map((r) => ({ formation: r.formation, campus: r.campus }));
}

/**
 * THE OPTIONS ROUTE'S ONE DECISION, for the composer and the event form alike: the spaces entity
 * `associationId` (of type `associationType`) may target, or `institution_reach_not_offered` (400)
 * when it is not an institution. The caller has already decided WHO may ask (a publisher for a
 * post, a filer of its events for an event).
 */
export async function institutionReachOptionsOffered(
  manager: ReachQueryable,
  associationId: string,
  associationType: string | null,
  subject: InstitutionReachSubject
): Promise<{ spaces: InstitutionReachSpace[] }> {
  if (!institutionReachOffered(associationType)) {
    refuse(
      INSTITUTION_REACH_CODES.notOffered,
      `Only an institution chooses the reach of ${SUBJECT_NOUN[subject].the}.`,
      `options asked of ${associationId.slice(0, 8)} (${subject}), which is not an institution`
    );
  }
  const spaces = await institutionReachOptions(manager, associationId);
  logger.debug(
    `[INSTITUTION_REACH] ${subject} options of ${associationId.slice(0, 8)}: ${spaces.length} space(s)`
  );
  return { spaces };
}

function refuse(code: string, message: string, detail: string): never {
  logger.warn(`[INSTITUTION_REACH] refused (${code}): ${detail}`);
  throw new BadRequestException({ code, message });
}

/**
 * Reads a reach out of an untrusted request body: a public among {@link INSTITUTION_REACH_PUBLICS}
 * and at least one `{formation, campus}` pair of strings. Duplicates are folded; the result is
 * sorted campus then formation, so two equal choices store the same value.
 *
 * @throws BadRequestException `institution_reach_invalid` on any other shape.
 */
export function parseInstitutionReach(raw: unknown): InstitutionReach {
  const invalid = (detail: string): never =>
    refuse(
      INSTITUTION_REACH_CODES.invalid,
      'A reach names at least one space and one public (all, students or staff).',
      detail
    );
  if (!raw || typeof raw !== 'object') return invalid('not an object');
  const { spaces, public: audience } = raw as { spaces?: unknown; public?: unknown };
  if (typeof audience !== 'string' || !INSTITUTION_REACH_PUBLICS.includes(audience as never)) {
    return invalid('unknown public');
  }
  if (!Array.isArray(spaces) || spaces.length === 0 || spaces.length > MAX_REACH_SPACES) {
    return invalid('no space, or too many');
  }
  const seen = new Map<string, InstitutionReachSpace>();
  for (const s of spaces) {
    const { formation, campus } = (s ?? {}) as { formation?: unknown; campus?: unknown };
    if (typeof formation !== 'string' || typeof campus !== 'string') {
      return invalid('a space that is not a {formation, campus} pair');
    }
    seen.set(`${campus}\u0000${formation}`, { formation, campus });
  }
  const sorted = [...seen.values()].sort(
    (a, b) => a.campus.localeCompare(b.campus) || a.formation.localeCompare(b.formation)
  );
  return { spaces: sorted, public: audience as InstitutionReachPublic };
}

/**
 * THE WRITE'S ONE DECISION: the columns a post's reach is stored in, or `undefined` to leave them.
 *
 * - On a CREATE, an institution's post MUST carry a reach (`institution_reach_required`: no
 *   default, the owner's decision), and any other post must not (`institution_reach_not_offered`).
 * - On an EDIT, an absent reach leaves the stored one alone (a client older than the reach never
 *   clears it, and an institution post written before it keeps its whole audience); a present one
 *   replaces it, both ways - narrower or wider - on an institution's post only.
 * - Every ticked space must be one the institution's audience reaches
 *   (`institution_reach_outside_audience`): the institution restricts INSIDE its own audience.
 *
 * @param associationType the type of the post's association, `null` for a personal post.
 */
export async function resolveInstitutionReachWrite(
  manager: ReachQueryable,
  input: {
    mode: 'create' | 'edit';
    associationId: string | null;
    associationType: string | null;
    raw: unknown;
    /** What carries the reach; names the item in a refusal's message. Default `post`. */
    subject?: InstitutionReachSubject;
  }
): Promise<
  { reachPublic: InstitutionReachPublic; reachSpaces: InstitutionReachSpace[] } | undefined
> {
  const noun = SUBJECT_NOUN[input.subject ?? 'post'];
  const offered = institutionReachOffered(input.associationType);
  const absent = input.raw === undefined || input.raw === null;
  if (absent) {
    if (offered && input.mode === 'create') {
      refuse(
        INSTITUTION_REACH_CODES.required,
        `${noun.a} published as an institution names its spaces and its public.`,
        `an institution ${input.subject ?? 'post'} without a reach`
      );
    }
    return undefined;
  }
  if (!offered || !input.associationId) {
    refuse(
      INSTITUTION_REACH_CODES.notOffered,
      `Only an institution chooses the reach of ${noun.the}.`,
      input.associationType === null
        ? `on a personal ${input.subject ?? 'post'}`
        : `on ${noun.the} of an entity of type ${input.associationType}`
    );
  }
  const reach = parseInstitutionReach(input.raw);
  const allowed = new Set(
    (await institutionReachOptions(manager, input.associationId!)).map(
      (s) => `${s.campus}\u0000${s.formation}`
    )
  );
  const outside = reach.spaces.filter((s) => !allowed.has(`${s.campus}\u0000${s.formation}`));
  if (outside.length > 0) {
    refuse(
      INSTITUTION_REACH_CODES.outsideAudience,
      `${noun.a}'s spaces stay inside its institution's audience.`,
      `${outside.length} space(s) outside the audience of ${input.associationId!.slice(0, 8)}`
    );
  }
  logger.debug(
    `[INSTITUTION_REACH] ${input.subject ?? 'post'} ${input.mode}: ${reach.spaces.length} space(s), public ${reach.public}`
  );
  return { reachPublic: reach.public, reachSpaces: reach.spaces };
}

/**
 * Folds a served row's two reach columns into the ONE field the API carries, `reach` (`null` when
 * the item has none), served to every reader so the card can say who the item is for.
 */
export function foldServedReach(out: Record<string, unknown>): void {
  out.reach = servedInstitutionReach(
    out as {
      reachPublic?: InstitutionReachPublic | null;
      reachSpaces?: InstitutionReachSpace[] | null;
    }
  );
  delete out.reachPublic;
  delete out.reachSpaces;
}

/** The served reach of a post or event row: `null` when it carries none. */
export function servedInstitutionReach(row: {
  reachPublic?: InstitutionReachPublic | null;
  reachSpaces?: InstitutionReachSpace[] | null;
}): InstitutionReach | null {
  if (!row.reachPublic || !Array.isArray(row.reachSpaces)) return null;
  return { spaces: row.reachSpaces, public: row.reachPublic };
}
