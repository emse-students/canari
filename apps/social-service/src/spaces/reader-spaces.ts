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

/** Rule row `rule` reaches at least one space of user row `user`. */
function ruleReachesUserSql(rule: string, user: string): string {
  return `EXISTS (SELECT 1 FROM spaces rs_space WHERE ${isReaderSpaceSql('rs_space', user)}
    AND ${ruleReachesSpaceSql(rule, 'rs_space')})`;
}

/** User row `user` is a member of association `association` (an id expression). Any row counts. */
export function isMemberSql(association: string, user: string): string {
  return `EXISTS (SELECT 1 FROM association_members vis_member
    WHERE vis_member."associationId" = ${association} AND vis_member."userId" = ${user}.id)`;
}

/** The association's own rules (its ceiling) reach user row `user`. */
function associationRulesReachUserSql(association: string, user: string): string {
  return `EXISTS (SELECT 1 FROM association_audiences vis_arule
    WHERE vis_arule."associationId" = ${association} AND ${ruleReachesUserSql('vis_arule', user)})`;
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
export function readGrantReachesAssociationSql(association: string, user: string): string {
  return `EXISTS (SELECT 1 FROM read_grants rg_grant
    JOIN spaces rg_space ON rg_space.campus = rg_grant.campus
      AND (rg_grant.formation IS NULL OR rg_grant.formation = rg_space.formation)
    JOIN association_audiences rg_rule ON rg_rule."associationId" = ${association}
      AND ${ruleReachesSpaceSql('rg_rule', 'rg_space')}
    WHERE rg_grant.user_id = ${user}.id)`;
}

/**
 * Whether a predicate also counts NOMINATIVE READ GRANTS. Off by default, on for the READ paths only
 * (`*ToViewerSql`: the feed, a post, its comments and reactions, the signed-in agenda): the
 * recipients of an announcement and of a republication are computed with the plain predicate, so a
 * named reader is NEVER notified for their perimeter (user, 2026-10-07).
 */
export interface ReadOpts {
  readGrants?: boolean;
}

/**
 * What a caller is about to do with a post it has opened. A nominative read grant covers
 * `'READ_OR_REACT'` (read, react, comment, like a comment) and NOT `'VOTE'`: a poll vote, like a
 * republication, is never opened by a grant (user, 2026-10-07).
 */
export type PostAccessIntent = 'READ_OR_REACT' | 'VOTE';

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
  const grant = opts.readGrants
    ? `\n    OR ${readGrantReachesAssociationSql(association, user)}`
    : '';
  return `(${isMemberSql(association, user)} OR ${associationRulesReachUserSql(association, user)}${grant})`;
}

/**
 * The directory's map filter (D37): association `association`'s OWN rules reach at least one space
 * matching `filter`, whose sides are SQL expressions (placeholders) or `null` for "any side". Rules
 * only - a membership does not put an association on a campus it does not address. Both sides
 * `null` is "reaches any space at all", which an association with no rule does not.
 */
export function associationRulesReachSpaceMatchingSql(
  association: string,
  filter: { formation: string | null; campus: string | null }
): string {
  const formation =
    filter.formation === null ? '' : ` AND dir_space.formation = ${filter.formation}`;
  const campus = filter.campus === null ? '' : ` AND dir_space.campus = ${filter.campus}`;
  return `EXISTS (SELECT 1 FROM association_audiences dir_rule
    JOIN spaces dir_space ON ${ruleReachesSpaceSql('dir_rule', 'dir_space')}
    WHERE dir_rule."associationId" = ${association}${formation}${campus})`;
}

/**
 * The anonymous agenda's selection (D40): calendar event row `event` is reached by a space matching
 * `filter` (sides as in `associationRulesReachSpaceMatchingSql`) through its ORGANISER's rules or an
 * ACCEPTED co-organiser's (D39), the union an event's audience is. Rules only, like the map filter:
 * an anonymous reader has no membership, so D21 has nothing to add. Both sides `null` is not a
 * selection and the caller must not splice it.
 */
export function eventReachesSpaceMatchingSql(
  event: string,
  filter: { formation: string | null; campus: string | null }
): string {
  return `(${associationRulesReachSpaceMatchingSql(`${event}."associationId"`, filter)}
    OR EXISTS (SELECT 1 FROM association_calendar_event_co_owners sel_coorg
      WHERE sel_coorg.event_id = ${event}.id
        AND ${associationRulesReachSpaceMatchingSql('sel_coorg.association_id', filter)}))`;
}

/**
 * An association that REPUBLISHED post row `post` (D38, `post_republications`) is visible to user
 * row `user` - the same predicate as the original's association, applied to the republisher: a
 * member of it (D21) or a reader its rules reach.
 */
function republicationReachesUserSql(post: string, user: string, opts: ReadOpts = {}): string {
  return `EXISTS (SELECT 1 FROM post_republications vis_rep WHERE vis_rep."postId" = ${post}.id
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
 *   published and never what a student wrote.
 *
 * MONOTONE IN REPUBLICATIONS, and `NEWLY_REACHED_BY_REPUBLICATION_SQL` relies on it: adding one
 * only ever adds a disjunct, so who sees a post after is who saw it before plus who the republisher
 * reaches.
 */
export function postVisibleToUserSql(
  post: string,
  user: string,
  opts: { adminSeesAll?: boolean } & ReadOpts = {}
): string {
  const adminClause = opts.adminSeesAll ? `${isAdminSql(user)}\n    OR ` : '';
  return `(${adminClause}${post}."authorId" = ${user}.id
    OR (${post}."associationId" IS NULL AND (
      ${sharesSpaceWithAuthorSql(`${post}."authorId"`, user)}
      OR ${republicationReachesUserSql(post, user)}))
    OR (${post}."associationId" IS NOT NULL AND (
      ${associationVisibleToUserSql(`${post}."associationId"`, user, { readGrants: opts.readGrants })}
      OR ${republicationReachesUserSql(post, user, { readGrants: opts.readGrants })})))`;
}

/**
 * Who would see post `$1` for the FIRST time if association `$2` republished it: the readers the
 * association reaches who cannot see the post NOW, minus its author. Asked inside the transaction
 * that writes the republication, BEFORE the row exists - with `postVisibleToUserSql` monotone, that
 * is exactly "visible after and not before", computed on state and never on a clock.
 */
export const NEWLY_REACHED_BY_REPUBLICATION_SQL = `SELECT nr_user.id FROM users nr_user
  JOIN posts nr_post ON nr_post.id = $1
  WHERE nr_user.id <> nr_post."authorId"
    AND ${associationVisibleToUserSql('$2::uuid', 'nr_user')}
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
 *   request is still pending is not told by the sweep, so they are told here.
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
 * Post row `post` is visible to the viewer whose id is the placeholder `viewer` (`$5`, or a TypeORM
 * `:name`). An absent viewer (NULL) matches no `users` row, so it sees nothing.
 */
export function postVisibleToViewerSql(
  post: string,
  viewer: string,
  opts: { adminSeesAll?: boolean; readGrants?: boolean } = {}
): string {
  // Grants count by default (every READ path); a WRITE that a grant never opened - a vote, a
  // republication - passes `readGrants: false`, explicitly.
  return `EXISTS (SELECT 1 FROM users vis_viewer WHERE vis_viewer.id = ${viewer} AND ${postVisibleToUserSql(post, 'vis_viewer', { ...opts, readGrants: opts.readGrants ?? true })})`;
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
 * with the broadcaster; an association's live, a user who sees the association (a member, or its
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
    OR (${live}."associationId" IS NULL AND ${sharesSpaceWithAuthorSql(`${live}."broadcasterId"`, user)})
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
 * Calendar event row `event` (an `association_calendar_events` row) is visible to user row `user`
 * (D39): its ORGANISER is visible to them, or an ACCEPTED co-organiser is - the same association
 * predicate for each, membership (D21) included. An event has no space rules of its own, so its
 * reach is the union of those audiences. A pending or refused co-organiser has no row in
 * `association_calendar_event_co_owners` (it lives in `proposals`), so it adds nothing; one that
 * leaves takes its row and its audience with it, and the next read is recomputed without it.
 *
 * Status and dates are NOT decided here: each caller keeps its own (validated only, a window).
 */
export function eventVisibleToUserSql(event: string, user: string, opts: ReadOpts = {}): string {
  return `(${associationVisibleToUserSql(`${event}."associationId"`, user, opts)}
    OR EXISTS (SELECT 1 FROM association_calendar_event_co_owners vis_coorg
      WHERE vis_coorg.event_id = ${event}.id
        AND ${associationVisibleToUserSql('vis_coorg.association_id', user, opts)}))`;
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
 * read grant (WP7), or a review account (whose cohort is a space of its own). Answers `inAudience`.
 */
export const IN_FEED_AUDIENCE_SQL = `SELECT EXISTS (SELECT 1 FROM users gate_user WHERE gate_user.id = $1 AND (
    ${isAdminSql('gate_user')}
    OR EXISTS (SELECT 1 FROM spaces gate_space WHERE ${isReaderSpaceSql('gate_space', 'gate_user')})
    OR ${inReviewCohortSql('gate_user.id')}
    OR EXISTS (SELECT 1 FROM association_members gate_member WHERE gate_member."userId" = gate_user.id)
    OR EXISTS (SELECT 1 FROM read_grants gate_grant WHERE gate_grant.user_id = gate_user.id)
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

/** The profile facts of user `$1`, for `campusWideReaderCampus` (asked for a reader with no space). */
export const READER_PROFILE_SQL = `SELECT id, campus, cursus FROM users WHERE id = $1`;

/**
 * Who is told about post `$1`: everyone who can SEE it, minus its author. The scheduler narrows a
 * personal post further to its author's ACCEPTED followers (`followersOnly`): a pending request is
 * not a follow (WP-F1).
 */
export function announceRecipientsSql(followersOnly: boolean): string {
  const follows = followersOnly
    ? `AND EXISTS (SELECT 1 FROM user_follows ann_follow
         WHERE ann_follow."followedUserId" = ann_post."authorId" AND ann_follow."followerUserId" = ann_user.id
           AND ${acceptedFollowSql('ann_follow')})`
    : '';
  return `SELECT ann_user.id FROM users ann_user JOIN posts ann_post ON ann_post.id = $1
    WHERE ann_user.id <> ann_post."authorId" ${follows}
      AND ${postVisibleToUserSql('ann_post', 'ann_user')}`;
}
