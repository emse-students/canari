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

// ── SQL ─────────────────────────────────────────────────────────────────────────────────────────
// Every helper takes the SQL ALIASES it is spliced against (a `users` row, a `spaces` row, a rule
// row) and uses its own inner aliases, each distinct, so nesting never shadows a name.

/**
 * Space row `space` is one of user row `user`'s spaces. Containment (`@>`) rather than
 * `jsonb_array_elements`: a malformed `cursus` (not an array) simply contains nothing, where the
 * function would raise and take every reader's query down with one bad row.
 */
export function isReaderSpaceSql(space: string, user: string): string {
  return `(${space}.campus = ${user}.campus AND ${user}.cursus @> jsonb_build_array(jsonb_build_object('formation', ${space}.formation)))`;
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
 * Association `association` is visible to user row `user`: a member (D21), or its rules reach one of
 * the user's spaces. The agenda's predicate. A global admin is a reader like any other here (user,
 * 2026-10-04): browsing is not a moderation power, so an admin who is an ICM student sees what an
 * ICM student sees.
 */
export function associationVisibleToUserSql(association: string, user: string): string {
  return `(${isMemberSql(association, user)} OR ${associationRulesReachUserSql(association, user)})`;
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
 * An association that REPUBLISHED post row `post` (D38, `post_republications`) is visible to user
 * row `user` - the same predicate as the original's association, applied to the republisher: a
 * member of it (D21) or a reader its rules reach.
 */
function republicationReachesUserSql(post: string, user: string): string {
  return `EXISTS (SELECT 1 FROM post_republications vis_rep WHERE vis_rep."postId" = ${post}.id
      AND ${associationVisibleToUserSql('vis_rep."associationId"', user)})`;
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
 * - a personal post (anonymous included): the user shares at least one space with its AUTHOR.
 *
 * MONOTONE IN REPUBLICATIONS, and `NEWLY_REACHED_BY_REPUBLICATION_SQL` relies on it: adding one
 * only ever adds a disjunct, so who sees a post after is who saw it before plus who the republisher
 * reaches.
 */
export function postVisibleToUserSql(
  post: string,
  user: string,
  opts: { adminSeesAll?: boolean } = {}
): string {
  const adminClause = opts.adminSeesAll ? `${isAdminSql(user)}\n    OR ` : '';
  return `(${adminClause}${post}."authorId" = ${user}.id
    OR (${post}."associationId" IS NULL AND EXISTS (
      SELECT 1 FROM users vis_author JOIN spaces vis_shared ON ${isReaderSpaceSql('vis_shared', 'vis_author')}
      WHERE vis_author.id = ${post}."authorId" AND ${isReaderSpaceSql('vis_shared', user)}))
    OR (${post}."associationId" IS NOT NULL AND (
      ${associationVisibleToUserSql(`${post}."associationId"`, user)}
      OR ${republicationReachesUserSql(post, user)})))`;
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
 * Post row `post` is visible to the viewer whose id is the placeholder `viewer` (`$5`, or a TypeORM
 * `:name`). An absent viewer (NULL) matches no `users` row, so it sees nothing.
 */
export function postVisibleToViewerSql(
  post: string,
  viewer: string,
  opts: { adminSeesAll?: boolean } = {}
): string {
  return `EXISTS (SELECT 1 FROM users vis_viewer WHERE vis_viewer.id = ${viewer} AND ${postVisibleToUserSql(post, 'vis_viewer', opts)})`;
}

/** Association `association` is visible to the viewer whose id is the placeholder `viewer`. */
export function associationVisibleToViewerSql(association: string, viewer: string): string {
  return `EXISTS (SELECT 1 FROM users vis_viewer WHERE vis_viewer.id = ${viewer} AND ${associationVisibleToUserSql(association, 'vis_viewer')})`;
}

/**
 * THE FEED GATE: may user `$1` use the feed at all - an admin, someone with at least one space, or
 * a member of at least one association (whose content D21 opens to them). Answers `inAudience`.
 */
export const IN_FEED_AUDIENCE_SQL = `SELECT EXISTS (SELECT 1 FROM users gate_user WHERE gate_user.id = $1 AND (
    ${isAdminSql('gate_user')}
    OR EXISTS (SELECT 1 FROM spaces gate_space WHERE ${isReaderSpaceSql('gate_space', 'gate_user')})
    OR EXISTS (SELECT 1 FROM association_members gate_member WHERE gate_member."userId" = gate_user.id)
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
 * Who is told about post `$1`: everyone who can SEE it, minus its author. The scheduler narrows a
 * personal post further to its author's followers (`followersOnly`).
 */
export function announceRecipientsSql(followersOnly: boolean): string {
  const follows = followersOnly
    ? `AND EXISTS (SELECT 1 FROM user_follows ann_follow
         WHERE ann_follow."followedUserId" = ann_post."authorId" AND ann_follow."followerUserId" = ann_user.id)`
    : '';
  return `SELECT ann_user.id FROM users ann_user JOIN posts ann_post ON ann_post.id = $1
    WHERE ann_user.id <> ann_post."authorId" ${follows}
      AND ${postVisibleToUserSql('ann_post', 'ann_user')}`;
}
