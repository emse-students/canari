import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import {
  bdeStandingInSpaceSql,
  governorIsAnAssociationSql,
  holdsBdeFlagOverSql,
  isBdeAssociationSql,
} from './bde';
import { isReaderSpaceSql } from './reader-spaces';

/**
 * THE SCOPE OF A BDE MODERATOR (owner, 2026-11-02, amending D23).
 *
 * `MODERATE` used to be global: a member holding it in ANY BDE curated the whole platform. It is now
 * read like `MANAGE_ASSO` (`holdsBdeFlagOverSql`): a BDE moderates only what its children publish and
 * what the people of its spaces publish. A platform administrator is not asked any of this - they stay
 * global, and every caller short-circuits on them before splicing a fragment from here.
 *
 * "In the governed spaces" means, for each kind of target:
 * - an ASSOCIATION's content (a post or a live in its name): the BDE is the association's PARENT
 *   (WP-R4 on WP-D2's governance, reform 2.4) - exactly `holdsBdeFlagOverSql`, so an association
 *   with no parent is moderated by nobody but the platform admin, whatever its audience reaches. No
 *   BDE governs an INSTITUTION (owner, 2026-11-02 and 2026-11-03, G9), so no BDE moderates its
 *   content either: the institution's OWN `MODERATE` members do, the platform admin keeping recourse
 *   (owner, 2026-11-15, decision 4; `institutionModeratesOwnSql`). Another BDE whose spaces the
 *   association reaches moderates nothing of it. The same predicate leaves a BDE's own content to
 *   its own members, as its management is;
 * - a PERSON's content (a personal post or live): its author belongs to one of the spaces the BDE
 *   governs - the same per-space standing (`bdeStandingInSpaceSql`) every BDE power reads
 *   (`isReaderSpaceSql`, the readers' own definition). Someone with no space - staff, a review
 *   account - is left to the platform admin, as an association with no audience rule is;
 * - a PERSON themselves (a mute, a broadcast withdrawal, a report on an account): the same "belongs to
 *   one of the BDE's spaces". A space an INSTITUTION governs (WP-D1) has no BDE: its people are the
 *   platform admin's (owner, 2026-11-15, decision 3).
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
 * 403 `code`: the target is published in an INSTITUTION's or a BDE's name, or in the name of an
 * entity with no governing parent (or is a comment under a post in such a name), which no other BDE
 * moderates - the platform admin's (owner, 2026-11-03; WP-D2), and the publisher's own moderators'
 * for a BDE or an institution (decision 4 of 2026-11-15): they pass the act, so never meet this.
 * Classified at the throw (`AssociationsService.refuseModeration`, `MODERATION_RESERVED_SQL`), so the
 * client words "only its own moderators and the platform administration moderate this" rather than
 * "outside your spaces".
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
 *
 * The space's governor must be of type `association` (owner, 2026-11-15, decision 3): an
 * INSTITUTION governing a space with no BDE (WP-D1) answers for that space's agenda, never for its
 * students - they stay with the platform admin, the place having no local regulator of people.
 */
export function bdeModeratesUserSql(moderator: string, target: string): string {
  return `EXISTS (SELECT 1 FROM association_members mod_member
    JOIN spaces mod_space ON ${bdeStandingInSpaceSql('mod_member', 'mod_space', moderator, MODERATE)}
    JOIN users mod_target ON mod_target.id = ${target}
    WHERE ${isReaderSpaceSql('mod_space', 'mod_target')}
      AND ${governorIsAnAssociationSql('mod_space."bdeAssociationId"')})`;
}

/**
 * THE INSTITUTION HALF OF THE PUBLISHER PREDICATE (owner, 2026-11-15, decision 4): user `moderator`
 * holds `MODERATE` IN institution `association` (a SQL expression) - so moderates what that
 * institution publishes: its posts, its lives, the comments under them and the comments in its name.
 * FALSE for anything that is not an institution, whatever flag is held there. No BDE ever reaches
 * an institution's content (`governingBdeJoinSql`), and no institution reaches a person.
 */
export function institutionModeratesOwnSql(moderator: string, association: string): string {
  return `EXISTS (SELECT 1 FROM associations im_inst
    JOIN association_members im_m ON im_m."associationId" = im_inst.id
    WHERE im_inst.id = ${association} AND im_inst.type = 'institution'
      AND im_m."userId" = ${moderator} AND (im_m.permissions & ${MODERATE}) <> 0)`;
}

/**
 * THE DOOR (`AssociationsService.isContentModerator`): user `$1` moderates SOMEWHERE - `MODERATE` in
 * a BDE (an association of type `association` governing a space) or in an INSTITUTION, governing a
 * space or not (owner, 2026-11-15, decisions 3 and 4). It opens the moderation surfaces and
 * classifies a refusal; every act then asks its scoped predicate. MODERATE held in a club, a list,
 * or an institution's space standing grants nothing more. Answers `moderates`.
 */
export const MODERATES_SOMEWHERE_SQL = `SELECT EXISTS (SELECT 1 FROM association_members door_m
  JOIN associations door_a ON door_a.id = door_m."associationId"
  WHERE door_m."userId" = $1 AND (door_m.permissions & ${MODERATE}) <> 0
    AND ((door_a.type = 'association' AND ${isBdeAssociationSql('door_a')})
      OR door_a.type = 'institution')) AS "moderates"`;

/**
 * THE PUBLISHER HALF OF THE ONE PREDICATE: user `moderator` holds `MODERATE` over what is published in
 * the name of association `association` (a non-NULL SQL expression) - the moderator's BDE is the
 * association's PARENT (`holdsBdeFlagOverSql`, the governance predicate, WP-D2). So it is FALSE,
 * whatever the audience reaches, for an INSTITUTION and for ANOTHER BDE (owner, 2026-11-02 and
 * 2026-11-03, G9: only the platform admin moderates those), for an association with no parent, and
 * for one depending on another BDE. A BDE's own content stays its own moderators'.
 */
export function bdeModeratesPublisherSql(moderator: string, association: string): string {
  return holdsBdeFlagOverSql(moderator, association, MODERATE);
}

/**
 * THE PUBLISHER PREDICATE, both halves: user `moderator` moderates what is published in the name of
 * `association` - as the BDE governing it (`bdeModeratesPublisherSql`), or as a `MODERATE` member of
 * the institution it is (`institutionModeratesOwnSql`, decision 4).
 */
export function moderatesPublisherSql(moderator: string, association: string): string {
  return `(${bdeModeratesPublisherSql(moderator, association)}
    OR ${institutionModeratesOwnSql(moderator, association)})`;
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
  return `((${association} IS NOT NULL AND ${moderatesPublisherSql(moderator, association)})
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
 *
 * A comment in an INSTITUTION's name is that institution's content WHEREVER it sits (decision 4):
 * its `MODERATE` members moderate it under any post - the second, equally uncorrelated, set. A club's
 * comment under an institution's post stays the club's content, as it is under a BDE's post.
 */
export function bdeModeratesCommentSql(moderator: string, post: string, comment: string): string {
  return `((${bdeModeratesContentSql(moderator, `${post}."associationId"`, `${post}."authorId"`)}
    AND (${commentPublisherSql(comment)} IS NULL
      OR ${commentPublisherSql(comment)} IN (SELECT mcp.id FROM associations mcp
        WHERE ${moderatesPublisherSql(moderator, 'mcp.id')})))
    OR ${commentPublisherSql(comment)} IN (SELECT mci.id FROM associations mci
      WHERE ${institutionModeratesOwnSql(moderator, 'mci.id')}))`;
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
 * The ids, among associations `$2`, whose published content user `$1` moderates
 * (`moderatesPublisherSql`: as their BDE, or as an institution's own moderator). Answers `id`. What
 * `commentRights` reads per comment under a post the reader moderates.
 */
export const BDE_MODERATED_ASSOCIATION_IDS_SQL = `SELECT ma.id::text AS id FROM associations ma
  WHERE ma.id = ANY($2::uuid[]) AND ${moderatesPublisherSql('$1', 'ma.id')}`;

/**
 * The ids, among associations `$2`, that are institutions in which user `$1` holds `MODERATE`
 * (`institutionModeratesOwnSql`). Answers `id`. What `commentRights` reads for a comment in an
 * institution's name, moderated wherever it sits (decision 4).
 */
export const MODERATED_INSTITUTION_IDS_SQL = `SELECT mi.id::text AS id FROM associations mi
  WHERE mi.id = ANY($2::uuid[]) AND ${institutionModeratesOwnSql('$1', 'mi.id')}`;

/**
 * Association `association` (a SQL expression, may be NULL) is an INSTITUTION, the BDE of a space, or
 * an entity no BDE governs as a parent (none set, or one governing no space - WP-D2): a publisher
 * whose content no other BDE moderates (owner, 2026-11-03; B2). It only CLASSIFIES a refusal
 * (`MODERATION_RESERVED_SQL`); it grants and refuses nothing.
 */
function reservedPublisherSql(association: string): string {
  return `EXISTS (SELECT 1 FROM associations rsv WHERE rsv.id = ${association}
    AND (rsv.type = 'institution'
      OR EXISTS (SELECT 1 FROM spaces rsv_space WHERE rsv_space."bdeAssociationId" = rsv.id)
      OR NOT EXISTS (SELECT 1 FROM associations rsv_parent
        WHERE rsv_parent.id = rsv."parentAssociationId" AND rsv_parent.type = 'association'
          AND EXISTS (SELECT 1 FROM spaces rsv_pspace
            WHERE rsv_pspace."bdeAssociationId" = rsv_parent.id))))`;
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
 * THE BDE MODERATOR'S MODERATION READ of post row `post` by user `moderator`: the post is in its
 * scope (`bdeModeratesContentSql`, as every BDE act), AND it is published - or an OPEN report
 * targets it. Owner, 2026-11-15: *"Exclure les posts programmes"* - an unpublished scheduled post is
 * not a BDE moderator's to read until it is published, unless it was reported. The post's scheduled
 * state and the open report are both read in the statement that decides, so no read learns them by
 * failing. Every read that shows a BDE moderator a post's content asks THIS - one post by id, its
 * comments and its replay (`BDE_MODERATION_READ_OPENS_POST_SQL`), the hidden-posts list
 * (`PostsService.getHiddenPosts`), the preview in the queue of a reported post and of a comment
 * reported under it (`ModerationService.listAllReports`). The writes (hide, delete) keep `BDE_MODERATED_POST_IDS_SQL`,
 * unnarrowed. The platform admin is not asked it: their read is unchanged.
 */
export function bdeModerationReadsPostSql(moderator: string, post: string): string {
  return `(${bdeModeratesContentSql(moderator, `${post}."associationId"`, `${post}."authorId"`)}
    AND (${post}."scheduledAt" IS NULL OR ${post}."scheduledAt" <= now()
      OR EXISTS (SELECT 1 FROM content_reports read_report
        WHERE read_report."contentType" = 'post' AND read_report."contentId" = ${post}.id::text
          AND read_report.status = 'pending')))`;
}

/** {@link bdeModerationReadsPostSql} asked of post `$2` (uuid) by user `$1`. Answers `reads`. */
export const BDE_MODERATION_READ_OPENS_POST_SQL = `SELECT EXISTS (SELECT 1 FROM posts rp
  WHERE rp.id = $2::uuid AND ${bdeModerationReadsPostSql('$1', 'rp')}) AS "reads"`;

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
