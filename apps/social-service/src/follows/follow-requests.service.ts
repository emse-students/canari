import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { FOLLOW_REQUESTS_TARGET, NOTIFICATIONS_TARGET } from '../push/push-target';
import { FOLLOW_ACCEPTED, FOLLOW_PENDING, type FollowStatus } from './follow-status';
import type { FollowNoticeKind } from './entities/user-follow-notice.entity';
import { FollowsService } from './follows.service';

/** How a follows log line names an account: its first 8 characters, never a whole account id. */
const short = (id: string): string => id.slice(0, 8);

/** The bell row a request writes for the person asked, and the one an acceptance writes back. */
export const FOLLOW_REQUEST_NOTIFICATION = 'follow_request';
export const FOLLOW_ACCEPTED_NOTIFICATION = 'follow_accepted';

/** The largest page any follow list answers, whatever the caller asks for. */
export const FOLLOW_PAGE_MAX = 100;

/** Which `user_follow_notices` kind records that each bell row type was already sent for a pair. */
const NOTICE_KIND: Record<string, FollowNoticeKind> = {
  [FOLLOW_REQUEST_NOTIFICATION]: 'request',
  [FOLLOW_ACCEPTED_NOTIFICATION]: 'accepted',
};

/**
 * One person in a follow list: who, and since when. `createdAt` is when the request was made in
 * the inbox and the sent list, and when it was ACCEPTED in the followers list - since when that
 * person follows.
 */
export interface FollowListEntry {
  userId: string;
  createdAt: Date;
}

/**
 * The SQL condition: no block stands between `a` and `b`, whichever of them asked for it - the
 * symmetric rule of `isBlockedBetween`, as a fragment for a statement that must decide atomically.
 */
const NO_BLOCK_BETWEEN = (a: string, b: string) => `NOT EXISTS (SELECT 1 FROM user_blocks blk
  WHERE (blk."blockerId" = ${a} AND blk."blockedId" = ${b})
     OR (blk."blockerId" = ${b} AND blk."blockedId" = ${a}))`;

/**
 * TypeORM's Postgres driver answers an UPDATE or a DELETE with `[rows, rowCount]` and anything else
 * with the rows alone; this reads the rows out of either shape.
 */
function returnedRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}

/**
 * FOLLOW REQUESTS (WP-F2): every personal account is private (user, 2026-10-25, Q1), so following a
 * person writes a `pending` row that the person accepts or refuses.
 *
 * - ASK: one idempotent `INSERT ... SELECT` (`FollowsService.recordFollowRequest`) that writes only
 *   for a PERSON with no block between the two (404 FOLLOW_TARGET_NOT_FOUND, 403 FOLLOW_BLOCKED).
 * - NOTIFY ONCE PER PAIR AND KIND, FROM DURABLE STATE: ask -> withdraw -> ask would otherwise send a
 *   push per loop. The first call that inserts the `user_follow_notices` row for (asker, person,
 *   kind) notifies; every later one finds the row and stays silent. Never a clock: the row is the
 *   "have I already told them", and the request itself still shows in the inbox, which reads
 *   `user_follows`. The ask route is also throttled per user (FollowRequestsController).
 * - ACCEPT: ONE conditional `UPDATE ... WHERE status = 'pending'` that also dates `acceptedAt`, and
 *   takes the row lock: a
 *   withdraw racing it either deletes the row first (the accept finds nothing, 404) or waits and
 *   deletes the follow after (the follower left, which they may). The asker is told
 *   (`follow_accepted`, decided 2026-10-27).
 * - REFUSE: the row is DELETED and nobody is told; the asker may ask again. The bell row of the
 *   request goes with it, as it does when the asker withdraws.
 */
@Injectable()
export class FollowRequestsService {
  private readonly logger = new Logger(FollowRequestsService.name);

  constructor(
    private readonly follows: FollowsService,
    private readonly notifications: PostNotificationsService,
    @InjectDataSource() private readonly dataSource: DataSource
  ) {}

  /** Asks to follow `followedUserId`; see the class docblock for the refusals and the notice. */
  async ask(
    followerUserId: string,
    followedUserId: string
  ): Promise<{ ok: boolean; status: FollowStatus }> {
    const { status, created } = await this.follows.recordFollowRequest(
      followerUserId,
      followedUserId
    );
    if (created) {
      await this.notifyQuietly(followedUserId, followerUserId, FOLLOW_REQUEST_NOTIFICATION);
    }
    return { ok: true, status };
  }

  /**
   * Unfollows, or withdraws a request not answered yet - and a withdrawn request's bell row goes
   * with it, so the person asked is not left reading an ask that no longer exists.
   */
  async leave(followerUserId: string, followedUserId: string): Promise<{ ok: boolean }> {
    const { removed } = await this.follows.unfollowUser(followerUserId, followedUserId);
    if (removed === FOLLOW_PENDING) {
      await this.dropRequestNotification(followedUserId, followerUserId);
    }
    return { ok: true };
  }

  /** The requests waiting for `userId`'s answer, newest first - their own inbox and nobody else's. */
  async incoming(userId: string, limit: number, offset: number): Promise<FollowListEntry[]> {
    const rows: FollowListEntry[] = await this.dataSource.query(
      `SELECT f."followerUserId" AS "userId", f."createdAt" AS "createdAt"
         FROM user_follows f
        WHERE f."followedUserId" = $1 AND f.status = $2
          AND ${NO_BLOCK_BETWEEN('f."followerUserId"', 'f."followedUserId"')}
        ORDER BY f."createdAt" DESC, f.id
        LIMIT $3 OFFSET $4`,
      [userId, FOLLOW_PENDING, clampLimit(limit), Math.max(0, offset)]
    );
    this.logger.debug(`[FOLLOW-REQ] inbox of ${short(userId)}: ${rows.length} row(s)`);
    return rows;
  }

  /** How many requests wait for `userId`'s answer - one count on the partial index of 114. */
  async incomingCount(userId: string): Promise<{ pending: number }> {
    const rows: { n: string }[] = await this.dataSource.query(
      `SELECT count(*) AS n FROM user_follows f
        WHERE f."followedUserId" = $1 AND f.status = $2
          AND ${NO_BLOCK_BETWEEN('f."followerUserId"', 'f."followedUserId"')}`,
      [userId, FOLLOW_PENDING]
    );
    return { pending: Number(rows[0]?.n ?? 0) };
  }

  /**
   * `userId` accepts `followerUserId`'s request. 404 when there is no pending request - never
   * asked, already answered, withdrawn, or a block standing between them (whose severing is a
   * best-effort cross-service call, so the statement does not trust it to have run).
   */
  async accept(userId: string, followerUserId: string): Promise<{ ok: boolean }> {
    const updated = returnedRows<{ id: string }>(
      await this.dataSource.query(
        `UPDATE user_follows f SET status = $3, "acceptedAt" = now()
          WHERE f."followedUserId" = $1 AND f."followerUserId" = $2 AND f.status = $4
            AND ${NO_BLOCK_BETWEEN('$1', '$2')}
          RETURNING f.id`,
        [userId, followerUserId, FOLLOW_ACCEPTED, FOLLOW_PENDING]
      )
    );
    if (updated.length === 0) {
      this.logger.debug(
        `[FOLLOW-REQ] ${short(userId)} accept of ${short(followerUserId)}: no pending request`
      );
      throw new NotFoundException('Follow request not found');
    }
    this.logger.log(`[FOLLOW-REQ] ${short(userId)} accepted ${short(followerUserId)}`);
    await this.notifyQuietly(followerUserId, userId, FOLLOW_ACCEPTED_NOTIFICATION);
    return { ok: true };
  }

  /** `userId` refuses `followerUserId`'s request: the row is deleted and nobody is told. */
  async refuse(userId: string, followerUserId: string): Promise<{ ok: boolean }> {
    const deleted = returnedRows<{ id: string }>(
      await this.dataSource.query(
        `DELETE FROM user_follows f
          WHERE f."followedUserId" = $1 AND f."followerUserId" = $2 AND f.status = $3
          RETURNING f.id`,
        [userId, followerUserId, FOLLOW_PENDING]
      )
    );
    if (deleted.length === 0) {
      this.logger.debug(
        `[FOLLOW-REQ] ${short(userId)} refusal of ${short(followerUserId)}: no pending request`
      );
      throw new NotFoundException('Follow request not found');
    }
    this.logger.log(`[FOLLOW-REQ] ${short(userId)} refused ${short(followerUserId)}`);
    await this.dropRequestNotification(userId, followerUserId);
    return { ok: true };
  }

  // ── The caller's own lists (WP-F3) ──────────────────────────────────────────────────────────────

  /**
   * `userId`'s ACCEPTED followers, the most recently accepted first, each dated by `acceptedAt`
   * (migration 114; a follow older than the requests is dated by its creation). Only the caller's
   * own list exists as a route: no one reads another person's followers (no list-visibility rule
   * has been decided, so none is open). A pair a block stands between is left out, as everywhere a
   * follow is read.
   */
  async followers(userId: string, limit: number, offset: number): Promise<FollowListEntry[]> {
    const rows: FollowListEntry[] = await this.dataSource.query(
      `SELECT f."followerUserId" AS "userId", f."acceptedAt" AS "createdAt"
         FROM user_follows f
        WHERE f."followedUserId" = $1 AND f.status = $2
          AND ${NO_BLOCK_BETWEEN('f."followerUserId"', 'f."followedUserId"')}
        ORDER BY f."acceptedAt" DESC, f.id
        LIMIT $3 OFFSET $4`,
      [userId, FOLLOW_ACCEPTED, clampLimit(limit), Math.max(0, offset)]
    );
    this.logger.debug(`[FOLLOW-REQ] followers of ${short(userId)}: ${rows.length} row(s)`);
    return rows;
  }

  /**
   * `userId` removes `followerUserId` from their followers: the row is deleted and NOBODY is told
   * (decision 3); the removed person may ask again, which is a new request. 404 when that person
   * does not follow them - a pending request is refused, not removed.
   */
  async removeFollower(userId: string, followerUserId: string): Promise<{ ok: boolean }> {
    const deleted = returnedRows<{ id: string }>(
      await this.dataSource.query(
        `DELETE FROM user_follows f
          WHERE f."followedUserId" = $1 AND f."followerUserId" = $2 AND f.status = $3
          RETURNING f.id`,
        [userId, followerUserId, FOLLOW_ACCEPTED]
      )
    );
    if (deleted.length === 0) {
      this.logger.debug(
        `[FOLLOW-REQ] ${short(userId)} removal of ${short(followerUserId)}: not a follower`
      );
      throw new NotFoundException('Follower not found');
    }
    this.logger.log(`[FOLLOW-REQ] ${short(userId)} removed follower ${short(followerUserId)}`);
    return { ok: true };
  }

  /**
   * The requests `userId` SENT that nobody has answered yet, newest first - so each can be
   * withdrawn from a list (`DELETE users/:userId/follow`). An ask across a block is refused before
   * anything is written, but a request made BEFORE a block outlives it when the cross-service
   * severing did not run, so a pair a block stands between is left out here as in the inbox.
   */
  async outgoing(userId: string, limit: number, offset: number): Promise<FollowListEntry[]> {
    const rows: FollowListEntry[] = await this.dataSource.query(
      `SELECT f."followedUserId" AS "userId", f."createdAt" AS "createdAt"
         FROM user_follows f
        WHERE f."followerUserId" = $1 AND f.status = $2
          AND ${NO_BLOCK_BETWEEN('f."followerUserId"', 'f."followedUserId"')}
        ORDER BY f."createdAt" DESC, f.id
        LIMIT $3 OFFSET $4`,
      [userId, FOLLOW_PENDING, clampLimit(limit), Math.max(0, offset)]
    );
    this.logger.debug(`[FOLLOW-REQ] sent requests of ${short(userId)}: ${rows.length} row(s)`);
    return rows;
  }

  /**
   * Writes the bell row and its push - ONCE per (asker, person, kind): the `user_follow_notices`
   * row is claimed first, and a call that finds it already there sends nothing. BEST-EFFORT AND
   * LOUD: the row of `user_follows` is the durable fact and is already committed, so a
   * notification that fails is logged and the answer stands - failing the request would make the
   * asker try again for a request that exists. A claim whose notification then failed is not
   * retried: one missed bell row, logged, against a loop that could push without end.
   */
  private async notifyQuietly(recipientId: string, actorId: string, type: string): Promise<void> {
    // The notice is keyed by the FOLLOW pair, whichever side is told.
    const [follower, followed] =
      type === FOLLOW_REQUEST_NOTIFICATION ? [actorId, recipientId] : [recipientId, actorId];
    try {
      const claimed: unknown[] = await this.dataSource.query(
        `INSERT INTO user_follow_notices ("followerUserId", "followedUserId", kind)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING kind`,
        [follower, followed, NOTICE_KIND[type]]
      );
      if (claimed.length === 0) {
        this.logger.debug(
          `[FOLLOW-REQ] ${type} to ${short(recipientId)} already sent once for this pair: silent`
        );
        return;
      }
      await this.notifications.createNotification({
        recipientId,
        type,
        // A follow notice has no post: the ACTOR's id stands in the required column, and the push
        // carries a typed target so no `post/<id>` link is ever built from it - the request inbox for
        // a request (WP-F4), the notifications list for an acceptance (its row opens the profile).
        postId: actorId,
        actorId,
        text: '',
        pushData: {
          target:
            type === FOLLOW_REQUEST_NOTIFICATION ? FOLLOW_REQUESTS_TARGET : NOTIFICATIONS_TARGET,
        },
      });
    } catch (e) {
      this.logger.warn(
        `[FOLLOW-REQ] ${type} to ${short(recipientId)} not written: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Deletes the bell row of a request that no longer exists (refused or withdrawn). */
  private async dropRequestNotification(recipientId: string, askerId: string): Promise<void> {
    try {
      await this.dataSource.query(
        `DELETE FROM post_notifications WHERE "recipientId" = $1 AND "actorId" = $2 AND type = $3`,
        [recipientId, askerId, FOLLOW_REQUEST_NOTIFICATION]
      );
    } catch (e) {
      this.logger.warn(
        `[FOLLOW-REQ] request bell row of ${short(askerId)} for ${short(recipientId)} not dropped: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}

/** A page size the caller asked for, held to 1..{@link FOLLOW_PAGE_MAX}. */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return FOLLOW_PAGE_MAX;
  return Math.min(FOLLOW_PAGE_MAX, Math.max(1, Math.trunc(limit)));
}
