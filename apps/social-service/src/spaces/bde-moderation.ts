import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { bdeStandingInSpaceSql, holdsBdeFlagOverSql } from './bde';
import { isReaderSpaceSql } from './reader-spaces';

/**
 * THE SCOPE OF A BDE MODERATOR (owner, 2026-11-02, amending D23).
 *
 * `MODERATE` used to be global: a member holding it in ANY BDE curated the whole platform. It is now
 * read like `VALIDATE_EVENTS` and `MANAGE_ASSO` (`holdsBdeFlagOverSql`): a BDE moderates only what
 * lives in the spaces it governs. A platform administrator is not asked any of this - they stay
 * global, and every caller short-circuits on them before splicing a fragment from here.
 *
 * "In the governed spaces" means, for each kind of target:
 * - an ASSOCIATION's content (a post or a live in its name): the association is reached by a space
 *   the BDE governs - exactly `holdsBdeFlagOverSql`, so an association reaching no space is governed
 *   by nobody but the platform admin, and so is an INSTITUTION: no BDE governs one (owner, 2026-11-02
 *   and 2026-11-03), so no BDE moderates its content either. The same predicate leaves a BDE's own
 *   content to its own members, as its management is;
 * - a PERSON's content (a personal post or live): its author belongs to one of the spaces the BDE
 *   governs - the same per-space standing (`bdeStandingInSpaceSql`) every BDE power reads
 *   (`isReaderSpaceSql`, the readers' own definition). Someone with no space - staff, a review
 *   account - is left to the platform admin, as an association with no audience rule is;
 * - a PERSON themselves (a mute, a broadcast withdrawal, a report on an account): the same "belongs to
 *   one of the BDE's spaces".
 *
 * A comment is judged by the post it sits under, a live chat line by its live: the place the content
 * is shown is the place whose BDE answers for it - AND, for a comment, by its publisher too: a comment
 * in an association's name is that association's content, so a BDE moderates it only when it
 * moderates what that association publishes (owner, 2026-11-03: no BDE moderates content published in
 * an institution's or another BDE's name, whatever the path; `bdeModeratesCommentSql`).
 *
 * THE ONE PREDICATE. "May this BDE moderator act on this content" is `bdeModeratesPublisherSql` for
 * whatever is published in an association's name, and the per-space standing for a person's - every
 * kind of target below composes those two, and nothing else decides a BDE moderator's reach. A
 * platform administrator is never asked: every caller short-circuits on them first.
 *
 * Its own module because it splices both `bde.ts` (which the `Association` entity imports, so it must
 * import nothing reaching back) and `reader-spaces.ts`.
 */

const MODERATE = String(AssociationPermissionFlag.MODERATE);

/** 403 `code`: the caller moderates somewhere, but not where this target lives. */
export const MODERATION_OUT_OF_SCOPE = 'MODERATION_OUT_OF_SCOPE';
/**
 * 403 `code`: the target is published in an INSTITUTION's or a BDE's name (or is a comment under
 * a post in such a name), which no other BDE moderates - the platform admin's (owner, 2026-11-03).
 * Classified at the throw (`AssociationsService.refuseModeration`, `MODERATION_RESERVED_SQL`), so the
 * client words "only the platform administration moderates this" rather than "outside your spaces".
 */
export const MODERATION_RESERVED_TO_PLATFORM_ADMIN = 'MODERATION_RESERVED_TO_PLATFORM_ADMIN';
/**
 * What a refused moderation act was aimed at - logged, and classified by `MODERATION_RESERVED_SQL`.
 * `postId` names the post a comment sits under, when the caller knows it.
 */
export interface ModerationTarget {
  kind: 'post' | 'live' | 'comment' | 'report' | 'user' | 'broadcaster';
  id: string;
  postId?: string | null;
}

/** 403 `code`: the caller moderates nowhere (neither a platform admin nor a BDE `MODERATE` holder). */
export const MODERATOR_REQUIRED = 'MODERATOR_REQUIRED';
/** 403 `code`: editing another person's post, which no moderator may do (owner, 2026-11-02). */
export const POST_EDIT_PUBLISHER_ONLY = 'POST_EDIT_PUBLISHER_ONLY';
/** 403 `code`: editing another person's comment, which no moderator may do either (owner, 2026-11-02). */
export const COMMENT_EDIT_AUTHOR_ONLY = 'COMMENT_EDIT_AUTHOR_ONLY';
/**
 * 403 `code`: deleting a comment the caller neither wrote, nor speaks for, nor moderates. A 403 and
 * never a 401: only a 401 may log a user out, and this caller's session is fine.
 */
export const COMMENT_DELETE_FORBIDDEN = 'COMMENT_DELETE_FORBIDDEN';

/**
 * User `moderator` holds `MODERATE` in the BDE of a space that user `target` belongs to. Both are SQL
 * expressions (a placeholder, or a column).
 */
export function bdeModeratesUserSql(moderator: string, target: string): string {
  return `EXISTS (SELECT 1 FROM association_members mod_member
    JOIN spaces mod_space ON ${bdeStandingInSpaceSql('mod_member', 'mod_space', moderator, MODERATE)}
    JOIN users mod_target ON mod_target.id = ${target}
    WHERE ${isReaderSpaceSql('mod_space', 'mod_target')})`;
}

/**
 * THE PUBLISHER HALF OF THE ONE PREDICATE: user `moderator` holds `MODERATE` over what is published in
 * the name of association `association` (a non-NULL SQL expression) - the association is reached by a
 * space the moderator's BDE governs (`holdsBdeFlagOverSql`, the management predicate). So it is FALSE,
 * whatever the audience reaches, for an INSTITUTION and for ANOTHER BDE (owner, 2026-11-02 and
 * 2026-11-03: only the platform admin moderates those), and for an association reaching none of the
 * moderator's spaces. A BDE's own content stays its own moderators'.
 */
export function bdeModeratesPublisherSql(moderator: string, association: string): string {
  return holdsBdeFlagOverSql(moderator, association, MODERATE);
}

/**
 * User `moderator` holds `MODERATE` over a piece of content published in the name of `association`
 * (NULL for a personal one) by `author` - a post or a live. All three are SQL expressions.
 */
export function bdeModeratesContentSql(
  moderator: string,
  association: string,
  author: string
): string {
  return `((${association} IS NOT NULL AND ${bdeModeratesPublisherSql(moderator, association)})
    OR (${association} IS NULL AND ${author} IS NOT NULL AND ${bdeModeratesUserSql(moderator, author)}))`;
}

/** The association a stored comment (a `jsonb` SQL expression) speaks for, as a uuid; NULL for a person's. */
function commentPublisherSql(comment: string): string {
  return asUuidOrNullSql(`${comment}->>'associationId'`);
}

/**
 * User `moderator` moderates, as a BDE, the comment `comment` (a `jsonb` element) of post row `post`
 * (an alias): the post is in scope (the place) AND the comment's own publisher is (an association's
 * comment is that association's content) - judged on the comment ITSELF, as a post is. Its replies do
 * not shield it (lead's decision, 2026-11-04): a delete that meets a reply the moderator does not
 * moderate leaves a moderation TOMBSTONE instead of taking that reply (`posts/comment-removal.ts`).
 *
 * `commentRights` (`posts/comment-identity.ts`) applies the same rule in memory (`moderatesComment`),
 * on the publisher set `BDE_MODERATED_ASSOCIATION_IDS_SQL` answers.
 *
 * The publisher half is an UNCORRELATED set - the associations the moderator moderates, hashed once
 * per query - and never the predicate re-run per comment: the report queue meets every comment of
 * every post in scope, and the per-row form cost 2.6 s on 20,000 comments where the set costs a hash
 * probe each (measured 2026-11-04, [moderation-and-blocking](docs/wiki/moderation-and-blocking.md)).
 */
export function bdeModeratesCommentSql(moderator: string, post: string, comment: string): string {
  return `(${bdeModeratesContentSql(moderator, `${post}."associationId"`, `${post}."authorId"`)}
    AND (${commentPublisherSql(comment)} IS NULL
      OR ${commentPublisherSql(comment)} IN (SELECT mcp.id FROM associations mcp
        WHERE ${bdeModeratesPublisherSql(moderator, 'mcp.id')})))`;
}

/**
 * Does user `$1` moderate, as a BDE, comment `$3` (text) of post `$2` (text; not a uuid answers
 * false)? Answers `moderates`. The act of `POST /moderation/comments/:id/delete`.
 */
export const BDE_MODERATES_COMMENT_SQL = `SELECT EXISTS (SELECT 1 FROM posts mc_post
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(mc_post.comments, '[]'::jsonb)) mc_comment
  WHERE mc_post.id = ${asUuidOrNullSql('$2::text')} AND mc_comment->>'id' = $3::text
    AND ${bdeModeratesCommentSql('$1', 'mc_post', 'mc_comment')}) AS "moderates"`;

/**
 * The ids, among associations `$2`, whose published content user `$1` moderates as a BDE
 * (`bdeModeratesPublisherSql`). Answers `id`. What `commentRights` reads per comment.
 */
export const BDE_MODERATED_ASSOCIATION_IDS_SQL = `SELECT ma.id::text AS id FROM associations ma
  WHERE ma.id = ANY($2::uuid[]) AND ${bdeModeratesPublisherSql('$1', 'ma.id')}`;

/**
 * Association `association` (a SQL expression, may be NULL) is an INSTITUTION or the BDE of a space:
 * a publisher whose content no other BDE moderates (owner, 2026-11-03). It only CLASSIFIES a refusal
 * (`MODERATION_RESERVED_SQL`); it grants and refuses nothing.
 */
function reservedPublisherSql(association: string): string {
  return `EXISTS (SELECT 1 FROM associations rsv WHERE rsv.id = ${association}
    AND (rsv.type = 'institution' OR EXISTS (SELECT 1 FROM spaces rsv_space
      WHERE rsv_space."bdeAssociationId" = rsv.id)))`;
}

/** Post `postId` (a uuid SQL expression) is published in a reserved name. */
function postReservedSql(postId: string): string {
  return `EXISTS (SELECT 1 FROM posts rsv_post WHERE rsv_post.id = ${postId}
    AND ${reservedPublisherSql('rsv_post."associationId"')})`;
}

/** Live `liveId` (a uuid SQL expression; its cut once purged) is broadcast in a reserved name. */
function liveReservedSql(liveId: string): string {
  return `EXISTS (SELECT 1 FROM (
    SELECT rl."associationId" FROM lives rl WHERE rl.id = ${liveId}
    UNION ALL SELECT rcut."associationId" FROM live_cuts rcut WHERE rcut."liveId" = ${liveId}
  ) rsv_live WHERE ${reservedPublisherSql('rsv_live."associationId"')})`;
}

/**
 * Comment `commentId` (a text SQL expression) sits under a post published in a reserved name, or is
 * itself in such a name. `postId` (a uuid SQL expression, or NULL) narrows the scan to one post when
 * the caller knows it.
 */
function commentReservedSql(commentId: string, postId: string): string {
  return `EXISTS (SELECT 1 FROM posts rsv_cpost
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(rsv_cpost.comments, '[]'::jsonb)) rsv_c
    WHERE (${postId} IS NULL OR rsv_cpost.id = ${postId})
      AND rsv_c->>'id' = ${commentId}
      AND (${reservedPublisherSql('rsv_cpost."associationId"')}
        OR ${reservedPublisherSql(commentPublisherSql('rsv_c'))}))`;
}

/**
 * THE CLASSIFICATION OF A REFUSED MODERATION ACT: is target `$2` (text) of kind `$1` - `post`, `live`,
 * `comment` (under post `$3`, text or NULL) or `report` (by what it is about) - published in an
 * institution's or a BDE's name? Answers `reserved`. Read only on the refusal path
 * (`AssociationsService.refuseModeration`), so its scans cost nothing on an accepted act.
 */
export const MODERATION_RESERVED_SQL = `SELECT (
    ($1::text = 'post' AND ${postReservedSql(asUuidOrNullSql('$2::text'))})
    OR ($1::text = 'live' AND ${liveReservedSql(asUuidOrNullSql('$2::text'))})
    OR ($1::text = 'comment' AND ${commentReservedSql('$2::text', asUuidOrNullSql('$3::text'))})
    OR ($1::text = 'report' AND EXISTS (SELECT 1 FROM content_reports rsv_r
      WHERE rsv_r.id = ${asUuidOrNullSql('$2::text')} AND (
        (rsv_r."contentType" = 'post' AND ${postReservedSql(asUuidOrNullSql('rsv_r."contentId"'))})
        OR (rsv_r."contentType" = 'live' AND ${liveReservedSql(asUuidOrNullSql('rsv_r."contentId"'))})
        OR (rsv_r."contentType" = 'comment' AND ${commentReservedSql('rsv_r."contentId"', 'NULL::uuid')}))))
  ) AS "reserved"`;

/** The ids, among posts `$2`, that user `$1` moderates as a BDE. Answers `id`. */
export const BDE_MODERATED_POST_IDS_SQL = `SELECT mp.id::text AS id FROM posts mp
  WHERE mp.id = ANY($2::uuid[]) AND ${bdeModeratesContentSql('$1', 'mp."associationId"', 'mp."authorId"')}`;

/**
 * The TEXT expression `text` as a uuid, or NULL when it is not one - so a report's free-text
 * `contentId` is cast on ITS side and the uuid primary keys it is compared with keep their indexes,
 * and a value that is not a uuid matches nothing instead of raising. The CASE is what guards the
 * cast: PostgreSQL folds a constant-false arm away without evaluating it.
 */
export function asUuidOrNullSql(text: string): string {
  return `(CASE WHEN (${text}) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (${text})::uuid END)`;
}

/**
 * User `moderator` moderates, as a BDE, the live whose id is the UUID expression `liveId` - read from
 * the live, or from its cut once the row is purged (`live_cuts` repeats both owners for this). A live
 * ended, never cut and purged has nothing left to scope and is left to the platform admin.
 */
export function bdeModeratesLiveSql(moderator: string, liveId: string): string {
  return `EXISTS (SELECT 1 FROM (
    SELECT ml."broadcasterId", ml."associationId" FROM lives ml WHERE ml.id = ${liveId}
    UNION ALL
    SELECT mc."broadcasterId", mc."associationId" FROM live_cuts mc WHERE mc."liveId" = ${liveId}
  ) mlive WHERE ${bdeModeratesContentSql(moderator, 'mlive."associationId"', 'mlive."broadcasterId"')})`;
}

/** Does user `$1` moderate, as a BDE, live `$2` (text; not a uuid answers false)? Answers `moderates`. */
export const BDE_MODERATES_LIVE_SQL = `SELECT ${bdeModeratesLiveSql('$1', asUuidOrNullSql('$2::text'))} AS "moderates"`;

/**
 * Report row `report` (a `content_reports` row) is about something user `moderator` moderates as a
 * BDE - what narrows the queue and every act on a report (owner, 2026-11-02):
 * - `post`: the post is in scope; `comment`: the comment is (`bdeModeratesCommentSql`: the post it sits
 *   under, and its own publisher);
 * - `user`: the reported person belongs to one of the BDE's spaces;
 * - `live`: the live is in scope; `live_chat`: the live of the kept line is (once the line is erased,
 *   nothing names its live and the report is the platform admin's).
 * A report whose content is gone (a deleted post or comment) is the platform admin's too.
 *
 * `contentId` is free text: each branch casts IT (`asUuidOrNullSql`), never the uuid key it meets, so
 * `posts`, `lives` and `live_cuts` are probed by primary key. A comment carries no post id, so its
 * branch is UNCORRELATED: the comment ids under the posts this moderator governs, computed ONCE per
 * query (a hashed subplan) and probed per report - never a scan of every post per report.
 */
export function reportInBdeScopeSql(report: string, moderator: string): string {
  const postInScope = bdeModeratesContentSql(moderator, 'rp."associationId"', 'rp."authorId"');
  const contentUuid = asUuidOrNullSql(`${report}."contentId"`);
  return `(
    (${report}."contentType" = 'post' AND EXISTS (SELECT 1 FROM posts rp
      WHERE rp.id = ${contentUuid} AND ${postInScope}))
    OR (${report}."contentType" = 'comment' AND ${report}."contentId" IN (SELECT rc->>'id'
      FROM posts rp CROSS JOIN LATERAL jsonb_array_elements(COALESCE(rp.comments, '[]'::jsonb)) rc
      WHERE ${bdeModeratesCommentSql(moderator, 'rp', 'rc')}))
    OR (${report}."contentType" = 'user' AND ${bdeModeratesUserSql(moderator, `${report}."contentId"`)})
    OR (${report}."contentType" = 'live' AND ${bdeModeratesLiveSql(moderator, contentUuid)})
    OR (${report}."contentType" = 'live_chat' AND EXISTS (SELECT 1 FROM live_chat_reported_lines rk
      WHERE rk."reportId" = ${report}.id AND ${bdeModeratesLiveSql(moderator, 'rk."liveId"')})))`;
}

/** Is report `$2` (text; not a uuid answers false) about something user `$1` moderates as a BDE? Answers `moderates`. */
export const BDE_MODERATES_REPORT_SQL = `SELECT EXISTS (SELECT 1 FROM content_reports sr
  WHERE sr.id = ${asUuidOrNullSql('$2::text')} AND ${reportInBdeScopeSql('sr', '$1')}) AS "moderates"`;

/** The ids, among users `$2`, that user `$1` moderates as a BDE (they belong to one of its spaces). Answers `id`. */
export const BDE_MODERATED_USER_IDS_SQL = `SELECT mu.id FROM users mu
  WHERE mu.id = ANY($2::varchar[]) AND ${bdeModeratesUserSql('$1', 'mu.id')}`;
