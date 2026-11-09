import { Logger } from '@nestjs/common';
import { associationVisibleToUserSql } from '../spaces/reader-spaces';

/**
 * THE OPENING REMINDERS (engagement WP-4, decision 5d, L9; docs/wiki/engagement.md, "(d) openings
 * for followers - one notice, never two"): who is told that a form, a booking space or an event
 * opens, written as ONE table, `opening_reminders` (migration 151).
 *
 * Two causes write a row, and the unique key `(kind, targetId, userId)` makes them one:
 * - **asked**: the person pressed "Me prévenir" (`askOpening`) - the heads-up five minutes before,
 *   then the opening;
 * - **followed**: the person follows the target's association, written when the target is
 *   PUBLISHED or its opening MOVED (`announceOpeningToFollowers`) - the opening only, so the row is
 *   written with its heads-up already stamped.
 * An ask on a follower's row turns it into an ask and re-arms the heads-up; a follower's row never
 * overwrites an ask (`ON CONFLICT DO NOTHING`). So a follower who also asked has ONE row, ONE claim
 * and ONE push.
 *
 * Plain statements over a manager, not a service: the form, booking and agenda writes call them
 * inside their own transactions, and none of their modules has to import another.
 */

/** What opens. */
export type OpeningKind = 'form' | 'booking' | 'event';

/** Why a person is told: they asked ("Me prévenir"), or they follow the target's association. */
export type OpeningOrigin = 'asked' | 'followed';

/** How long before the opening the asked heads-up goes out. */
export const OPENING_HEADS_UP_MINUTES = 5;

/** Anything that runs a statement - an `EntityManager`, a repository, a transaction's manager. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const logger = new Logger('OpeningReminders');

const short = (id: string) => id.slice(0, 8);

/**
 * The rows a `RETURNING` statement answered. TypeORM answers an `UPDATE` or a `DELETE` as
 * `[rows, affectedCount]` and an `INSERT` or a `SELECT` as the rows alone - read by the shape, so
 * neither is counted as the other.
 */
async function returned(db: Queryable, sql: string, params: unknown[]): Promise<unknown[]> {
  const result = await db.query(sql, params);
  if (!Array.isArray(result)) return [];
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as unknown[];
  }
  return result;
}

/**
 * THE ASK ("Me prévenir"): the person's row becomes `asked`, at the target's opening, and its
 * heads-up is re-armed while the opening is still to come - exactly what a fresh ask gets, so an
 * ask on a follower's row inside the last five minutes is told at the next tick like any other
 * (found by the integration spec: a first draft re-armed it only beyond five minutes, so the same
 * ask got a heads-up or none depending on whether the reader followed). The opening's own stamp is
 * never re-armed: an opening
 * already told is told once. Spelt the same way by migration 152's mirror trigger, which turns an
 * older image's subscribe into this statement during a rolling deploy.
 */
export const ASK_OPENING_SQL = `INSERT INTO opening_reminders AS o
    (kind, "targetId", "userId", "opensAt", origin)
  VALUES ($1, $2::uuid, $3, $4::timestamptz, 'asked')
  ON CONFLICT (kind, "targetId", "userId") DO UPDATE
    SET origin = 'asked',
        "opensAt" = EXCLUDED."opensAt",
        "notified5min" = CASE WHEN EXCLUDED."opensAt" > now() THEN false ELSE o."notified5min" END
  RETURNING id`;

/** Records the ask of `userId` for one target opening at `opensAt`. Idempotent. */
export async function askOpening(
  db: Queryable,
  kind: OpeningKind,
  targetId: string,
  userId: string,
  opensAt: Date
): Promise<void> {
  await returned(db, ASK_OPENING_SQL, [kind, targetId, userId, opensAt]);
  logger.log(`[OPENING] ask: ${kind}=${short(targetId)} user=${short(userId)}`);
}

/**
 * Removes the person's row, whatever wrote it: "Ne plus me prévenir" is an answer about THIS target,
 * and a follower who says it is not told of this opening either (lead decision, engagement.md L24).
 * A later move of the opening writes the followers again, them included.
 */
export async function cancelOpening(
  db: Queryable,
  kind: OpeningKind,
  targetId: string,
  userId: string
): Promise<void> {
  const rows = await returned(
    db,
    `DELETE FROM opening_reminders WHERE kind = $1 AND "targetId" = $2::uuid AND "userId" = $3
     RETURNING origin`,
    [kind, targetId, userId]
  );
  logger.log(
    `[OPENING] cancel: ${kind}=${short(targetId)} user=${short(userId)} removed=${rows.length}`
  );
}

/** Whether the person will be told of this target's opening - asked, or as a follower. */
export async function isTold(
  db: Queryable,
  kind: OpeningKind,
  targetId: string,
  userId: string
): Promise<boolean> {
  const rows = await returned(
    db,
    `SELECT 1 FROM opening_reminders WHERE kind = $1 AND "targetId" = $2::uuid AND "userId" = $3`,
    [kind, targetId, userId]
  );
  return rows.length > 0;
}

/**
 * THE FOLLOWERS OF `$3` WHO SEE IT, as rows of target `$2` of kind `$1`, opening at `$4` (`now()`
 * when NULL: open at once, claimed at the next tick). The actor `$5` is left out: the member who
 * publishes is not told of their own opening.
 *
 * "Who sees it" is the association's own visibility (`associationVisibleToUserSql`, the PLAIN
 * predicate an entity post's announcement uses: a member anywhere, or anyone its rules reach - read
 * grants never notify); an ARCHIVED association announces nothing. The target's own audience
 * condition (a form's `submitCondition`, a booking space's `audience`) is NOT asked: it is a profile
 * predicate evaluated in code against core-service facts, one call per person, and the target's
 * page tells a follower it does not admit (lead decision, engagement.md L25).
 *
 * `ON CONFLICT DO NOTHING`: a row already there - an ask, or a follower already written - keeps its
 * origin and its stamps, so nobody is told twice.
 */
export const ANNOUNCE_OPENING_TO_FOLLOWERS_SQL = `INSERT INTO opening_reminders
    (kind, "targetId", "userId", "opensAt", origin, "notified5min")
  SELECT $1, $2::uuid, op_user.id, COALESCE($4::timestamptz, now()), 'followed', true
    FROM association_follows op_follow
    JOIN associations op_asso ON op_asso.id = op_follow."associationId" AND NOT op_asso.archived
    JOIN users op_user ON op_user.id = op_follow."followerUserId"
   WHERE op_follow."associationId" = $3::uuid AND op_user.id <> $5
     AND ${associationVisibleToUserSql('op_asso.id', 'op_user')}
  ON CONFLICT (kind, "targetId", "userId") DO NOTHING
  RETURNING "userId"`;

/** What `announceOpeningToFollowers` is told about the target. */
export interface OpeningAnnouncement {
  kind: OpeningKind;
  targetId: string;
  /** The association whose followers are told; a personal target (null) tells nobody. */
  associationId: string | null;
  /** When it opens; null = open at once. */
  opensAt: Date | null;
  /** Who published or moved it - never told of it. */
  actorId: string;
}

/**
 * Writes the followers' rows of one published (or moved) target. Never capped (decision 11: a
 * shotgun opening is outside the daily cap). Returns how many rows it wrote.
 */
export async function announceOpeningToFollowers(
  db: Queryable,
  a: OpeningAnnouncement
): Promise<number> {
  if (!a.associationId) {
    logger.debug(`[OPENING] ${a.kind}=${short(a.targetId)} is personal: no follower to tell`);
    return 0;
  }
  const rows = await returned(db, ANNOUNCE_OPENING_TO_FOLLOWERS_SQL, [
    a.kind,
    a.targetId,
    a.associationId,
    a.opensAt,
    a.actorId,
  ]);
  logger.log(
    `[OPENING] followers of ${short(a.associationId)} written for ${a.kind}=${short(a.targetId)}: ` +
      `${rows.length} (opens ${a.opensAt ? a.opensAt.toISOString() : 'now'})`
  );
  return rows.length;
}

/**
 * The target's opening MOVED (or was cleared: open at once): every row not yet told of the opening
 * follows it, and an asked row's heads-up is re-armed while the new opening is still to come. A row already told of the opening is left alone - one opening, one push.
 */
export async function followOpeningMove(
  db: Queryable,
  kind: OpeningKind,
  targetId: string,
  opensAt: Date | null
): Promise<number> {
  const rows = await returned(
    db,
    `UPDATE opening_reminders
        SET "opensAt" = COALESCE($3::timestamptz, now()),
            "notified5min" = CASE
              WHEN origin = 'asked' AND COALESCE($3::timestamptz, now()) > now()
              THEN false ELSE "notified5min" END
      WHERE kind = $1 AND "targetId" = $2::uuid AND NOT "notifiedOnOpen"
      RETURNING id`,
    [kind, targetId, opensAt]
  );
  logger.log(
    `[OPENING] ${kind}=${short(targetId)} moved to ${opensAt ? opensAt.toISOString() : 'now'}: ${rows.length} row(s) follow`
  );
  return rows.length;
}

/**
 * The rows owed the HEADS-UP at `$1`: asked forms opening within the next five minutes. Only an ask
 * leaves `notified5min` unset, and only a form can be asked today (`POST /api/forms/:id/remind`).
 */
export const DUE_HEADS_UP_SQL = `SELECT o.id, o.kind, o."targetId", o."userId"
    FROM opening_reminders o
   WHERE o.kind = 'form' AND NOT o."notified5min" AND NOT o."notifiedOnOpen"
     AND o."opensAt" >= $1::timestamptz
     AND o."opensAt" <= $1::timestamptz + make_interval(mins => ${OPENING_HEADS_UP_MINUTES})`;

/** One row owed its opening, with what the push needs to know about its target. */
export interface DueOpening {
  id: string;
  kind: OpeningKind;
  targetId: string;
  userId: string;
  origin: OpeningOrigin;
  /** The target still exists and is open to readers (a published, unarchived form; a validated event). */
  targetLive: boolean;
  /** The target's association, if any; its name and logo for the row. */
  associationId: string | null;
  associationName: string | null;
  associationLogoUrl: string | null;
  /** The form's or event's title, the booking space's name. */
  targetName: string | null;
  /** A booking space reached by its link only: its name never reaches a lock screen (Q-R5). */
  linkOnly: boolean;
  /**
   * A follower's row whose bell on the association is reduced (`lives` or `none`): an opening is
   * neither a post nor a live of its own, so ANY stored reduction withholds the push - the in-app
   * row is still written, as for a post (L26). An ask is never withheld: the person asked.
   */
  bellWithholds: boolean;
}

/**
 * The rows owed the OPENING at `$1`, with their target read in the same statement: a row naming a
 * target that is gone or no longer readable is claimed and not pushed.
 */
export const DUE_OPENINGS_SQL = `SELECT o.id, o.kind, o."targetId", o."userId", o.origin,
         COALESCE(t.live, false) AS "targetLive", t."associationId", t."linkOnly",
         t.name AS "targetName", a.name AS "associationName", a."logoUrl" AS "associationLogoUrl",
         (o.origin = 'followed' AND t."associationId" IS NOT NULL AND EXISTS (
            SELECT 1 FROM account_bells b
             WHERE b."userId" = o."userId" AND b."targetKind" = 'association'
               AND b."targetId" = t."associationId"::text)) AS "bellWithholds"
    FROM opening_reminders o
    LEFT JOIN LATERAL (
      SELECT f."associationId", f.title AS name, false AS "linkOnly",
             (f."deletedAt" IS NULL AND f.status = 'published') AS live
        FROM forms f WHERE o.kind = 'form' AND f.id = o."targetId"
      UNION ALL
      SELECT s."associationId", s.name, s.discoverability = 'link', true
        FROM booking_spaces s WHERE o.kind = 'booking' AND s.id = o."targetId"
      UNION ALL
      SELECT e."associationId", e.title, false, e.status = 'validated'
        FROM association_calendar_events e WHERE o.kind = 'event' AND e.id = o."targetId"
    ) t ON true
    LEFT JOIN associations a ON a.id = t."associationId"
   WHERE NOT o."notifiedOnOpen" AND o."opensAt" <= $1::timestamptz
   ORDER BY o."opensAt"`;

/** The 30-day purge of the rows told of their opening (the scheduler's daily GC). */
export const PURGE_TOLD_OPENINGS_SQL = `DELETE FROM opening_reminders
  WHERE "notifiedOnOpen" AND "opensAt" < now() - make_interval(days => $1)`;
