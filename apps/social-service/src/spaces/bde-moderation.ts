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
 * is shown is the place whose BDE answers for it.
 *
 * Its own module because it splices both `bde.ts` (which the `Association` entity imports, so it must
 * import nothing reaching back) and `reader-spaces.ts`.
 */

const MODERATE = String(AssociationPermissionFlag.MODERATE);

/** 403 `code`: the caller moderates somewhere, but not where this target lives. */
export const MODERATION_OUT_OF_SCOPE = 'MODERATION_OUT_OF_SCOPE';
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
 * User `moderator` holds `MODERATE` over a piece of content published in the name of `association`
 * (NULL for a personal one) by `author` - a post or a live. All three are SQL expressions.
 */
export function bdeModeratesContentSql(
  moderator: string,
  association: string,
  author: string
): string {
  return `((${association} IS NOT NULL AND ${holdsBdeFlagOverSql(moderator, association, MODERATE)})
    OR (${association} IS NULL AND ${author} IS NOT NULL AND ${bdeModeratesUserSql(moderator, author)}))`;
}

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
 * - `post`: the post is in scope; `comment`: the post it sits under is;
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
      WHERE ${postInScope}))
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
