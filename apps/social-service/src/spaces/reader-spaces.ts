import { acceptedFollowSql } from '../follows/follow-status';
import { inReviewCohortSql, isInReviewCohort } from '../review-cohort';
import { ruleReachesSpaceSql } from './rule-sql';
import type { SpaceCampus, SpaceFormation } from './space.entity';

/**
 * WHO SEES WHAT, STATED ONCE: the readers of spaces (WP6b, docs/wiki/profiles-and-access.md).
 *
 * A reader's SPACES are the formation x campus pairs whose formation is one of their cursus
 * formations and whose campus is their campus (D16). No campus or no cursus is no space at all.
 * Every server read that serves a post, an event or an announcement asks the SQL below, and the
 * pure `readerSpaces` is its twin - `reader-spaces.integration.spec.ts` runs both against a real
 * PostgreSQL and fails the day they disagree.
 *
 * Why fragments and not a view: `users` belongs to core-service's migrations, and a view over it
 * would be a schema object of this service pinned onto that table - a core migration altering
 * `cursus` would then fail on a dependency it cannot see. A fragment costs nothing to the schema
 * and every caller still states the rule by naming the one function that holds it.
 *
 * A REVIEW ACCOUNT HAS NO SPACE, WHATEVER ITS PROFILE (`review-cohort.ts`, 2026-10-31): the store
 * reviewers' accounts share a world of their own - the cohort counts as ONE space among themselves
 * (`sharesSpaceWithAuthorSql`, the feed gate) and reaches no real one (`isReaderSpaceSql`). So a
 * reviewer reads only what the cohort writes, and a member never reads it, without anybody having
 * to keep the cohort's profiles empty.
 *
 * EVERY FRAGMENT IS PARENTHESISED, because each is meant to be combined with `AND`: the gate this
 * module replaces recorded what an unparenthesised `OR` did (it admitted every admin row, whoever
 * asked).
 */

/** A space as the readers need it: the pair. */
export interface SpacePair {
  formation: SpaceFormation;
  campus: SpaceCampus;
}

/** The two profile facts spaces are computed from, as `users` stores them (WP3). */
export interface ReaderProfile {
  /** The reader's id, when known: a review account has no space, whatever its profile. */
  id?: string;
  campus: string | null;
  /** jsonb `[{formation, promo}]`; anything that is not an array is no cursus. */
  cursus: unknown;
}

/**
 * The spaces a reader belongs to, among `spaces` (every pair the `spaces` table holds).
 *
 * Global admins are not special here - they see everything through the visibility predicate, not
 * through spaces they do not have.
 */
export function readerSpaces(user: ReaderProfile, spaces: readonly SpacePair[]): SpacePair[] {
  if (isInReviewCohort(user.id)) return [];
  if (!user.campus || !Array.isArray(user.cursus)) return [];
  const formations = new Set(
    (user.cursus as unknown[])
      .map((entry) =>
        entry && typeof entry === 'object' ? (entry as { formation?: unknown }).formation : null
      )
      .filter((f): f is string => typeof f === 'string')
  );
  return spaces.filter((s) => s.campus === user.campus && formations.has(s.formation));
}

/**
 * The campus whose agenda a reader tied to NO formation may follow whole (user, 2026-10-07: EMSE
 * staff have a campus and an empty cursus, so they have no space, yet the agenda is theirs too).
 * `null` for anyone else: no campus, or a cursus with at least one entry (a student keeps the
 * own-spaces rule, whether or not a space exists for that entry).
 */
export function campusWideReaderCampus(user: ReaderProfile): string | null {
  if (isInReviewCohort(user.id)) return null;
  if (!user.campus) return null;
  if (user.cursus === null || user.cursus === undefined) return user.campus;
  return Array.isArray(user.cursus) && user.cursus.length === 0 ? user.campus : null;
}

// ── SQL ─────────────────────────────────────────────────────────────────────────────────────────
// Every helper takes the SQL ALIASES it is spliced against (a `users` row, a `spaces` row, a rule
// row) and uses its own inner aliases, each distinct, so nesting never shadows a name.

/**
 * Space row `space` is one of user row `user`'s spaces. Containment (`@>`) rather than
 * `jsonb_array_elements`: a malformed `cursus` (not an array) simply contains nothing, where the
 * function would raise and take every reader's query down with one bad row. A review account has
 * none (`review-cohort.ts`).
 */
export function isReaderSpaceSql(space: string, user: string): string {
  return `(${space}.campus = ${user}.campus AND ${user}.cursus @> jsonb_build_array(jsonb_build_object('formation', ${space}.formation)) AND NOT ${inReviewCohortSql(`${user}.id`)})`;
}

/**
 * A further condition on the SPACE through which an association's rules (or a read grant) reach a
 * reader: a function of the `spaces` alias, answering a SQL boolean. `postVisibleToUserSql` passes
 * the post's own reach (`institutionReachHoldsSpaceSql`, owner 2026-11-10), so an institution's post reaches
 * only the spaces it ticked, inside the institution's audience. Absent: every space the rules reach.
 */
export type SpaceFilter = (space: string) => string;

/** `AND <filter(space)>`, or nothing without a filter. */
function andSpaceFilter(filter: SpaceFilter | undefined, space: string): string {
  return filter ? `\n    AND ${filter(space)}` : '';
}

/** Rule row `rule` reaches at least one space of user row `user` (that `spaceFilter` keeps). */
function ruleReachesUserSql(rule: string, user: string, spaceFilter?: SpaceFilter): string {
  return `EXISTS (SELECT 1 FROM spaces rs_space WHERE ${isReaderSpaceSql('rs_space', user)}
    AND ${ruleReachesSpaceSql(rule, 'rs_space')}${andSpaceFilter(spaceFilter, 'rs_space')})`;
}

/** User row `user` is a member of association `association` (an id expression). Any row counts. */
export function isMemberSql(association: string, user: string): string {
  return `EXISTS (SELECT 1 FROM association_members vis_member
    WHERE vis_member."associationId" = ${association} AND vis_member."userId" = ${user}.id)`;
}

/** The association's own rules (its ceiling) reach user row `user`, through a space `spaceFilter` keeps. */
function associationRulesReachUserSql(
  association: string,
  user: string,
  spaceFilter?: SpaceFilter
): string {
  return `EXISTS (SELECT 1 FROM association_audiences vis_arule
    WHERE vis_arule."associationId" = ${association} AND ${ruleReachesUserSql('vis_arule', user, spaceFilter)})`;
}

/** User row `user` is a global admin. */
function isAdminSql(user: string): string {
  return `COALESCE(${user}.admin, false)`;
}

/**
 * NOMINATIVE READ ACCESS (WP7, D24): user row `user` holds a read grant whose cell contains a space
 * that one of association `association`'s rules reaches. A cell is (campus, formation) with a NULL
 * formation meaning the whole campus; it contains the OPEN spaces it matches, so the answer follows
 * `spaces` like every other reach. Applies to an association of ANY type, an institution of another
 * campus included - its own audience is irrelevant here, only its rules meeting the ticked cell.
 *
 * It says nothing about posts by itself: callers splice it only for an association (never a
 * personal post), and only on READ paths - see `ReadOpts`.
 */
export function readGrantReachesAssociationSql(
  association: string,
  user: string,
  spaceFilter?: SpaceFilter
): string {
  // A grant never carries a review account across the cohort's boundary (review-cohort.ts): it
  // reads an association by a grant only when the association is the cohort's own (a review
  // account on its roster). With no cohort the clause is `NOT false`, and changes nothing.
  const cohortReader = inReviewCohortSql(`${user}.id`);
  const cohortGate =
    cohortReader === 'false'
      ? ''
      : `
      AND (NOT ${cohortReader} OR EXISTS (SELECT 1 FROM association_members rg_cohort
        WHERE rg_cohort."associationId" = ${association}
          AND ${inReviewCohortSql('rg_cohort."userId"')}))`;
  return `EXISTS (SELECT 1 FROM read_grants rg_grant
    JOIN spaces rg_space ON rg_space.campus = rg_grant.campus
      AND (rg_grant.formation IS NULL OR rg_grant.formation = rg_space.formation)
    JOIN association_audiences rg_rule ON rg_rule."associationId" = ${association}
      AND ${ruleReachesSpaceSql('rg_rule', 'rg_space')}
    WHERE rg_grant.user_id = ${user}.id${andSpaceFilter(spaceFilter, 'rg_space')}${cohortGate})`;
}

/**
 * Whether a predicate also counts NOMINATIVE READ GRANTS. Off by default, on for the READ paths only
 * (`*ToViewerSql`: the feed, a post, its comments and reactions, the signed-in agenda): the
 * recipients of an announcement and of a republication are computed with the plain predicate, so a
 * named reader is NEVER notified for their perimeter (user, 2026-10-07).
 */
export interface ReadOpts {
  readGrants?: boolean;
  /**
   * A SQL boolean the grant door ALSO requires when `readGrants` is on. `postVisibleToUserSql`
   * passes "the post is not students-only": a read grant never opens an "Entre étudiants" post
   * (lead's decision, 2026-11-04), so the guard closes that one door and leaves the others alone.
   */
  grantGuard?: string;
  /**
   * A further condition on the space through which the rules or a grant reach the reader
   * ({@link SpaceFilter}). Only for a post's OWN association: a republisher reaches its own readers.
   */
  spaceFilter?: SpaceFilter;
}

/**
 * What a caller is about to do with a post it has opened. A nominative read grant covers
 * `'READ_OR_REACT'` (read the post, react to it) and NOT `'VOTE'`: a poll vote, like a
 * republication, is never opened by a grant (user, 2026-10-07). `'COMMENT'` (read the comments,
 * write one, like one) counts the grant too, EXCEPT for a named reader who reaches the post only
 * through it with their switch "voit les commentaires" off (owner, 2026-11-04,
 * `commentsWithheldFromViewerSql`): for them the comments do not exist, a 404 like any invisible
 * resource.
 */
export type PostAccessIntent = 'READ_OR_REACT' | 'COMMENT' | 'VOTE';

/**
 * Association `association` is visible to user row `user`: a member (D21), or its rules reach one of
 * the user's spaces, or - with `readGrants` - a nominative read grant reaches it. The agenda's
 * predicate. A global admin is a reader like any other here (user, 2026-10-04): browsing is not a
 * moderation power, so an admin who is an ICM student sees what an ICM student sees.
 */
export function associationVisibleToUserSql(
  association: string,
  user: string,
  opts: ReadOpts = {}
): string {
  const grantDoor = readGrantReachesAssociationSql(association, user, opts.spaceFilter);
  const grant = opts.readGrants
    ? `\n    OR ${opts.grantGuard ? `(${opts.grantGuard} AND ${grantDoor})` : grantDoor}`
    : '';
  return `(${isMemberSql(association, user)} OR ${associationRulesReachUserSql(association, user, opts.spaceFilter)}${grant})`;
}

/**
 * The directory's map filter (D37): association `association`'s OWN rules reach at least one space
 * matching `filter`, whose sides are SQL expressions (placeholders) or `null` for "any side". Rules
 * only - a membership does not put an association on a campus it does not address. Both sides
 * `null` is "reaches any space at all", which an association with no rule does not.
 */
export function associationRulesReachSpaceMatchingSql(
  association: string,
  filter: { formation: string | null; campus: string | null },
  spaceFilter?: SpaceFilter
): string {
  const formation =
    filter.formation === null ? '' : ` AND dir_space.formation = ${filter.formation}`;
  const campus = filter.campus === null ? '' : ` AND dir_space.campus = ${filter.campus}`;
  return `EXISTS (SELECT 1 FROM association_audiences dir_rule
    JOIN spaces dir_space ON ${ruleReachesSpaceSql('dir_rule', 'dir_space')}
    WHERE dir_rule."associationId" = ${association}${formation}${campus}${andSpaceFilter(spaceFilter, 'dir_space')})`;
}

/**
 * The anonymous agenda's selection (D40): calendar event row `event` is reached by a space matching
 * `filter` (sides as in `associationRulesReachSpaceMatchingSql`) through its ORGANISER's rules or an
 * ACCEPTED co-organiser's (D39), the union an event's audience is. Rules only, like the map filter:
 * an anonymous reader has no membership, so D21 has nothing to add. Both sides `null` is not a
 * selection and the caller must not splice it.
 *
 * AN INSTITUTION'S REACH (owner, 2026-11-13; migration 165), read as `postReachesSpaceSql` reads a
 * post's: the organiser's door matches only a space the event ticked
 * ({@link institutionReachHoldsSpaceSql}), and an event for STAFF only reaches no space at all - a
 * space's readers are students, whom its public refuses. An accepted co-organiser's door keeps its
 * own rules (the reach narrows the institution's own door, as a republisher keeps its readers).
 */
export function eventReachesSpaceMatchingSql(
  event: string,
  filter: { formation: string | null; campus: string | null }
): string {
  const ownDoor = associationRulesReachSpaceMatchingSql(
    `${event}."associationId"`,
    filter,
    (space) => institutionReachHoldsSpaceSql(event, space)
  );
  return `(${event}."reachPublic" IS DISTINCT FROM 'staff' AND (${ownDoor}
    OR EXISTS (SELECT 1 FROM association_calendar_event_co_owners sel_coorg
      WHERE sel_coorg.event_id = ${event}.id
        AND ${associationRulesReachSpaceMatchingSql('sel_coorg.association_id', filter)})))`;
}

/**
 * An association that REPUBLISHED post row `post` (D38, `post_republications`) is visible to user
 * row `user` - the same predicate as the original's association, applied to the republisher: a
 * member of it (D21) or a reader its rules reach.
 *
 * AN ARCHIVED CARRIER REACHES NOBODY (review of #2965, 2026-11-02): it no longer speaks, so what
 * it carries stops reaching its audience, read from state - un-archiving it brings the reach back,
 * and no row is deleted. `NEWLY_REACHED_BY_REPUBLICATION_SQL` says the same of the carrier it is
 * asked about, so its count stays exact.
 */
function republicationReachesUserSql(post: string, user: string, opts: ReadOpts = {}): string {
  return `EXISTS (SELECT 1 FROM post_republications vis_rep
      JOIN associations vis_rep_asso ON vis_rep_asso.id = vis_rep."associationId"
      WHERE vis_rep."postId" = ${post}.id AND NOT COALESCE(vis_rep_asso.archived, false)
      AND ${associationVisibleToUserSql('vis_rep."associationId"', user, opts)})`;
}

/**
 * User row `user` shares at least one space with the author whose id is the expression `author` -
 * what makes a PERSONAL item (a post, a live) visible. No read grant ever reaches it (WP7).
 *
 * The review cohort is a space of its own: two review accounts share it, and nobody else does - a
 * review account has no real space (`isReaderSpaceSql`), so the first disjunct never pairs one with
 * a member, in either direction.
 */
function sharesSpaceWithAuthorSql(author: string, user: string): string {
  return `(EXISTS (
      SELECT 1 FROM users vis_author JOIN spaces vis_shared ON ${isReaderSpaceSql('vis_shared', 'vis_author')}
      WHERE vis_author.id = ${author} AND ${isReaderSpaceSql('vis_shared', user)})
    OR (${inReviewCohortSql(author)} AND ${inReviewCohortSql(`${user}.id`)}))`;
}

/**
 * User row `user` is an ACCEPTED follower of the person whose id is the expression `author`, with
 * no block between them either way and both on the same side of the review cohort's boundary - what
 * opens a PERSONAL item (a post, a live) across spaces (WP-F5, decisions 4 and 5 of the follow
 * requests, user 2026-10-25, reconfirmed 2026-10-31).
 *
 * - ACCEPTED only (`acceptedFollowSql`): a pending request opens nothing - the author has not
 *   answered, and the opening is exactly what they approved, one person at a time.
 * - THE BLOCK IS CHECKED HERE, NOT TRUSTED TO THE SEVERING: a block deletes the follow, but by a
 *   best-effort cross-service call, and a row it missed would otherwise re-open the author's posts
 *   to the person they blocked. Both directions, as every block.
 * - THE COHORT: a follow recorded across the review cohort's boundary before the rule existed opens
 *   nothing (`review-cohort.ts`), as it is left out of every list.
 * - NEVER A READ GRANT, which never reaches the personal branch (WP7), and never an anonymous post
 *   - the caller excludes it: following someone must not unmask what they published anonymously.
 *
 * STATE, NEVER A STORED COPY: unfollowing, a removal ("Retirer") or a block deletes the row, and the
 * next read no longer counts it - the revocation needs no mechanism of its own.
 */
function acceptedFollowerOfAuthorSql(author: string, user: string): string {
  return `(EXISTS (SELECT 1 FROM user_follows vis_follow
      WHERE vis_follow."followedUserId" = ${author} AND vis_follow."followerUserId" = ${user}.id
        AND ${acceptedFollowSql('vis_follow')})
    AND NOT EXISTS (SELECT 1 FROM user_blocks vis_block
      WHERE (vis_block."blockerId" = ${user}.id AND vis_block."blockedId" = ${author})
         OR (vis_block."blockerId" = ${author} AND vis_block."blockedId" = ${user}.id))
    AND ${sameSideOfReviewCohortSql(author, `${user}.id`)})`;
}

/**
 * What a reposter must still hold for their repost to reach anyone: first-hand sight, no grant, and
 * - for a personal post - not through a carrier the author accepted (no second hop, 2026-11-02).
 */
const REPOSTER_FIRST_HAND = {
  adminSeesAll: false,
  readGrants: false,
  memberReposts: false,
  personalRepublications: false,
} as const;

/**
 * Post row `post` reaches user row `user` through a MEMBER REPOST (WP-F6, decision 1 and Q2 of the
 * follow requests, user 2026-10-25; consent shape, owner 2026-11-01): a person `user` FOLLOWS -
 * accepted, never a pending request - reposted it (`member_reposts`). It holds for a personal post
 * AND an entity post (Q2: a member's repost of an association post widens it to the member's
 * accepted followers, and to nobody else).
 *
 * - NEVER AN ANONYMOUS POST: the write refuses one, and the predicate says it again, so a row that
 *   ever pointed at one (a post flagged anonymous later) opens nothing.
 * - BLOCKS, EVERY PAIR, BOTH WAYS, CHECKED HERE RATHER THAN TRUSTED TO THE SEVERING: reader and
 *   reposter; and, for a PERSONAL post, reader and author and reposter and author. The author pairs
 *   are left out for an entity post on purpose: its `authorId` is the officer who wrote it in the
 *   association's name, and a feed that changed when a reader blocked that person would tell them
 *   who wrote it (the oracle `PostsService.blockedAuthorSql` documents).
 * - THE COHORT: reader, reposter and author on the same side of the review cohort's boundary.
 * - NEVER A READ GRANT: the follow is the only door.
 *
 * CONSENT IS NOT READ HERE, it is STATE: a repost row exists only while the author consents. The
 * write checks it under the author's lock, and withdrawing it deletes the rows under the same lock
 * (`MemberRepostsService`), so no row outlives a "no".
 *
 * THE REPOSTER STILL HOLDS WHAT THEY PASSED ON, READ HERE AND NOT TRUSTED TO A ROW: the reposter
 *   still sees the post FIRST-HAND (`postVisibleToUserSql` with `REPOSTER_FIRST_HAND`, which leaves
 *   member reposts and read grants out, so it never recurses), and is not restricted
 *   (`user_moderation.isMuted`, the only account restriction social-service holds - the one
 *   `senderSpeaksSql` reads for D38b). An author who removes the follower, a reposter who unfollows
 *   or leaves a members-only association, a reposter who is muted: the row stays, and reaches nobody
 *   until access comes back (Opus review of #2859, 2026-11-01).
 *
 * MONOTONE IN REPOSTS: adding a row only ever adds readers, which the newly-reached rule
 * (`newlyReachedByMemberRepostSql`) relies on.
 */
export function memberRepostReachesUserSql(post: string, user: string): string {
  return `(NOT COALESCE(${post}.anonymous, false)
    AND ${sameSideOfReviewCohortSql(`${post}."authorId"`, `${user}.id`)}
    AND EXISTS (SELECT 1 FROM member_reposts vis_mrep
      JOIN user_follows vis_mrep_follow ON vis_mrep_follow."followedUserId" = vis_mrep."reposterId"
        AND vis_mrep_follow."followerUserId" = ${user}.id AND ${acceptedFollowSql('vis_mrep_follow')}
      JOIN users vis_mrep_user ON vis_mrep_user.id = vis_mrep."reposterId"
      WHERE vis_mrep."postId" = ${post}.id
        AND ${memberRepostCarriesSql(post, 'vis_mrep_user', `${user}.id`)}))`;
}

/**
 * THE KINDS OF ENTITY WHOSE POSTS A MEMBER REPOST MAY CARRY (WP-F6). An ALLOWLIST over
 * `CHK_associations_type` (migration 075), so a type added later stays refused until someone lists
 * it here. Every type of today is on it: an association and an institution since WP-F6, a LIST since
 * the owner's decision of 2026-11-02 ("Oui partout sans exception"), which lifted the refusal of
 * lists taken the same morning. The allowlist shape is kept on purpose rather than "any entity":
 * the next type is a decision, never an accident.
 */
export const MEMBER_REPOSTABLE_ASSOCIATION_TYPES: readonly string[] = [
  'association',
  'list',
  'institution',
];

/** `MEMBER_REPOSTABLE_ASSOCIATION_TYPES` as an SQL list of literals (constants, never user input). */
const MEMBER_REPOSTABLE_TYPES_SQL = MEMBER_REPOSTABLE_ASSOCIATION_TYPES.map((t) => `'${t}'`).join(
  ', '
);

/**
 * Post row `post` is one a member repost may carry at all (owner, 2026-11-02): a personal post, or
 * the post of an entity of a LISTED type (`MEMBER_REPOSTABLE_ASSOCIATION_TYPES`) that addresses at
 * least one space (an `association_audiences` rule) and is not ARCHIVED - never that of an entity
 * with no rule, one read by its MEMBERS ONLY: what such an entity publishes is meant for that
 * circle, and a member's repost would carry it past it; and never an archived entity's, which no
 * longer speaks (review of #2965, 2026-11-02).
 *
 * Read by the write (refused with the 404 of a post not seen), by the card's offer, and inside
 * `memberRepostCarriesSql` - so a repost written before its entity lost its last rule, was
 * archived, or before its type left the list, reaches, names and dates nothing, with no row
 * deleted. Read from state at every query: an entity that gains a rule, or is un-archived, makes
 * its posts repostable again.
 */
export function memberRepostablePostSql(post: string): string {
  return `(${post}."associationId" IS NULL OR EXISTS (SELECT 1 FROM associations vis_mrep_asso
      WHERE vis_mrep_asso.id = ${post}."associationId" AND vis_mrep_asso.type IN (${MEMBER_REPOSTABLE_TYPES_SQL})
        AND NOT COALESCE(vis_mrep_asso.archived, false)
        AND EXISTS (SELECT 1 FROM association_audiences vis_mrep_arule
          WHERE vis_mrep_arule."associationId" = vis_mrep_asso.id)))`;
}

/**
 * Repost row by reposter row `reposter` (a `users` alias) of post row `post` still CARRIES the post
 * to the reader whose id is the expression `readerId` - every condition of
 * `memberRepostReachesUserSql` but the follow itself, so the card that NAMES a reposter
 * (`member-repost-card.ts`) names exactly the ones whose repost reaches that reader: the reposter on
 * the reader's side of the review cohort, not muted, still seeing the post first-hand, no block
 * between any pair concerned, and a post a repost may carry at all (`memberRepostablePostSql`).
 */
export function memberRepostCarriesSql(post: string, reposter: string, readerId: string): string {
  const personal = `${post}."associationId" IS NULL`;
  return `(${memberRepostablePostSql(post)}
    AND ${sameSideOfReviewCohortSql(`${reposter}.id`, readerId)}
    AND NOT EXISTS (SELECT 1 FROM user_moderation vis_mrep_mod
      WHERE vis_mrep_mod."userId" = ${reposter}.id AND vis_mrep_mod."isMuted" = true)
    AND ${postVisibleToUserSql(post, reposter, REPOSTER_FIRST_HAND)}
    AND NOT EXISTS (SELECT 1 FROM user_blocks vis_mrep_block
      WHERE (vis_mrep_block."blockerId" = ${readerId} AND vis_mrep_block."blockedId" = ${reposter}.id)
         OR (vis_mrep_block."blockerId" = ${reposter}.id AND vis_mrep_block."blockedId" = ${readerId})
         OR (${personal} AND (
              (vis_mrep_block."blockerId" = ${readerId} AND vis_mrep_block."blockedId" = ${post}."authorId")
           OR (vis_mrep_block."blockerId" = ${post}."authorId" AND vis_mrep_block."blockedId" = ${readerId})
           OR (vis_mrep_block."blockerId" = ${reposter}.id AND vis_mrep_block."blockedId" = ${post}."authorId")
           OR (vis_mrep_block."blockerId" = ${post}."authorId" AND vis_mrep_block."blockedId" = ${reposter}.id)))))`;
}

/**
 * Whether a post predicate counts the author's ACCEPTED FOLLOWERS (WP-F5). On by default - it is
 * who may SEE a personal post: by id, its comments and reactions, the search, the Suivis feed, the
 * announcement and the republication's newly-reached rule. OFF only where a feed is a feed of
 * SPACES (`followers: false`): "Tout" and the promo/formation browse stay filtered by spaces for
 * everyone (decision 5), so what a follower gains across spaces appears in Suivis and nowhere else
 * in the lists.
 */
export interface FollowerOpts {
  followers?: boolean;
  /**
   * WP-F6: whether a MEMBER REPOST opens the post (on by default, with `followers`). OFF to ask
   * "does this reader see it FIRST-HAND" - through its own audience, the author's followers or an
   * association that carries it - which is what may repost it (decided 2026-11-01: no chain; the
   * author's consent covers one step of reach).
   */
  memberReposts?: boolean;
  /**
   * Whether a PERSONAL post is opened by an association that CARRIES it (D38b), on by default. OFF
   * for the member-repost first-hand test only (`REPOSTER_FIRST_HAND`, `FIRST_HAND`): the author
   * consented to ONE carrier's audience, so a reader who reaches the post only through that carrier
   * may not repost it to their own followers - the second hop of the review of #2965 (2026-11-02).
   * An entity post keeps its republications: no person consented to anything there.
   */
  personalRepublications?: boolean;
}

/**
 * User row `user` is a STUDENT in the sense of the "Entre étudiants" switch (owner, 2026-11-04,
 * decision 3): an account with a cursus - a campus and a formation from the identity provider - so
 * at least one SPACE (`isReaderSpaceSql`). Staff (a campus and an empty cursus) have none, and a
 * review account has none (`review-cohort.ts`).
 */
export function isStudentSql(user: string): string {
  return `EXISTS (SELECT 1 FROM spaces so_space WHERE ${isReaderSpaceSql('so_space', user)})`;
}

/**
 * THE "ENTRE ÉTUDIANTS" GATE (owner, 2026-11-04; migration 133): post row `post` is not marked
 * `studentsOnly`, or user row `user` is a student ({@link isStudentSql}), or a member of the
 * association that PUBLISHED it (its own members, never a republisher's). A conjunct of
 * {@link postVisibleToUserSql} over every door but the author's own, so it holds whatever the path -
 * a republication, a member repost, a pin, a read grant, a follow: the rule is on WHO READS, never on
 * how the post travels (decision 2). A named reader without a cursus therefore sees nothing of such
 * a post, which `commentsWithheldFromViewerSql` then never has to withhold.
 *
 * Read from the row at every query: turning the switch on withdraws the post from outside readers
 * at once, turning it off gives it back (decision 5), with no row written anywhere else.
 */
export function studentsOnlyAdmitsUserSql(post: string, user: string): string {
  return `(NOT COALESCE(${post}."studentsOnly", false) OR ${isStudentSql(user)}
    OR (${post}."associationId" IS NOT NULL AND ${isMemberSql(`${post}."associationId"`, user)}))`;
}

/**
 * THE PUBLIC AN INSTITUTION CHOSE (owner, 2026-11-10; migration 162 for posts, 165 for calendar
 * events - the same two columns, so `post` may be either row): post row `post` carries no
 * reach (`reachPublic` NULL: not an institution's post, or one written before the reach existed), or
 * its public is 'all', or 'students' and user row `user` is a student ({@link isStudentSql}), or
 * 'staff' and they are not - or they are a member of the institution that PUBLISHED it, who reads
 * every post of their own institution (D21). Like the "Entre étudiants" gate, a conjunct over every
 * door but the author's own: the rule is on WHO READS, wherever the post arrives.
 *
 * A "staff" reader is an account with no space: staff (a campus and an empty cursus). A staff account
 * has no space for the post's rules to reach, so they reach an institution's post through a door they
 * already had - a membership, a read grant, a republisher, a member repost - or, since 2026-11-14,
 * the staff-by-campus door of a "Tous" or "Personnel" item ({@link institutionReachStaffCampusDoorSql}).
 */
export function institutionReachAdmitsUserSql(post: string, user: string): string {
  return `(${post}."reachPublic" IS NULL OR ${post}."reachPublic" = 'all'
    OR (${post}."reachPublic" = 'students' AND ${isStudentSql(user)})
    OR (${post}."reachPublic" = 'staff' AND NOT ${isStudentSql(user)})
    OR (${post}."associationId" IS NOT NULL AND ${isMemberSql(`${post}."associationId"`, user)}))`;
}

/**
 * EVERY GATE ON WHO READS A POST, WHATEVER THE DOOR: the "Entre étudiants" switch
 * ({@link studentsOnlyAdmitsUserSql}) and an institution's public ({@link institutionReachAdmitsUserSql}).
 * What `postVisibleToUserSql` narrows every door with, and what the newly-reached rules restate on
 * their "after" side.
 */
export function postPublicAdmitsUserSql(post: string, user: string): string {
  return `(${studentsOnlyAdmitsUserSql(post, user)} AND ${institutionReachAdmitsUserSql(post, user)})`;
}

/**
 * {@link postPublicAdmitsUserSql} for the viewer whose id is the placeholder `viewer`: what a
 * surface that copies a post's TEXT somewhere the predicate does not re-ask (a proposal queue, a
 * notification that is not bound to the post) asks before copying it. An absent viewer is refused.
 */
export function postPublicAdmitsViewerSql(post: string, viewer: string): string {
  return `EXISTS (SELECT 1 FROM users so_viewer WHERE so_viewer.id = ${viewer}
    AND ${postPublicAdmitsUserSql(post, 'so_viewer')})`;
}

/**
 * THE SPACES AN INSTITUTION TICKED (owner, 2026-11-10 for posts, migration 162; 2026-11-13 for
 * calendar events, migration 165): space row `space` is one that row `item` - a post or an
 * `association_calendar_events` row, both carrying `"reachSpaces"` - reaches through its OWN
 * association. The item carries no reach (`reachSpaces` NULL: every space of the association's
 * audience, as before), or the space is one of its ticked pairs. Containment (`@>`) as `users.cursus`
 * is read: a malformed value contains nothing, so the item then reaches nobody through its rules (it
 * fails closed). Always ANDed with the association's own rules reaching that same space, so the reach
 * never widens the audience and shrinks with it.
 */
export function institutionReachHoldsSpaceSql(item: string, space: string): string {
  return `(${item}."reachSpaces" IS NULL OR ${item}."reachSpaces" @> jsonb_build_array(
      jsonb_build_object('formation', ${space}.formation, 'campus', ${space}.campus)))`;
}

/**
 * User row `user` is STAFF OF A CAMPUS: a campus and NO cursus entry, and not a review account - the
 * SQL twin of {@link campusWideReaderCampus} (EMSE staff, user 2026-10-07), whose test holds the two
 * together. A cursus that is not an array (malformed) is not staff, as the pure twin answers.
 */
export function isCampusStaffSql(user: string): string {
  return `(${user}.campus IS NOT NULL
    AND (${user}.cursus IS NULL OR ${user}.cursus = '[]'::jsonb OR ${user}.cursus = 'null'::jsonb)
    AND NOT ${inReviewCohortSql(`${user}.id`)})`;
}

/**
 * THE STAFF-BY-CAMPUS DOOR (owner, 2026-11-14: "Oui, par campus"): row `item` - a post or a calendar
 * event an institution gave a reach - whose public is "Tous" or "Personnel" opens to user row `user`
 * when they are staff of a campus ({@link isCampusStaffSql}) and one of the spaces the item TICKED is
 * on that campus AND is still reached by the institution's own rules. So the School addresses its
 * staff without naming each one; a staff account of another campus is not reached, a student gains
 * nothing (their door is their space), and the door is never wider than the institution's audience
 * and shrinks with it, as the rules door does. An item with no reach (not an institution's, or
 * written before the reach existed) opens nothing here: its readers are what they were.
 *
 * Read from the row: an edit to "Étudiants", or unticking the campus, closes the door at once. The
 * public gate ({@link institutionReachAdmitsUserSql}) still ANDs over it.
 */
export function institutionReachStaffCampusDoorSql(item: string, user: string): string {
  return `(${item}."reachPublic" IN ('all', 'staff') AND ${item}."reachSpaces" IS NOT NULL
    AND ${isCampusStaffSql(user)}
    AND EXISTS (SELECT 1 FROM association_audiences sc_rule
      JOIN spaces sc_space ON ${ruleReachesSpaceSql('sc_rule', 'sc_space')}
      WHERE sc_rule."associationId" = ${item}."associationId" AND sc_space.campus = ${user}.campus
        AND ${institutionReachHoldsSpaceSql(item, 'sc_space')}))`;
}

/**
 * Row `item` (a post or a calendar event) is NOT for students only by an institution's public: what
 * closes a read grant's door and a browsing admin's on a "students" item (S1, S2 of #3010, kept for
 * the reach of posts and of events alike).
 */
export function institutionReachNotForStudentsSql(item: string): string {
  return `${item}."reachPublic" IS DISTINCT FROM 'students'`;
}

/**
 * Post row `post` is visible to user row `user` (decision 3 of WP6b, D38):
 * - the post's author, and a global admin ONLY when `adminSeesAll` (opening one post by its id, the
 *   way a report or a moderation link does) - never when BROWSING, so the feed, the search and the
 *   announcements show an admin what they would show an ordinary reader (user, 2026-10-04: an admin
 *   reading everyone's personal posts would be a mess, and a wrong thing to be able to do);
 * - an association post: the reader sees its association (a member, or its rules reach one of the
 *   reader's spaces), OR sees an association that republished it. A post has no rules of its own
 *   any more (D38, user 2026-10-04): what widens its audience is a republication, never the author.
 *   The promo and contributor FILTERS of D38 are not built yet, so nothing narrows either branch;
 * - a personal post (anonymous included): the user shares at least one space with its AUTHOR, OR
 *   sees an association that republished it - which exists only because the author ACCEPTED that
 *   association's request (D38b). NO read grant ever reaches this branch (WP7), the republication
 *   disjunct included (it is spliced without `readGrants`): a named reader sees what an ENTITY
 *   published and never what a student wrote;
 * - a NON-ANONYMOUS personal post, also: the author's ACCEPTED followers, whatever their space,
 *   campus or formation (WP-F5, `acceptedFollowerOfAuthorSql`) - a personnel the student accepted
 *   included, which D34-D36 otherwise exclude. Never an anonymous one: a follower reading it would
 *   learn who wrote it. Left out with `followers: false` ({@link FollowerOpts}).
 *
 * MONOTONE IN REPUBLICATIONS, and `NEWLY_REACHED_BY_REPUBLICATION_SQL` relies on it: adding one
 * only ever adds a disjunct, so who sees a post after is who saw it before plus who the republisher
 * reaches. The follower disjunct changes nothing to that: it reads no republication.
 *
 * - ANY non-anonymous post, also: the accepted followers of a MEMBER who reposted it (WP-F6,
 *   `memberRepostReachesUserSql`), left out with `followers: false` like the author's followers.
 *   Monotone in reposts too, so a repost's newly-reached set is "after and not before".
 *
 * EVERY DOOR BUT THE AUTHOR'S AND THE MODERATING ADMIN'S IS NARROWED BY THE "ENTRE ÉTUDIANTS" GATE
 * ({@link studentsOnlyAdmitsUserSql}, owner 2026-11-04). It reads no republication and no repost, so
 * the predicate stays monotone in both, and the newly-reached rules restate it on their "after" side.
 * Two narrowings more on such a post (the lead's decisions, 2026-11-04, reversible):
 * - A READ GRANT NEVER OPENS IT: the grant door carries `grantGuard` = "not students-only", so a
 *   student who also holds a grant on another campus does not read that campus's post through it;
 * - `adminSeesAll` opens it to a platform admin ONLY with `adminModerates` - the moderation read
 *   (`allowHidden`: the post by id, its comments, a comment's moderation). Reacting, commenting,
 *   voting and browsing it ask the gate of an admin like of anyone.
 *
 * AN INSTITUTION'S REACH (owner, 2026-11-10, amending D19 for institutions only; migration 162):
 * - its PUBLIC is a second gate beside the switch ({@link institutionReachAdmitsUserSql}, both in
 *   {@link postPublicAdmitsUserSql}), over every door but the author's; 'students' closes the grant
 *   and browsing-admin doors exactly as the switch does;
 * - its SPACES narrow the post's OWN association door - rules and read grant alike - to the ticked
 *   spaces ({@link institutionReachHoldsSpaceSql}), ANDed with the institution's rules, so never wider than
 *   its audience. A membership is not narrowed (D21), and a republisher reaches its own readers (G4);
 * - "Tous" and "Personnel" also open it to the staff of a ticked space's campus
 *   ({@link institutionReachStaffCampusDoorSql}, owner 2026-11-14), a door of its own beside the rules.
 * Read from the row: an edit narrows or widens the post for every path at once.
 */
export function postVisibleToUserSql(
  post: string,
  user: string,
  opts: { adminSeesAll?: boolean; adminModerates?: boolean } & ReadOpts & FollowerOpts = {}
): string {
  // "For students" in either form - the switch, or an institution's public - closes the grant door
  // and the browsing admin's, as the lead decided for the switch (S1, S2 of #3010).
  const notStudentsOnly = `(NOT COALESCE(${post}."studentsOnly", false)
      AND ${institutionReachNotForStudentsSql(post)})`;
  const adminClause = opts.adminSeesAll
    ? opts.adminModerates
      ? `${isAdminSql(user)}\n    OR `
      : `(${isAdminSql(user)} AND ${notStudentsOnly})\n    OR `
    : '';
  const grantOpts: ReadOpts = { readGrants: opts.readGrants, grantGuard: notStudentsOnly };
  // The post's OWN association reaches only the spaces the post ticked (an institution's reach,
  // 2026-11-10); a republisher reaches its own readers (G4), so its door takes no filter.
  const ownEntityOpts: ReadOpts = {
    ...grantOpts,
    spaceFilter: (space) => institutionReachHoldsSpaceSql(post, space),
  };
  const followerClause =
    opts.followers === false
      ? ''
      : `
      OR (NOT COALESCE(${post}.anonymous, false)
        AND ${acceptedFollowerOfAuthorSql(`${post}."authorId"`, user)})`;
  // WP-F6: a member repost reaches the reposter's accepted followers - a follow-based door, so it
  // is left out exactly where the author's own followers are (`followers: false`, decision 5).
  const repostClause =
    opts.followers === false || opts.memberReposts === false
      ? ''
      : `
      OR ${memberRepostReachesUserSql(post, user)}`;
  // D38b: a carrier the author accepted - left out only to ask who may repost it (no second hop).
  const personalCarrierClause =
    opts.personalRepublications === false
      ? ''
      : `
      OR ${republicationReachesUserSql(post, user)}`;
  return `(${adminClause}${post}."authorId" = ${user}.id
    OR (${postPublicAdmitsUserSql(post, user)} AND (
    (${post}."associationId" IS NULL AND (
      ${sharesSpaceWithAuthorSql(`${post}."authorId"`, user)}${personalCarrierClause}${followerClause}${repostClause}))
    OR (${post}."associationId" IS NOT NULL AND (
      ${associationVisibleToUserSql(`${post}."associationId"`, user, ownEntityOpts)}
      OR ${institutionReachStaffCampusDoorSql(post, user)}
      OR ${republicationReachesUserSql(post, user, grantOpts)}${repostClause})))))`;
}

/**
 * Who would see post `$1` for the FIRST time if association `$2` republished it: the readers the
 * association reaches who cannot see the post NOW, minus its author. Asked inside the transaction
 * that writes the republication, BEFORE the row exists - with `postVisibleToUserSql` monotone, that
 * is exactly "visible after and not before", computed on state and never on a clock. The "after"
 * side restates the "Entre étudiants" gate (`studentsOnlyAdmitsUserSql`): a reader the carrier
 * reaches but the gate refuses does not see the post after either, so is never told about it.
 */
export const NEWLY_REACHED_BY_REPUBLICATION_SQL = `SELECT nr_user.id FROM users nr_user
  JOIN posts nr_post ON nr_post.id = $1
  WHERE nr_user.id <> nr_post."authorId"
    AND EXISTS (SELECT 1 FROM associations nr_carrier
      WHERE nr_carrier.id = $2::uuid AND NOT COALESCE(nr_carrier.archived, false))
    AND ${associationVisibleToUserSql('$2::uuid', 'nr_user')}
    AND ${postPublicAdmitsUserSql('nr_post', 'nr_user')}
    AND NOT ${postVisibleToUserSql('nr_post', 'nr_user')}`;

/**
 * `NEWLY_REACHED_BY_REPUBLICATION_SQL` for a PERSONAL post (D38b), with two more terms:
 * - never a reader on either side of a block with the author: the feed hides a blocked author's
 *   posts, so telling them would be a notification about a post they are never shown;
 * - BEFORE the first announce (`announced` false), never one of the author's FOLLOWERS: a personal
 *   post is announced to its author's followers who see it (`announceRecipientsSql(true)`), and
 *   once the republication commits they see it, so the sweep tells them - and telling them here
 *   too would tell them twice. After the announce, the sweep is spent and everyone newly reached is
 *   told here. A follower is an ACCEPTED one, exactly as the sweep counts them: someone whose
 *   request is still pending is not told by the sweep, so they are told here. Since WP-F5 an
 *   accepted follower already SEES a non-anonymous personal post (D38b never carries an anonymous
 *   one), so `NOT postVisibleToUserSql` leaves them out first and this term only restates it - kept,
 *   because it is what keeps the two paths apart whatever the predicate becomes.
 */
export function newlyReachedByPersonalRepublicationSql(announced: boolean): string {
  const followers = announced
    ? ''
    : `
    AND NOT EXISTS (SELECT 1 FROM user_follows nr_follow
      WHERE nr_follow."followedUserId" = nr_post."authorId" AND nr_follow."followerUserId" = nr_user.id
        AND ${acceptedFollowSql('nr_follow')})`;
  return `${NEWLY_REACHED_BY_REPUBLICATION_SQL}
    AND NOT EXISTS (SELECT 1 FROM user_blocks nr_block
      WHERE (nr_block."blockerId" = nr_user.id AND nr_block."blockedId" = nr_post."authorId")
         OR (nr_block."blockerId" = nr_post."authorId" AND nr_block."blockedId" = nr_user.id))${followers}`;
}

/**
 * Who would see post `$1` for the FIRST time if the member `$2` reposted it (WP-F6, the D38 rule):
 * the reposter's ACCEPTED followers who cannot see the post NOW - asked BEFORE the row is written,
 * under the post row's lock, so with visibility monotone in reposts this is exactly "after minus
 * before", read from state and never from a clock. Minus the author and the reposter, minus anyone
 * on the other side of the review cohort, and with every block `memberRepostReachesUserSql` checks:
 * reader and reposter always, reader and author for a personal post only (an entity post's author
 * is never a block's subject - the oracle that rule documents).
 *
 * THE REPOST RULE IS REPEATED HERE (`memberRepostablePostSql`), so the "after" set and the "before"
 * set are read in ONE statement, on one snapshot: the write checked it before taking the post row's
 * lock, and an officer who removes the association's last audience rule meanwhile takes no lock the
 * write waits on - without the term, the repost would push `member_repost` for a post its row no
 * longer carries to anyone. The "Entre étudiants" gate is restated on the "after" side for the same
 * reason as in `NEWLY_REACHED_BY_REPUBLICATION_SQL`: a follower it refuses is never reached.
 *
 * The CALLER decides whether to tell them: an ENTITY post not yet announced will be announced to
 * everyone who sees it by then (`announceRecipientsSql(false)`), these readers included, so they
 * are told nothing at the repost; a PERSONAL post is announced to its author's followers only, so
 * the readers a repost reaches are told at the repost, announced or not.
 */
export const NEWLY_REACHED_BY_MEMBER_REPOST_SQL = `SELECT nr_user.id FROM users nr_user
  JOIN posts nr_post ON nr_post.id = $1
  JOIN user_follows nr_rfollow ON nr_rfollow."followedUserId" = $2 AND nr_rfollow."followerUserId" = nr_user.id
    AND ${acceptedFollowSql('nr_rfollow')}
  WHERE nr_user.id <> nr_post."authorId" AND nr_user.id <> $2
    AND NOT COALESCE(nr_post.anonymous, false)
    AND ${sameSideOfReviewCohortSql('$2::text', 'nr_user.id')}
    AND ${sameSideOfReviewCohortSql('nr_post."authorId"', 'nr_user.id')}
    AND NOT EXISTS (SELECT 1 FROM user_blocks nr_rblock
      WHERE (nr_rblock."blockerId" = nr_user.id AND nr_rblock."blockedId" = $2)
         OR (nr_rblock."blockerId" = $2 AND nr_rblock."blockedId" = nr_user.id)
         OR (nr_post."associationId" IS NULL AND (
              (nr_rblock."blockerId" = nr_user.id AND nr_rblock."blockedId" = nr_post."authorId")
           OR (nr_rblock."blockerId" = nr_post."authorId" AND nr_rblock."blockedId" = nr_user.id))))
    AND ${memberRepostablePostSql('nr_post')}
    AND ${postPublicAdmitsUserSql('nr_post', 'nr_user')}
    AND NOT ${postVisibleToUserSql('nr_post', 'nr_user')}`;

/**
 * Post row `post` reaches THE READERS OF space row `space`, as a space - what a pin in that space
 * may promote (WP-PIN, owner 2026-11-03: "any post visible to the readers of those spaces").
 *
 * It is `postVisibleToUserSql` with everything PERSONAL taken out, since a space is not a person:
 * - an association post: one of the association's rules reaches the space (a membership is one
 *   person's door, never a space's) and, for an institution's post with a reach, the space is one it
 *   ticked (`institutionReachHoldsSpaceSql`, 2026-11-10);
 * - an institution's post for staff only (`reachPublic` 'staff') reaches no space at all: a space's
 *   readers are students, whom its public refuses (review of #3314);
 * - a personal post: its author belongs to the space (`isReaderSpaceSql`, so a review account's post
 *   reaches no real space);
 * - either: an association that REPUBLISHED it, and is not archived, has a rule reaching the space
 *   (D38, D38b; an archived carrier reaches nobody, as in `republicationReachesUserSql`).
 * Never a follow, a member repost or a read grant: each opens a post to chosen people, not to a
 * space. `space-pins.integration.spec.ts` holds it to `postVisibleToUserSql` for a reader whose
 * only door is that one space.
 */
export function postReachesSpaceSql(post: string, space: string): string {
  const republished = `EXISTS (SELECT 1 FROM post_republications sp_rep
        JOIN associations sp_rep_asso ON sp_rep_asso.id = sp_rep."associationId"
        JOIN association_audiences sp_rep_rule ON sp_rep_rule."associationId" = sp_rep."associationId"
        WHERE sp_rep."postId" = ${post}.id AND NOT COALESCE(sp_rep_asso.archived, false)
          AND ${ruleReachesSpaceSql('sp_rep_rule', space)})`;
  // A space's readers are students - they HAVE the space - so a post an institution wrote for staff
  // only (`reachPublic` 'staff') reaches no space as a space, and never takes a pin slot there.
  return `(${post}."reachPublic" IS DISTINCT FROM 'staff' AND ((${post}."associationId" IS NULL AND (
      EXISTS (SELECT 1 FROM users sp_author
        WHERE sp_author.id = ${post}."authorId" AND ${isReaderSpaceSql(space, 'sp_author')})
      OR ${republished}))
    OR (${post}."associationId" IS NOT NULL AND (
      (EXISTS (SELECT 1 FROM association_audiences sp_rule
        WHERE sp_rule."associationId" = ${post}."associationId" AND ${ruleReachesSpaceSql('sp_rule', space)})
        AND ${institutionReachHoldsSpaceSql(post, space)})
      OR ${republished}))))`;
}

/**
 * Space row `space` is one of user row `user`'s PIN spaces (WP-PIN, coordinator 2026-11-03): one of
 * their own spaces (`isReaderSpaceSql`), or a space inside a cell of one of their READ GRANTS (a NULL
 * formation is the whole campus). So a staff account with no space and a campus-wide grant is shown
 * the pins of every space of that campus, and a grant on another campus shows nothing here. A review
 * account has no space and no grant counts for it (`review-cohort.ts`).
 */
export function isPinSpaceOfUserSql(space: string, user: string): string {
  return `(${isReaderSpaceSql(space, user)}
    OR (NOT ${inReviewCohortSql(`${user}.id`)} AND EXISTS (SELECT 1 FROM read_grants ps_grant
      WHERE ps_grant.user_id = ${user}.id AND ps_grant.campus = ${space}.campus
        AND (ps_grant.formation IS NULL OR ps_grant.formation = ${space}.formation))))`;
}

/**
 * Post row `post` is visible to the viewer whose id is the placeholder `viewer` (`$5`, or a TypeORM
 * `:name`). An absent viewer (NULL) matches no `users` row, so it sees nothing.
 */
export function postVisibleToViewerSql(
  post: string,
  viewer: string,
  opts: {
    adminSeesAll?: boolean;
    adminModerates?: boolean;
    readGrants?: boolean;
  } & FollowerOpts = {}
): string {
  // Grants count by default (every READ path); a WRITE that a grant never opened - a vote, a
  // republication - passes `readGrants: false`, explicitly.
  return `EXISTS (SELECT 1 FROM users vis_viewer WHERE vis_viewer.id = ${viewer} AND ${postVisibleToUserSql(post, 'vis_viewer', { ...opts, readGrants: opts.readGrants ?? true })})`;
}

/**
 * User row `user` has turned on "voit les commentaires" in the read-access grid (owner, 2026-11-04):
 * a row of `read_grant_readers` with `sees_comments` (migration 132). No row is OFF - the owner's
 * default for new and existing named readers alike. ONE switch per person, and it opens BOTH things a
 * grant-only reader is otherwise withheld: a post's comments and an association live's chat (owner,
 * 2026-11-04: the same switch, no second one).
 */
export function readerSeesGrantCommentsSql(user: string): string {
  return `EXISTS (SELECT 1 FROM read_grant_readers sc_reader
    WHERE sc_reader.user_id = ${user}.id AND sc_reader.sees_comments)`;
}

/**
 * WHAT "WITHHELD" MEANS, STATED ONCE (owner, 2026-11-04): the viewer whose id is the placeholder
 * `viewer` reaches a piece of content ONLY through a nominative read grant, and their switch "voit
 * les commentaires" is OFF. `visibleTo(user, readGrants)` is the content's own visibility predicate
 * on user row `user`, with and without the grants: the content is withheld when it is visible WITH
 * them and NOT visible WITHOUT them - so a reader who also reaches it natively (their own space, a
 * membership, a republication, an accepted follow, a member repost) keeps everything.
 *
 * A global admin is never withheld. A reader with no grant at all answers `false` on the grant
 * conjunct, before either visibility arm is asked. The two consumers are
 * {@link commentsWithheldFromViewerSql} (a post's comments and people) and
 * {@link liveChatWithheldFromViewerSql} (a live's chat); neither restates any of this.
 */
function withheldFromGrantOnlyReaderSql(
  viewer: string,
  visibleTo: (user: string, readGrants: boolean) => string
): string {
  return `EXISTS (SELECT 1 FROM users cw_viewer WHERE cw_viewer.id = ${viewer}
    AND NOT ${isAdminSql('cw_viewer')}
    AND EXISTS (SELECT 1 FROM read_grants cw_grant WHERE cw_grant.user_id = cw_viewer.id)
    AND NOT ${readerSeesGrantCommentsSql('cw_viewer')}
    AND ${visibleTo('cw_viewer', true)}
    AND NOT ${visibleTo('cw_viewer', false)})`;
}

/**
 * THE POSTS' HALF OF THE 2026-11-04 AMENDMENT: post row `post` is withheld from the viewer whose id
 * is the placeholder `viewer` ({@link withheldFromGrantOnlyReaderSql}). Such a reader still reads the
 * post and reacts to it, but its COMMENTS - the students' own expression, like their personal posts,
 * which a grant never opens - and every list of PEOPLE on it (who reacted, who voted what) are
 * withheld: totals only. Both arms take `adminSeesAll`, as the by-id gate does.
 *
 * Every consumer asks THIS - `commentsWithheldPostIds` (`posts/comments-withheld.ts`) for a page, the
 * `'COMMENT'` intent of the by-id gate, the bell - so none of them can drift from the others.
 */
export function commentsWithheldFromViewerSql(post: string, viewer: string): string {
  return withheldFromGrantOnlyReaderSql(viewer, (user, readGrants) =>
    postVisibleToUserSql(post, user, { adminSeesAll: true, readGrants })
  );
}

/**
 * THE LIVES' HALF OF THE 2026-11-04 AMENDMENT: live row `live` is withheld from the viewer whose id
 * is the placeholder `viewer` ({@link withheldFromGrantOnlyReaderSql} on {@link liveVisibleToUserSql}).
 * Such a reader watches the live - the video and the floating reactions, as they read a post and
 * react to it - but its CHAT is withheld: no line served, none sent, none reported. In practice an
 * association's live only, since a member's live never opens through a grant.
 *
 * Asked by the watch rule (`LivesService.assertMayWatch`, in the statement that asks the visibility,
 * so on every open and every manifest poll) and by the report of a chat line (`ModerationService`).
 */
export function liveChatWithheldFromViewerSql(live: string, viewer: string): string {
  return withheldFromGrantOnlyReaderSql(viewer, (user, readGrants) =>
    liveVisibleToUserSql(live, user, { readGrants })
  );
}

/**
 * A SQL boolean: the user ids the expressions `a` and `b` yield stand on the same side of the
 * review cohort's boundary (`review-cohort.ts`). The constant `true` with no cohort configured. For
 * a row written BEFORE the rule - a follow, a bell row - which every list then leaves out.
 */
export function sameSideOfReviewCohortSql(a: string, b: string): string {
  const aIn = inReviewCohortSql(a);
  if (aIn === 'false') return 'true';
  return `(${aIn} = ${inReviewCohortSql(b)})`;
}

/**
 * A review account's posts are invisible to every reader outside the cohort but a platform admin
 * (`review-cohort.ts`): an `AND ...` clause on `posts."authorId"`, or nothing. The visibility
 * predicate already keeps them apart - the cohort is a space of its own - and this states it again
 * on the author, so a post a review account writes AS an association it somehow joined still never
 * reaches a member's feed or search. Spliced by the feed and the search of `PostsService`.
 */
export function reviewCohortAuthorFilterSql(
  isAdmin: boolean,
  viewerId: string | undefined
): string {
  if (isAdmin || isInReviewCohort(viewerId)) return '';
  const authorInCohort = inReviewCohortSql('posts."authorId"');
  return authorInCohort === 'false' ? '' : `AND NOT ${authorInCohort}`;
}

/**
 * Live row `live` (a `lives` row) is visible to user row `user`: THE RULE OF A POST BY THE SAME
 * BROADCASTER (WP-L7, decided 2026-10-19) - its broadcaster; a member's live, a user sharing a space
 * with the broadcaster or one of their ACCEPTED followers (WP-F5, `acceptedFollowerOfAuthorSql`: no
 * block, same side of the review cohort - a live is never anonymous); an association's live, a user who sees the association (a member, or its
 * rules reach one of their spaces, or - with `readGrants` - a nominative read grant). A live has no
 * republication, so that disjunct of the post rule has nothing to add. An admin is a reader like any
 * other, as when browsing posts.
 *
 * ONE EXCEPTION, `adminSeesCohort`, for opening ONE live by its id: a platform admin may watch a
 * review account's live. No admin ever shares the review cohort's space (`review-cohort.ts`), so
 * without it a reported live of the cohort could be judged by nobody - moderation needs it. The
 * "Live now" list never passes it: browsing, an admin still sees only their own spaces.
 */
export function liveVisibleToUserSql(
  live: string,
  user: string,
  opts: ReadOpts & { adminSeesCohort?: boolean } = {}
): string {
  const cohortClause = opts.adminSeesCohort
    ? `
    OR (${isAdminSql(user)} AND ${inReviewCohortSql(`${live}."broadcasterId"`)})`
    : '';
  return `(${live}."broadcasterId" = ${user}.id${cohortClause}
    OR (${live}."associationId" IS NULL AND (${sharesSpaceWithAuthorSql(`${live}."broadcasterId"`, user)}
      OR ${acceptedFollowerOfAuthorSql(`${live}."broadcasterId"`, user)}))
    OR (${live}."associationId" IS NOT NULL AND ${associationVisibleToUserSql(`${live}."associationId"`, user, { readGrants: opts.readGrants })}))`;
}

/**
 * Live row `live` is visible to the viewer whose id is the placeholder `viewer` - the watch paths
 * (the list, the key, the manifest), so read grants count as on every post READ path. An absent
 * viewer sees nothing. `adminSeesCohort`: see {@link liveVisibleToUserSql}.
 */
export function liveVisibleToViewerSql(
  live: string,
  viewer: string,
  opts: { adminSeesCohort?: boolean } = {}
): string {
  return `EXISTS (SELECT 1 FROM users vis_viewer WHERE vis_viewer.id = ${viewer} AND ${liveVisibleToUserSql(live, 'vis_viewer', { readGrants: true, ...opts })})`;
}

/** Association `association` is visible to the viewer whose id is the placeholder `viewer`. */
export function associationVisibleToViewerSql(association: string, viewer: string): string {
  return `EXISTS (SELECT 1 FROM users vis_viewer WHERE vis_viewer.id = ${viewer} AND ${associationVisibleToUserSql(association, 'vis_viewer')})`;
}

/**
 * User row `user` is on the same CAMPUS as the person whose id is the expression `owner` - what
 * opens a PERSONAL booking space to someone who is not its owner (owner, 2026-10-31: "we restricted
 * to the campus, not to the formation, and people without a formation still have a campus"). The
 * campus alone, NOT a space: staff (a campus and an empty cursus) have no space, and their personal
 * booking space is still offered to their campus. No campus on either side matches nothing.
 *
 * The review cohort stays a world of its own, as in {@link sharesSpaceWithAuthorSql}: a review
 * account matches review accounts only, and nobody else matches one, whatever the profiles say.
 */
export function sameCampusAsOwnerSql(owner: string, user: string): string {
  const ownerInCohort = inReviewCohortSql(owner);
  const userInCohort = inReviewCohortSql(`${user}.id`);
  return `((NOT ${ownerInCohort} AND NOT ${userInCohort} AND EXISTS (
      SELECT 1 FROM users vis_owner WHERE vis_owner.id = ${owner}
        AND vis_owner.campus IS NOT NULL AND vis_owner.campus = ${user}.campus))
    OR (${ownerInCohort} AND ${userInCohort}))`;
}

/** The viewer whose id is the placeholder `viewer` is on the campus of `owner` ({@link sameCampusAsOwnerSql}). */
export function sameCampusAsViewerSql(owner: string, viewer: string): string {
  return `EXISTS (SELECT 1 FROM users vis_viewer WHERE vis_viewer.id = ${viewer} AND ${sameCampusAsOwnerSql(owner, 'vis_viewer')})`;
}

/**
 * Calendar event row `event` (an `association_calendar_events` row) is visible to user row `user`
 * (D39): its ORGANISER is visible to them, or an ACCEPTED co-organiser is - the same association
 * predicate for each, membership (D21) included. An event has no space rules of its own, so its
 * reach is the union of those audiences. A pending or refused co-organiser has no row in
 * `association_calendar_event_co_owners` (it lives in `proposals`), so it adds nothing; one that
 * leaves takes its row and its audience with it, and the next read is recomputed without it.
 *
 * AN INSTITUTION'S REACH (owner, 2026-11-13; migration 165) - the SAME two gates a post of it has,
 * built from the same fragments:
 * - its PUBLIC ({@link institutionReachAdmitsUserSql}) gates every door, and "students" closes the
 *   read-grant door ({@link institutionReachNotForStudentsSql}), as on a post. The organiser's
 *   members read it whatever the public (D21, inside the fragment) - and so do an ACCEPTED
 *   co-organiser's members: they co-own the event, edit it from the partner side (E2) and list it on
 *   their own page, which a public they are not part of must not hide from them;
 * - its SPACES narrow the ORGANISER's own door - rules and read grant - to the ticked spaces
 *   ({@link institutionReachHoldsSpaceSql}), as a post's narrow the post's own institution door. An
 *   accepted co-organiser's door keeps its own audience: the institution invited it, which is the
 *   event's widening mechanism exactly as a republication is a post's (G4). Only the public follows
 *   the event there;
 * - "Tous" and "Personnel" also open it to the staff of a ticked space's campus
 *   ({@link institutionReachStaffCampusDoorSql}, owner 2026-11-14), as on a post.
 * Read from the row at every query: an edit narrows or widens the event for every path at once.
 *
 * Status and dates are NOT decided here: each caller keeps its own (validated only, a window).
 */
export function eventVisibleToUserSql(event: string, user: string, opts: ReadOpts = {}): string {
  const grantGuard = opts.grantGuard
    ? `(${opts.grantGuard} AND ${institutionReachNotForStudentsSql(event)})`
    : institutionReachNotForStudentsSql(event);
  const coOpts: ReadOpts = { ...opts, grantGuard };
  const ownOpts: ReadOpts = {
    ...coOpts,
    spaceFilter: (space) => institutionReachHoldsSpaceSql(event, space),
  };
  const coOrganiserMember = `EXISTS (SELECT 1 FROM association_calendar_event_co_owners vis_comember
      WHERE vis_comember.event_id = ${event}.id
        AND ${isMemberSql('vis_comember.association_id', user)})`;
  return `((${institutionReachAdmitsUserSql(event, user)} OR ${coOrganiserMember})
    AND (${associationVisibleToUserSql(`${event}."associationId"`, user, ownOpts)}
    OR ${institutionReachStaffCampusDoorSql(event, user)}
    OR EXISTS (SELECT 1 FROM association_calendar_event_co_owners vis_coorg
      WHERE vis_coorg.event_id = ${event}.id
        AND ${associationVisibleToUserSql('vis_coorg.association_id', user, coOpts)})))`;
}

/**
 * THE EVENT CARD ON A POST, AND THE EVENT A POST LINKS (owner, 2026-11-13): an event carrying no
 * reach is shown wherever its post is, as before; one an institution gave a reach is shown only to a
 * viewer (placeholder `viewer`) the event's own predicate admits ({@link eventVisibleToViewerSql}) -
 * "an event announced by a post keeps its own visibility". An absent viewer sees no reached event.
 */
export function eventCardShownToViewerSql(event: string, viewer: string): string {
  return `(${event}."reachPublic" IS NULL OR ${eventVisibleToViewerSql(event, viewer)})`;
}

/**
 * Event row `event` is visible to the viewer whose id is the placeholder `viewer` - the signed-in
 * agenda's filter (`AssociationsService.restrictToViewerSpaces`). An absent viewer sees nothing.
 */
export function eventVisibleToViewerSql(event: string, viewer: string): string {
  return `EXISTS (SELECT 1 FROM users vis_viewer WHERE vis_viewer.id = ${viewer} AND ${eventVisibleToUserSql(event, 'vis_viewer', { readGrants: true })})`;
}

/**
 * THE FEED GATE: may user `$1` use the feed at all - an admin, someone with at least one space, a
 * member of at least one association (whose content D21 opens to them), a named reader holding a
 * read grant (WP7), a review account (whose cohort is a space of its own), or - since WP-F5 - the
 * holder of at least one ACCEPTED follow (one made before follow requests existed included). Without that last one a
 * staff member with no space and no membership was PUSHED a followed person's post and then refused
 * the feed that holds it (F3 of the WP-F5 review): the push and the read now agree. And - since the
 * staff-by-campus door (owner, 2026-11-14) - staff of a campus that an INSTITUTION's rules reach: an
 * institution's "Tous" or "Personnel" post may reach them, so they are told of it and must be able to
 * open it. Which posts they get is still the per-post predicate. Answers `inAudience`.
 */
export const IN_FEED_AUDIENCE_SQL = `SELECT EXISTS (SELECT 1 FROM users gate_user WHERE gate_user.id = $1 AND (
    ${isAdminSql('gate_user')}
    OR EXISTS (SELECT 1 FROM spaces gate_space WHERE ${isReaderSpaceSql('gate_space', 'gate_user')})
    OR ${inReviewCohortSql('gate_user.id')}
    OR EXISTS (SELECT 1 FROM association_members gate_member WHERE gate_member."userId" = gate_user.id)
    OR EXISTS (SELECT 1 FROM read_grants gate_grant WHERE gate_grant.user_id = gate_user.id)
    OR EXISTS (SELECT 1 FROM user_follows gate_follow
      WHERE gate_follow."followerUserId" = gate_user.id AND ${acceptedFollowSql('gate_follow')})
    OR (${isCampusStaffSql('gate_user')} AND EXISTS (SELECT 1 FROM associations gate_inst
      JOIN association_audiences gate_rule ON gate_rule."associationId" = gate_inst.id
      JOIN spaces gate_cspace ON ${ruleReachesSpaceSql('gate_rule', 'gate_cspace')}
      WHERE gate_inst.type = 'institution' AND gate_cspace.campus = gate_user.campus))
  )) AS "inAudience"`;

/**
 * Asks `IN_FEED_AUDIENCE_SQL` for one user. `=== true` and nothing looser: `EXISTS` gives a real
 * boolean, and a driver change that started returning `'t'` or `1` must not widen the gate.
 */
export async function readInFeedAudience(
  manager: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  userId: string
): Promise<boolean> {
  const rows = await manager.query(IN_FEED_AUDIENCE_SQL, [userId]);
  return Array.isArray(rows) && rows.length > 0 && rows[0].inAudience === true;
}

/** The spaces of user `$1`, as pairs - the SQL twin of `readerSpaces`, which the test compares. */
export const READER_SPACES_SQL = `SELECT s.formation, s.campus FROM spaces s JOIN users u ON u.id = $1
  WHERE ${isReaderSpaceSql('s', 'u')} ORDER BY s.campus, s.formation`;

/**
 * THE SPACES A READER'S AGENDA REACHES (owner, 2026-11-10: a reader whose agenda shows several
 * spaces narrows the VIEW by space): their OWN spaces; every space the rules of an association they
 * are a MEMBER of address (a BDE's, an association spanning formations); and, for a read grant, the
 * spaces of a ticked cell that some association addresses. A student with no wider role therefore
 * reaches exactly one space and is offered no filter - an association merely VISIBLE to them through
 * its rules adds nothing, or a campus-wide association would give every student five formations.
 * THE (NULL, NULL) "EVERYONE" RULE ADDRESSES NO SPACE HERE: an institution speaking to everyone is
 * visible to all and reaches every space, which would offer every reader every option. Only the
 * rules that name a campus or a formation count (lead's decision, 2026-11-10).
 * It is the vocabulary the feed's `campus` / `formation` narrowing (`eventReachesSpaceMatchingSql`)
 * speaks, so an option offered matches events the reader may see. A reading aid, never access.
 */
function addressesSpaceSpecificallySql(association: string, space: string): string {
  return `EXISTS (SELECT 1 FROM association_audiences ag_rule
    WHERE ag_rule."associationId" = ${association}
      AND (ag_rule.formation IS NOT NULL OR ag_rule.campus IS NOT NULL)
      AND ${ruleReachesSpaceSql('ag_rule', space)})`;
}

/** The spaces of user `$1`'s agenda, as described above `addressesSpaceSpecificallySql`. */
export const AGENDA_REACHED_SPACES_SQL = `SELECT s.formation, s.campus FROM spaces s
  JOIN users ag_user ON ag_user.id = $1
  WHERE ${isReaderSpaceSql('s', 'ag_user')}
    OR EXISTS (SELECT 1 FROM associations ag_member
      WHERE ${isMemberSql('ag_member.id', 'ag_user')}
        AND ${addressesSpaceSpecificallySql('ag_member.id', 's')})
    OR (EXISTS (SELECT 1 FROM read_grants ag_grant
        WHERE ag_grant.user_id = ag_user.id AND ag_grant.campus = s.campus
          AND (ag_grant.formation IS NULL OR ag_grant.formation = s.formation))
      AND EXISTS (SELECT 1 FROM associations ag_granted
        WHERE ${addressesSpaceSpecificallySql('ag_granted.id', 's')}))
  ORDER BY s.campus, s.formation`;

/** The profile facts of user `$1`, for `campusWideReaderCampus` (asked for a reader with no space). */
export const READER_PROFILE_SQL = `SELECT id, campus, cursus FROM users WHERE id = $1`;

/**
 * Who is told about post `$1`: everyone who can SEE it, minus its author. The scheduler narrows a
 * personal post further to its author's ACCEPTED followers (`followersOnly`): a pending request is
 * not a follow (WP-F1). A block either way excludes the follower even when the block's severing
 * missed the follow row: a reader who shares the author's space SEES the post by the space rule, so
 * the visibility term alone would let the left-over row ring their bell and push them - the same
 * term as `newlyReachedByPersonalRepublicationSql` and the live push (`liveAudienceSql`).
 */
export function announceRecipientsSql(followersOnly: boolean): string {
  const follows = followersOnly
    ? `AND EXISTS (SELECT 1 FROM user_follows ann_follow
         WHERE ann_follow."followedUserId" = ann_post."authorId" AND ann_follow."followerUserId" = ann_user.id
           AND ${acceptedFollowSql('ann_follow')})
      AND NOT EXISTS (SELECT 1 FROM user_blocks ann_block
         WHERE (ann_block."blockerId" = ann_user.id AND ann_block."blockedId" = ann_post."authorId")
            OR (ann_block."blockerId" = ann_post."authorId" AND ann_block."blockedId" = ann_user.id))`
    : '';
  return `SELECT ann_user.id FROM users ann_user JOIN posts ann_post ON ann_post.id = $1
    WHERE ann_user.id <> ann_post."authorId" ${follows}
      AND ${postVisibleToUserSql('ann_post', 'ann_user')}`;
}

/**
 * WHO IS TOLD ABOUT ENTITY POST `$1` (`announceRecipientsSql(false)`), AND THE ANNOUNCEMENT'S SHARE
 * OF THE TOLD-ONCE LEDGER (WP-F6), IN ONE STATEMENT: of those readers, the ones who see the post
 * ONLY through a member repost are recorded in `member_repost_notices`. A repost of an entity post
 * not yet announced tells nobody (the sweep will), so without this the repost path's ledger never
 * held those readers: a take-back then a repost - by the same member or another - found them newly
 * reached again and told them a second time, as `member_repost` after `association_post`.
 *
 * ONE STATEMENT, NOT TWO: the recipients and the ledger rows are read on the SAME snapshot. As two
 * READ COMMITTED statements, an `unrepost` (which takes no lock) committing between them left a
 * reader in the recipients - reached through that repost - but out of the ledger, so the next
 * repost told them again. Here a reader is recorded exactly when the set the bell is handed reached
 * them through a repost.
 *
 * Only for an ENTITY post: a personal post is announced to its author's accepted followers, who see
 * it first-hand (WP-F5), so its ledger share is always empty and nothing is asked. A reader who sees
 * the post first-hand is not recorded: if they lose that access later - leaving the space, a rule
 * removed - and a repost reaches them, they are told then, which is the D38 rule at that moment and
 * not a second notice of the same reach. Nothing is written for a post nobody reposted.
 */
export const ANNOUNCE_ENTITY_RECIPIENTS_RECORDING_REPOSTS_SQL = `WITH ann_recipients AS (
    ${announceRecipientsSql(false)}
  ), ann_recorded AS (
    INSERT INTO member_repost_notices ("postId", "recipientId")
    SELECT rn_post.id, rn_user.id FROM posts rn_post
      JOIN ann_recipients rn_recipient ON true
      JOIN users rn_user ON rn_user.id = rn_recipient.id
     WHERE rn_post.id = $1
       AND EXISTS (SELECT 1 FROM member_reposts rn_rep WHERE rn_rep."postId" = rn_post.id)
       AND NOT ${postVisibleToUserSql('rn_post', 'rn_user', { memberReposts: false })}
    ON CONFLICT DO NOTHING
  )
  SELECT id FROM ann_recipients`;
