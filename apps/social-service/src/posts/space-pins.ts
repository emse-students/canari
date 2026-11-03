import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { bdeStandingInSpaceSql } from '../spaces/bde';
import { isPinSpaceOfUserSql, postReachesSpaceSql } from '../spaces/reader-spaces';

/**
 * A PIN IS A PROMOTION PER SPACE (WP-PIN, owner decisions of 2026-11-03;
 * docs/wiki/spaces-and-audiences-reform.md section 11). The SQL every pin surface reads, stated once.
 *
 * - WHO MAY PIN in a space: the platform admin, in any space; otherwise a member holding `MODERATE`
 *   in the BDE that governs THAT space - the per-space standing every BDE power reads
 *   (`bdeStandingInSpaceSql`), never re-derived. It is not `holdsBdeFlagOverSql`, which asks
 *   "governs this ASSOCIATION" and leaves institutions and other BDEs out: pinning is a promotion,
 *   not moderation (owner, decision 1), so an institution's post is pinnable (G9 intact).
 * - WHAT MAY BE PINNED in a space: a post the readers of that space see (`postReachesSpaceSql`) that
 *   is live - published, not hidden by moderation, not a dead reel (`postPinnableInSpaceSql`).
 * - WHAT IS SHOWN: among a space's pins whose post is still pinnable there, the 3 most recent
 *   (`pinned_at` DESC, then `post_id`). ONE rank (`rankedPinsSql`) serves the feed order, the served
 *   `pinned` field, the card's per-space states, the cap and the governor's list, so none can
 *   disagree. A pin whose post stopped being visible is kept, not shown and not counted - computed
 *   here at read time, so no visibility change needs a hook. A pin beyond the 3 shown ("en attente")
 *   is kept too, and returns the moment a shown one is unpinned.
 */

/** At most this many pins are SHOWN per space; a new pin at this count is refused (owner, decision 4). */
export const SPACE_PIN_LIMIT = 3;

/** 409 `code`: the space already shows {@link SPACE_PIN_LIMIT} pins - unpin one first. */
export const SPACE_PIN_LIMIT_CODE = 'space_pin_limit';
/** 409 `code`: a request with no `spaceId` matched zero or several spaces - the client must name one. */
export const SPACE_REQUIRED = 'space_required';
/** 403 `code`: the caller neither administers the platform nor holds `MODERATE` in this space's BDE. */
export const SPACE_PIN_FORBIDDEN = 'space_pin_forbidden';
/** 409 `code`: the post is not visible to this space's readers, so it cannot be promoted there. */
export const POST_NOT_IN_SPACE = 'post_not_in_space';
/** 404 `code`: no space has this id. */
export const SPACE_NOT_FOUND = 'space_not_found';

const MODERATE = String(AssociationPermissionFlag.MODERATE);

/**
 * Post row `post` may be promoted in space row `space`: its readers see it, and it is live. The
 * lifecycle terms are the feed's own (`PostsService`: scheduled, `hiddenByModeration`, a reel's
 * `expiresAt`), so a pin is never shown for a post the feed would not show anyone.
 */
export function postPinnableInSpaceSql(post: string, space: string): string {
  return `(${postReachesSpaceSql(post, space)}
    AND (${post}."scheduledAt" IS NULL OR ${post}."scheduledAt" <= NOW())
    AND NOT COALESCE(${post}."hiddenByModeration", false)
    AND (${post}.kind <> 'reel' OR ${post}."expiresAt" > NOW()))`;
}

/**
 * User `user` (a SQL expression) holds the pin right in space row `space` AS A BDE: `MODERATE` in the
 * BDE governing that space. The platform admin is decided by the caller, before splicing this.
 */
export function bdePinsInSpaceSql(user: string, space: string): string {
  return `EXISTS (SELECT 1 FROM association_members pin_member
    WHERE ${bdeStandingInSpaceSql('pin_member', space, user, MODERATE)})`;
}

/**
 * THE ONE RANK: every pin whose post is still pinnable in its space, numbered per space by
 * `pinned_at` DESC then `post_id`. Columns: `post_id`, `space_id`, `pinned_by`, `pinned_at`,
 * `pin_rank`; a rank up to {@link SPACE_PIN_LIMIT} is SHOWN, above it is "en attente". A subquery,
 * uncorrelated, so PostgreSQL computes it once per statement - the table holds at most a few pins per
 * space.
 */
export function rankedPinsSql(): string {
  return `SELECT rk_pin.post_id, rk_pin.space_id, rk_pin.pinned_by, rk_pin.pinned_at,
      ROW_NUMBER() OVER (PARTITION BY rk_pin.space_id ORDER BY rk_pin.pinned_at DESC, rk_pin.post_id) AS pin_rank
    FROM post_space_pins rk_pin
    JOIN posts rk_post ON rk_post.id = rk_pin.post_id
    JOIN spaces rk_space ON rk_space.id = rk_pin.space_id
    WHERE ${postPinnableInSpaceSql('rk_post', 'rk_space')}`;
}

/**
 * Post row `post` is SHOWN pinned in one of the PIN spaces (`isPinSpaceOfUserSql`: their own, plus
 * their read grants' cells) of the viewer whose id is the expression `viewer` - the feed's first sort
 * key and the served `pinned` field. A NULL viewer has no space, so nothing is pinned for them.
 */
export function pinnedForViewerSql(post: string, viewer: string): string {
  return `(${post}.id IN (SELECT pv_rank.post_id FROM (${rankedPinsSql()}) pv_rank
      JOIN spaces pv_space ON pv_space.id = pv_rank.space_id
      JOIN users pv_viewer ON pv_viewer.id = ${viewer}
      WHERE pv_rank.pin_rank <= ${SPACE_PIN_LIMIT} AND ${isPinSpaceOfUserSql('pv_space', 'pv_viewer')}))`;
}

/** Of posts `$1`, those pinned for viewer `$2` (`pinnedForViewerSql`). Answers `id`. */
export const PINNED_FOR_VIEWER_IDS_SQL = `SELECT pf_post.id::text AS id FROM posts pf_post
  WHERE pf_post.id = ANY($1::uuid[]) AND ${pinnedForViewerSql('pf_post', '$2')}`;

/**
 * For each of posts `$1`, every space where viewer `$2` may pin it - the post is pinnable there, and
 * `$3` (platform admin) or the BDE standing holds - with its rank there (NULL when not pinned).
 * Answers `postId`, `spaceId`, `formation`, `campus`, `rank`. What `canPin`, the card's space list and
 * a body-less pin or unpin read, so the control offered is the write accepted.
 *
 * The governed spaces are read FIRST and once (a materialized CTE): every page of every reader asks
 * this, and for the reader who governs nothing - nearly all of them - that set is empty and no post's
 * reach is ever evaluated.
 */
export const PIN_SPACES_FOR_VIEWER_SQL = `WITH ps_governed AS MATERIALIZED (
    SELECT gs.* FROM spaces gs WHERE $3::boolean OR ${bdePinsInSpaceSql('$2', 'gs')})
  SELECT ps_post.id::text AS "postId", ps_space.id::text AS "spaceId",
    ps_space.formation, ps_space.campus, ps_rank.pin_rank::int AS rank
  FROM ps_governed ps_space
  JOIN posts ps_post ON ps_post.id = ANY($1::uuid[]) AND ${postPinnableInSpaceSql('ps_post', 'ps_space')}
  LEFT JOIN (${rankedPinsSql()}) ps_rank ON ps_rank.post_id = ps_post.id AND ps_rank.space_id = ps_space.id
  ORDER BY ps_post.id, ps_space.campus, ps_space.formation`;

/** May user `$1` (`$2`: platform admin) pin in space `$3`? Answers `found` (the space exists) and `may`. */
export const MAY_PIN_IN_SPACE_SQL = `SELECT true AS found, ($2::boolean OR ${bdePinsInSpaceSql('$1', 'mp_space')}) AS may
  FROM spaces mp_space WHERE mp_space.id = $3::uuid`;

/** Is post `$1` pinnable in space `$2`? Answers `pinnable`. */
export const POST_PINNABLE_IN_SPACE_SQL = `SELECT EXISTS (SELECT 1 FROM posts pp_post
  JOIN spaces pp_space ON pp_space.id = $2::uuid
  WHERE pp_post.id = $1::uuid AND ${postPinnableInSpaceSql('pp_post', 'pp_space')}) AS pinnable`;

/** The rank of post `$1` in space `$2`, and how many pins that space SHOWS. Answers `rank`, `shown`. */
export const PIN_STANDING_IN_SPACE_SQL = `SELECT
    (SELECT st_rank.pin_rank::int FROM (${rankedPinsSql()}) st_rank
      WHERE st_rank.space_id = $2::uuid AND st_rank.post_id = $1::uuid) AS rank,
    (SELECT count(*)::int FROM (${rankedPinsSql()}) st_shown
      WHERE st_shown.space_id = $2::uuid AND st_shown.pin_rank <= ${SPACE_PIN_LIMIT}) AS shown`;

/**
 * The governor's list of space `$1`: every pin whose post is pinnable there, newest first, with its
 * rank. Answers `postId`, `pinnedAt`, `rank`. A pin whose post is no longer visible in the space is
 * not listed - it is not shown and not counted, and returns with the post.
 */
export const SPACE_PIN_LIST_SQL = `SELECT sl_rank.post_id::text AS "postId", sl_rank.pinned_at AS "pinnedAt",
    sl_rank.pin_rank::int AS rank
  FROM (${rankedPinsSql()}) sl_rank
  WHERE sl_rank.space_id = $1::uuid
  ORDER BY sl_rank.pin_rank`;

/** The per-space state of one pin, as the client renders it: shown, "en attente", or not pinned. */
export type PinState = 'shown' | 'pending' | null;

/** A rank from {@link rankedPinsSql} as a {@link PinState}. */
export function pinStateOf(rank: number | null | undefined): PinState {
  if (rank === null || rank === undefined) return null;
  return rank <= SPACE_PIN_LIMIT ? 'shown' : 'pending';
}

/** One space where the viewer may pin a post, as served on the card (`pinSpaces`). */
export interface PinSpace {
  spaceId: string;
  formation: string;
  campus: string;
  state: PinState;
}
