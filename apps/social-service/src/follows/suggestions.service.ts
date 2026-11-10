import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  associationVisibleToUserSql,
  isMemberSql,
  sameSideOfReviewCohortSql,
} from '../spaces/reader-spaces';
import { acceptedFollowSql } from './follow-status';
import { short } from './follows.service';

/**
 * FOLLOW SUGGESTIONS (engagement WP-5, decisions 2 and 4): who a reader might follow, from four
 * sources - friends of friends, co-members of their associations and lists, their promo then
 * formation then campus, and the most-followed entities their audience rules reach. Computed on
 * request, never stored: a cache would be a second truth to invalidate on every follow, block and
 * dismissal (docs/wiki/engagement.md, "Follow suggestions - the query").
 */

/** How many people one read suggests, and how many entities. */
export const SUGGESTED_PEOPLE_MAX = 20;
export const SUGGESTED_ENTITIES_MAX = 10;
/** How many faces a person's card carries (decision 4: "followed by"). */
export const SUGGESTION_FACES_MAX = 3;

/**
 * L10's weights, one constant each: `4 * min(mutual, 10) + 3 * min(sharedAssociations, 3) + tier`
 * (tier 3 same promo and formation, 2 same formation, 1 same campus), ties broken by id.
 */
export const SUGGESTION_WEIGHTS = {
  mutual: 4,
  mutualCap: 10,
  shared: 3,
  sharedCap: 3,
} as const;

/** What a dismissal names: a person, or an entity (an association, a list, an institution). */
export type SuggestionTargetKind = 'user' | 'association';

/** The typed 400 of the dismiss route, read by the client from the body, never the message. */
export const SUGGESTION_DISMISS_INVALID = 'SUGGESTION_DISMISS_INVALID';

/** One suggested person: the count of "N en commun" and up to three faces, both of `followed`. */
export interface SuggestedPerson {
  userId: string;
  mutual: number;
  faces: string[];
}

/** One suggested entity, with what its card draws. No follower count (L11: no reason line). */
export interface SuggestedEntity {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  type: string;
}

export interface Suggestions {
  people: SuggestedPerson[];
  entities: SuggestedEntity[];
  /**
   * How many accounts the viewer follows: accepted person follows plus entity follows (L12). The
   * client shows the onboarding banner below its threshold (decision 7, WP-6).
   */
  followingCount: number;
}

/** An association id as the database stores it: anything else names no entity. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Either side of a block between the accounts `a` and `b` (id expressions). */
const blockBetweenSql = (a: string, b: string): string => `EXISTS (SELECT 1 FROM user_blocks sg_b
  WHERE (sg_b."blockerId" = ${a} AND sg_b."blockedId" = ${b})
     OR (sg_b."blockerId" = ${b} AND sg_b."blockedId" = ${a}))`;

/**
 * THE ACCOUNTS THE VIEWER (`$1`) FOLLOWS that may be named to them: accepted, no block either way,
 * the same side of the review cohort. A function, like every SQL here, because the cohort is read
 * from the environment when the SQL is built. The ONE pool both the "N en commun" count and the faces are
 * drawn from, so the card's number and its faces can never disagree - and a face is an account the
 * viewer follows AND who accepted the viewer, which is decision 4's "followed by".
 */
const followedCteSql = (): string => `followed AS (
  SELECT f."followedUserId" AS id FROM user_follows f
   WHERE f."followerUserId" = $1 AND ${acceptedFollowSql('f')}
     AND NOT ${blockBetweenSql('$1', 'f."followedUserId"')}
     AND ${sameSideOfReviewCohortSql('$1::varchar', 'f."followedUserId"')})`;

/**
 * THE PERSON SUGGESTIONS of `$1`, ranked by L10, at most `$2`, with each one's faces. One statement:
 *
 * - `fof`: friends of friends - accounts `followed` follow (accepted), counted per candidate. That
 *   count IS "shared links" (decision 2) and the card's "N en commun" (decision 4).
 * - `comembers`: people sharing an association or list with the viewer, counted per candidate.
 * - `cohort`: the viewer's campus, tier 3 same promo AND a shared formation, 2 a shared formation, 1
 *   the campus. The promo is `users.promo` (never `cursus->0->>'promo'`, NULL in production); a
 *   formation is shared when a formation of the viewer's cursus is in the candidate's - the
 *   containment `isReaderSpaceSql` uses. The viewer's formations are read ONCE (`my_formations`), and
 *   a cursus that is not an array contributes none rather than failing the statement.
 * - The exclusions of decision 2: the viewer, any follow row viewer -> candidate (accepted or
 *   pending), a block either way, a dismissal, the other side of the review cohort, and an account
 *   that no longer exists (`users`: the erasure deletes the row).
 */
export const personSuggestionsSql =
  (): string => `WITH me AS (SELECT id, campus, promo, cursus FROM users WHERE id = $1),
${followedCteSql()},
my_formations AS (
  SELECT DISTINCT e->>'formation' AS formation
    FROM me, jsonb_array_elements(CASE WHEN jsonb_typeof(me.cursus) = 'array' THEN me.cursus ELSE '[]'::jsonb END) e
   WHERE e->>'formation' IS NOT NULL),
fof AS (
  SELECT f2."followedUserId" AS id, count(*)::int AS mutual
    FROM followed f1 JOIN user_follows f2 ON f2."followerUserId" = f1.id AND ${acceptedFollowSql('f2')}
   GROUP BY 1),
comembers AS (
  SELECT m2."userId" AS id, count(DISTINCT m2."associationId")::int AS shared
    FROM association_members m1 JOIN association_members m2 ON m2."associationId" = m1."associationId"
   WHERE m1."userId" = $1
   GROUP BY 1),
cohort AS (
  SELECT u.id,
         CASE WHEN sf.shared AND u.promo = me.promo THEN 3 WHEN sf.shared THEN 2 ELSE 1 END AS tier
    FROM users u JOIN me ON u.campus = me.campus
    CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM my_formations mf
      WHERE u.cursus @> jsonb_build_array(jsonb_build_object('formation', mf.formation))) AS shared) sf),
candidates AS (SELECT id FROM fof UNION SELECT id FROM comembers UNION SELECT id FROM cohort),
ranked AS (
  SELECT c.id, COALESCE(fof.mutual, 0) AS mutual,
         ${SUGGESTION_WEIGHTS.mutual} * LEAST(COALESCE(fof.mutual, 0), ${SUGGESTION_WEIGHTS.mutualCap})
           + ${SUGGESTION_WEIGHTS.shared} * LEAST(COALESCE(cm.shared, 0), ${SUGGESTION_WEIGHTS.sharedCap})
           + COALESCE(co.tier, 0) AS score
    FROM candidates c
    JOIN users cu ON cu.id = c.id
    LEFT JOIN fof ON fof.id = c.id
    LEFT JOIN comembers cm ON cm.id = c.id
    LEFT JOIN cohort co ON co.id = c.id
   WHERE c.id <> $1
     AND NOT EXISTS (SELECT 1 FROM user_follows sg_f
                      WHERE sg_f."followerUserId" = $1 AND sg_f."followedUserId" = c.id)
     AND NOT ${blockBetweenSql('$1', 'c.id')}
     AND NOT EXISTS (SELECT 1 FROM follow_suggestion_dismissals sg_d
                      WHERE sg_d."userId" = $1 AND sg_d."targetKind" = 'user' AND sg_d."targetId" = c.id)
     AND ${sameSideOfReviewCohortSql('$1::varchar', 'c.id')}
   ORDER BY score DESC, c.id
   LIMIT $2)
SELECT r.id AS "userId", r.mutual,
       ARRAY(SELECT f1.id FROM followed f1
               JOIN user_follows f2 ON f2."followerUserId" = f1.id AND f2."followedUserId" = r.id
                AND ${acceptedFollowSql('f2')}
              ORDER BY f1.id LIMIT ${SUGGESTION_FACES_MAX}) AS faces
  FROM ranked r
 ORDER BY r.score DESC, r.id`;

/**
 * THE ENTITY SUGGESTIONS of `$1` (decision 2's fourth source), at most `$2`: entities not archived
 * that the viewer sees by their audience rules (`associationVisibleToUserSql`, the agenda's
 * predicate), that the viewer neither follows, belongs to, nor dismissed, ordered by how many follow
 * them. Lists and institutions included - they are free to follow, so the card's button follows at
 * once.
 */
export const entitySuggestionsSql = (): string => `SELECT a.id, a.name, a.slug, a."logoUrl", a.type
  FROM associations a JOIN users vis_viewer ON vis_viewer.id = $1
 WHERE NOT a.archived
   AND ${associationVisibleToUserSql('a.id', 'vis_viewer')}
   AND NOT ${isMemberSql('a.id', 'vis_viewer')}
   AND NOT EXISTS (SELECT 1 FROM association_follows sg_af
                    WHERE sg_af."followerUserId" = $1 AND sg_af."associationId" = a.id)
   AND NOT EXISTS (SELECT 1 FROM follow_suggestion_dismissals sg_d
                    WHERE sg_d."userId" = $1 AND sg_d."targetKind" = 'association'
                      AND sg_d."targetId" = a.id::text)
 ORDER BY (SELECT count(*) FROM association_follows sg_n WHERE sg_n."associationId" = a.id) DESC, a.id
 LIMIT $2`;

/** L12's count: the viewer's ACCEPTED person follows plus their entity follows. */
export const FOLLOWING_COUNT_SQL = `SELECT
  (SELECT count(*) FROM user_follows sg_c WHERE sg_c."followerUserId" = $1 AND ${acceptedFollowSql('sg_c')})
  + (SELECT count(*) FROM association_follows sg_a WHERE sg_a."followerUserId" = $1) AS n`;

/** The write of the X: one row, idempotent. */
export const DISMISS_SQL = `INSERT INTO follow_suggestion_dismissals ("userId", "targetKind", "targetId")
  VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`;

@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /**
   * The viewer's suggestions: people and entities, each ranked. `exclude` drops one more person -
   * the account just followed, for "Suivez aussi..." (L15: the VIEWER's own ranking minus that
   * account, never the target's follows).
   */
  async suggestionsFor(
    viewerId: string,
    opts: { peopleLimit?: number; exclude?: string } = {}
  ): Promise<Suggestions> {
    const limit = Math.min(
      Math.max(opts.peopleLimit ?? SUGGESTED_PEOPLE_MAX, 1),
      SUGGESTED_PEOPLE_MAX
    );
    // One more than asked when a person is to be dropped, so dropping them never shortens the page.
    const fetch = opts.exclude ? limit + 1 : limit;
    const started = Date.now();
    const [rows, entities, [following]] = await Promise.all([
      this.db.query<{ userId: string; mutual: number; faces: string[] }[]>(personSuggestionsSql(), [
        viewerId,
        fetch,
      ]),
      this.db.query<SuggestedEntity[]>(entitySuggestionsSql(), [viewerId, SUGGESTED_ENTITIES_MAX]),
      this.db.query<{ n: string | number }[]>(FOLLOWING_COUNT_SQL, [viewerId]),
    ]);
    const people = rows
      .filter((r) => r.userId !== opts.exclude)
      .slice(0, limit)
      .map((r) => ({ userId: r.userId, mutual: Number(r.mutual), faces: r.faces ?? [] }));
    this.logger.debug(
      `[SUGGESTIONS] ${short(viewerId)} people=${people.length} entities=${entities.length} in ${Date.now() - started} ms`
    );
    return { people, entities, followingCount: Number(following?.n ?? 0) };
  }

  /**
   * The caller dismisses one suggestion - permanently (Instagram's X). Idempotent. 400
   * {@link SUGGESTION_DISMISS_INVALID} for an unknown kind, an empty or over-long id, or an entity id
   * that is no uuid. No existence check: a dismissal of nobody suppresses nobody.
   */
  async dismiss(viewerId: string, kind: unknown, targetId: unknown): Promise<{ ok: true }> {
    const valid =
      (kind === 'user' || kind === 'association') &&
      typeof targetId === 'string' &&
      targetId.length > 0 &&
      targetId.length <= 255 &&
      (kind === 'user' ? targetId !== viewerId : UUID.test(targetId));
    if (!valid) {
      this.logger.debug(`[SUGGESTIONS] ${short(viewerId)} dismiss refused: invalid target`);
      throw new BadRequestException({ code: SUGGESTION_DISMISS_INVALID });
    }
    await this.db.query(DISMISS_SQL, [
      viewerId,
      kind,
      kind === 'association' ? targetId.toLowerCase() : targetId,
    ]);
    this.logger.debug(`[SUGGESTIONS] ${short(viewerId)} dismissed a ${kind}`);
    return { ok: true };
  }
}
