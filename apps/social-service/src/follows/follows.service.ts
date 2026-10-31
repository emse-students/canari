import { randomUUID } from 'crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ReviewCohortBoundaryException, sameSideOfReviewCohort } from '../review-cohort';
import { AssociationFollow } from './entities/association-follow.entity';
import { UserFollow } from './entities/user-follow.entity';
import { Association } from '../associations/entities/association.entity';
import { FOLLOW_ACCEPTED, FOLLOW_PENDING, type FollowStatus } from './follow-status';
import type { FollowNoticeKind } from './entities/user-follow-notice.entity';

/** How a follows log line names an account: its first 8 characters, never a whole account id. */
export const short = (id: string): string => id.slice(0, 8);

/** The stable codes a follow refusal carries - the client maps the code, never the message. */
export const FOLLOW_CODES = {
  /** The id names no person: an association, a list, an institution, or nobody. */
  targetNotFound: 'FOLLOW_TARGET_NOT_FOUND',
  /** A block stands between the two, in either direction. */
  blocked: 'FOLLOW_BLOCKED',
  /** The asker already has {@link FOLLOW_PENDING_MAX} requests nobody has answered (409). */
  pendingLimit: 'FOLLOW_PENDING_LIMIT',
  /** The asker has notified {@link FOLLOW_ASKS_PER_DAY} new people in the last day (429). */
  dailyLimit: 'FOLLOW_DAILY_LIMIT',
} as const;

/**
 * How many requests one account may have waiting for an answer at once. A request names its
 * asker in a push to a stranger, so an account must not be able to ask the whole directory: past
 * this, it waits for answers or withdraws some (user-facing: 409 FOLLOW_PENDING_LIMIT).
 */
export const FOLLOW_PENDING_MAX = 100;

/**
 * How many NEW people one account may notify with a request per rolling day, counted from the
 * `request` rows of `user_follow_notices` it claimed - one per person first asked, claimed in the
 * same transaction as the request, so the count never lags behind a push still being sent.
 * The per-minute throttle bounds a burst; this bounds the day (429 FOLLOW_DAILY_LIMIT).
 */
export const FOLLOW_ASKS_PER_DAY = 50;

/** `$1`/`$2` are the two accounts; true when a block stands between them, in either direction. */
const BLOCK_BETWEEN = `EXISTS (SELECT 1 FROM user_blocks b
  WHERE (b."blockerId" = $1 AND b."blockedId" = $2) OR (b."blockerId" = $2 AND b."blockedId" = $1))`;

/**
 * The four conditions a NEW request needs (the two caps exact only under {@link ASK_LOCK_SQL}), each as SQL over `$1` (asker), `$2` (person), `$3`
 * ('pending'), `$4` ({@link FOLLOW_PENDING_MAX}), `$5` ({@link FOLLOW_ASKS_PER_DAY}) and `$6` (the
 * notice kind 'request') - {@link REQUEST_PARAMS}. Written once and used twice: as the WHERE of the
 * statement that writes the request, and as the columns of the read that names a refusal. The
 * daily cap counts only against an ask that would notify somebody NEW: re-asking a person already
 * told sends no push, so it is not what the cap is for.
 */
const REQUEST_CONDITIONS = {
  person: `EXISTS (SELECT 1 FROM users u WHERE u.id = $2::varchar)`,
  unblocked: `NOT EXISTS (SELECT 1 FROM user_blocks b
     WHERE (b."blockerId" = $1::varchar AND b."blockedId" = $2::varchar)
        OR (b."blockerId" = $2::varchar AND b."blockedId" = $1::varchar))`,
  // A request across a block is left out of the count, as it is left out of the asker's sent list:
  // the cap counts only what the asker can see and withdraw.
  underPending: `(SELECT count(*) FROM user_follows p
     WHERE p."followerUserId" = $1::varchar AND p.status = $3::varchar
       AND NOT EXISTS (SELECT 1 FROM user_blocks pb
         WHERE (pb."blockerId" = p."followerUserId" AND pb."blockedId" = p."followedUserId")
            OR (pb."blockerId" = p."followedUserId" AND pb."blockedId" = p."followerUserId"))
     ) < $4::int`,
  underDaily: `(EXISTS (SELECT 1 FROM user_follow_notices n
       WHERE n."followerUserId" = $1::varchar AND n."followedUserId" = $2::varchar
         AND n.kind = $6::varchar)
     OR (SELECT count(*) FROM user_follow_notices n
          WHERE n."followerUserId" = $1::varchar AND n.kind = $6::varchar
            AND n."createdAt" > now() - interval '1 day') < $5::int)`,
} as const;

/** The `user_follow_notices` kind a request claims - the one the daily cap counts. */
const REQUEST_NOTICE: FollowNoticeKind = 'request';

/** The parameters of {@link REQUEST_CONDITIONS}, in order. */
const REQUEST_PARAMS = (asker: string, person: string) => [
  asker,
  person,
  FOLLOW_PENDING,
  FOLLOW_PENDING_MAX,
  FOLLOW_ASKS_PER_DAY,
  REQUEST_NOTICE,
];

/**
 * ONE ASKER'S ASKS RUN ONE AT A TIME: a transaction-scoped advisory lock keyed by the asker, taken
 * before anything is counted. The two caps are counts, and under READ COMMITTED two statements
 * counting at once both see the same total and both insert; with the lock, each ask's statements
 * start after the previous ask of the same account COMMITTED, so they count its row. Asks by
 * different accounts never wait on each other.
 */
const ASK_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('follow-ask:' || $1::varchar, 0))`;

/** Manages follows for both associations and users. */
@Injectable()
export class FollowsService {
  private readonly logger = new Logger(FollowsService.name);

  constructor(
    @InjectRepository(AssociationFollow)
    private readonly followRepo: Repository<AssociationFollow>,
    @InjectRepository(UserFollow)
    private readonly userFollowRepo: Repository<UserFollow>,
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>
  ) {}

  // --- Association follows ---

  /** Follows an association. Silently ignores duplicate follows (idempotent). Throws if the association does not exist. */
  async followAssociation(followerUserId: string, associationId: string): Promise<{ ok: boolean }> {
    const exists = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!exists) {
      throw new NotFoundException('Association not found');
    }
    const already = await this.followRepo.findOne({ where: { followerUserId, associationId } });
    if (!already) {
      const row = this.followRepo.create({ followerUserId, associationId });
      await this.followRepo.save(row);
    }
    return { ok: true };
  }

  /** Removes a follow relationship. Throws NotFoundException if no such relationship exists. */
  async unfollowAssociation(
    followerUserId: string,
    associationId: string
  ): Promise<{ ok: boolean }> {
    const res = await this.followRepo.delete({ followerUserId, associationId });
    if (!res.affected) {
      throw new NotFoundException('Follow relationship not found');
    }
    return { ok: true };
  }

  /** Returns the IDs of all associations followed by the user. Used by PostsService to build the "followed" feed. */
  async getFollowedAssociationIdsForUser(followerUserId: string): Promise<string[]> {
    const rows = await this.followRepo.find({
      where: { followerUserId },
      select: { associationId: true },
    });
    return rows.map((r) => r.associationId);
  }

  /** Returns true if the user currently follows the given association. */
  async isFollowing(followerUserId: string, associationId: string): Promise<boolean> {
    const n = await this.followRepo.count({ where: { followerUserId, associationId } });
    return n > 0;
  }

  /** Returns lightweight summary rows (id, name, slug, logoUrl) for all associations the user follows. */
  async listFollowedAssociations(
    followerUserId: string
  ): Promise<Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'>[]> {
    const ids = await this.getFollowedAssociationIdsForUser(followerUserId);
    if (ids.length === 0) return [];
    const assos = await this.assoRepo.findBy({ id: In(ids) });
    return assos.map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      logoUrl: a.logoUrl,
    }));
  }

  // --- User follows ---
  //
  // Every personal account is private (user, 2026-10-25, Q1): a follow of a PERSON is a request
  // (`pending`) until that person accepts it. Only an `accepted` row is a follow - the Suivis feed,
  // the announce sweep and the live push count nothing else (WP-F1).

  /**
   * Asks to follow a user: writes a `pending` request, which the followed person answers.
   * Idempotent - a second ask writes nothing and answers the status the row already has, so asking
   * again never turns an accepted follow back into a request.
   */
  async followUser(
    followerUserId: string,
    followedUserId: string
  ): Promise<{ ok: boolean; status: FollowStatus }> {
    const { status } = await this.recordFollowRequest(followerUserId, followedUserId);
    return { ok: true, status };
  }

  /**
   * Writes a `pending` request unless a row already exists, and says which: `created` is true only
   * for the call that wrote it, and `noticeClaimed` only when that call also claimed the pair's
   * `request` notice - the first time this asker reaches this person, so the one ask that pushes.
   *
   * ONE `INSERT ... SELECT ... ON CONFLICT DO NOTHING`, never a read then a write: two taps at once
   * used to both read "no row", and the second save hit the unique key as a 500. The SELECT carries
   * the conditions a request needs, so none is a check-then-insert: the target is a PERSON (a
   * `users` row - an association's id, or any unknown id, is refused 404 FOLLOW_TARGET_NOT_FOUND),
   * no block stands between the two, in either direction (403 FOLLOW_BLOCKED; core-service's block
   * status already tells either side, so nothing is hidden by refusing), the asker has fewer than
   * {@link FOLLOW_PENDING_MAX} unanswered requests (409) and has told fewer than
   * {@link FOLLOW_ASKS_PER_DAY} new people in a day (429), so no account can push its name to the
   * whole directory.
   *
   * THE TWO CAPS ARE COUNTS, SO THEY HOLD ONLY UNDER {@link ASK_LOCK_SQL}: the insert and the claim
   * of the notice row run in ONE transaction that first takes the asker's lock, so the next ask of
   * the same account counts both - the daily cap reads exactly the notices claimed, never a push
   * still on its way. A conflict changes nothing - an accepted follow stays accepted - and its
   * status is then READ in a second statement, which sees the winner's committed row. When nothing
   * was written and no row exists, the reason is read; if every condition holds by then (a row
   * withdrawn, or a cap freed, in between) the ask is made again, the loop bounded by the outcomes
   * a pair can be in, never by a clock. A block that commits during the ask retracts what it wrote.
   */
  async recordFollowRequest(
    followerUserId: string,
    followedUserId: string
  ): Promise<{ status: FollowStatus; created: boolean; noticeClaimed: boolean }> {
    this.logger.debug(`[FOLLOW] ${short(followerUserId)} asks to follow ${short(followedUserId)}`);
    // Never across the review cohort's boundary, either way (review-cohort.ts): typed 403.
    if (!sameSideOfReviewCohort(followerUserId, followedUserId)) {
      this.logger.log(
        `[FOLLOW] ${short(followerUserId)} -> ${short(followedUserId)}: refused, across the review cohort's boundary`
      );
      throw new ReviewCohortBoundaryException();
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const written = await this.userFollowRepo.manager.transaction(async (tx) => {
        await tx.query(ASK_LOCK_SQL, [followerUserId]);
        const inserted: { id: string }[] = await tx.query(
          `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status)
           SELECT $7::uuid, $1::varchar, $2::varchar, $3::varchar
            WHERE ${Object.values(REQUEST_CONDITIONS).join('\n              AND ')}
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [...REQUEST_PARAMS(followerUserId, followedUserId), randomUUID()]
        );
        if (inserted.length === 0) return null;
        const claimed: unknown[] = await tx.query(
          `INSERT INTO user_follow_notices ("followerUserId", "followedUserId", kind)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING kind`,
          [followerUserId, followedUserId, REQUEST_NOTICE]
        );
        return { id: inserted[0].id, noticeClaimed: claimed.length > 0 };
      });
      if (written) {
        await this.retractIfBlockedSince(written, followerUserId, followedUserId);
        this.logger.log(
          `[FOLLOW] ${short(followerUserId)} -> ${short(followedUserId)}: request recorded, pending (first notice: ${written.noticeClaimed})`
        );
        return { status: FOLLOW_PENDING, created: true, noticeClaimed: written.noticeClaimed };
      }
      const existing = await this.userFollowStatus(followerUserId, followedUserId);
      if (existing) {
        this.logger.debug(`[FOLLOW] ${short(followerUserId)} already ${existing}: unchanged`);
        return { status: existing, created: false, noticeClaimed: false };
      }
      await this.assertMayRequest(followerUserId, followedUserId);
      this.logger.log(
        `[FOLLOW] ${short(followerUserId)} -> ${short(followedUserId)}: nothing written, yet every condition holds now - a row withdrawn or a cap freed in between; asking again (attempt ${attempt})`
      );
    }
    throw new ConflictException('The follow changed while it was being recorded');
  }

  /**
   * Why an insert that wrote nothing, for a pair that has no row, wrote nothing: the target is not
   * a person, or a block stands. Throws the typed refusal; returns when neither holds (the row was
   * there and withdrawn in between - the caller asks again).
   */
  private async assertMayRequest(followerUserId: string, followedUserId: string): Promise<void> {
    const [why]: Record<keyof typeof REQUEST_CONDITIONS, boolean>[] =
      await this.userFollowRepo.query(
        `SELECT ${Object.entries(REQUEST_CONDITIONS)
          .map(([name, sql]) => `${sql} AS "${name}"`)
          .join(',\n                ')}`,
        REQUEST_PARAMS(followerUserId, followedUserId)
      );
    if (!why?.person) {
      this.logger.debug(`[FOLLOW] ${short(followedUserId)} refused: not a person`);
      throw new NotFoundException({
        code: FOLLOW_CODES.targetNotFound,
        message: 'No person with this id',
      });
    }
    if (!why.unblocked) {
      this.logger.debug(
        `[FOLLOW] ${short(followerUserId)} -> ${short(followedUserId)} refused: a block stands`
      );
      throw new ForbiddenException({ code: FOLLOW_CODES.blocked, message: 'A block stands' });
    }
    if (!why.underPending) {
      this.logger.warn(
        `[FOLLOW] ${short(followerUserId)} refused: ${FOLLOW_PENDING_MAX} requests already unanswered`
      );
      throw new ConflictException({
        code: FOLLOW_CODES.pendingLimit,
        message: 'Too many requests waiting for an answer',
      });
    }
    if (!why.underDaily) {
      this.logger.warn(
        `[FOLLOW] ${short(followerUserId)} refused: ${FOLLOW_ASKS_PER_DAY} new people asked in a day`
      );
      throw new HttpException(
        { code: FOLLOW_CODES.dailyLimit, message: 'Too many new requests today' },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  /**
   * THE BLOCK RACE, CLOSED AFTER THE WRITE: an ask whose statement started before a block
   * committed, and committed after core-service's severing ran, would leave a request across the
   * block - and its push to the person who just blocked. The block is committed before the severing
   * is called, so it is visible to this read, made after the insert committed: if it stands, the
   * request this call wrote is deleted and the ask is refused as a block, before anything notifies.
   * The notice row this call claimed goes with it, in the same statement: nobody was told, so it
   * charges no daily cap and does not silence the push of an ask made after the block is lifted -
   * the rule `FollowRequestsService.notifyQuietly` applies too, to a claim it ends up not sending.
   */
  private async retractIfBlockedSince(
    written: { id: string; noticeClaimed: boolean },
    followerUserId: string,
    followedUserId: string
  ): Promise<void> {
    const [row]: { blocked: boolean }[] = await this.userFollowRepo.query(
      `SELECT ${BLOCK_BETWEEN} AS blocked`,
      [followerUserId, followedUserId]
    );
    if (!row?.blocked) return;
    // ONE statement, so the request and its claim go together: a crash between two deletes would
    // leave a claim standing for a notice nobody received.
    await this.userFollowRepo.query(
      `WITH request AS (DELETE FROM user_follows WHERE id = $1 AND status = $2 RETURNING id)
       DELETE FROM user_follow_notices
        WHERE $6::boolean AND "followerUserId" = $3 AND "followedUserId" = $4 AND kind = $5`,
      [
        written.id,
        FOLLOW_PENDING,
        followerUserId,
        followedUserId,
        REQUEST_NOTICE,
        written.noticeClaimed,
      ]
    );
    this.logger.warn(
      `[FOLLOW] ${short(followerUserId)} -> ${short(followedUserId)}: a block committed during the ask - request retracted`
    );
    throw new ForbiddenException({ code: FOLLOW_CODES.blocked, message: 'A block stands' });
  }

  /**
   * Unfollows a user, or withdraws a request not answered yet: the row goes whatever its status,
   * in ONE `DELETE ... RETURNING status`, so the caller learns what it removed from the statement
   * that removed it rather than from a read a concurrent answer could have outdated. Throws
   * NotFoundException if there is neither.
   */
  async unfollowUser(
    followerUserId: string,
    followedUserId: string
  ): Promise<{ ok: boolean; removed: FollowStatus }> {
    const result: unknown = await this.userFollowRepo.query(
      `DELETE FROM user_follows WHERE "followerUserId" = $1 AND "followedUserId" = $2 RETURNING status`,
      [followerUserId, followedUserId]
    );
    // TypeORM's Postgres driver answers a DELETE with `[rows, rowCount]`.
    const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : []) as {
      status: FollowStatus;
    }[];
    if (rows.length === 0) {
      this.logger.debug(
        `[FOLLOW] ${short(followerUserId)} unfollow of ${short(followedUserId)}: no row`
      );
      throw new NotFoundException('Follow relationship not found');
    }
    this.logger.debug(
      `[FOLLOW] ${short(followerUserId)} left ${short(followedUserId)} (was ${rows[0].status})`
    );
    return { ok: true, removed: rows[0].status };
  }

  /**
   * Where the viewer stands with the given user: `accepted` (a follow), `pending` (a request not
   * answered yet) or `null` (neither).
   */
  async userFollowStatus(
    followerUserId: string,
    followedUserId: string
  ): Promise<FollowStatus | null> {
    const row = await this.userFollowRepo.findOne({
      where: { followerUserId, followedUserId },
    });
    return row?.status ?? null;
  }

  /**
   * Returns the IDs of the users the given user FOLLOWS - accepted rows only, a pending request is
   * not a follow. Used by PostsService to build the "followed" feed.
   */
  async getFollowedUserIdsForUser(followerUserId: string): Promise<string[]> {
    const rows = await this.userFollowRepo.find({
      where: { followerUserId, status: FOLLOW_ACCEPTED },
      select: { followedUserId: true },
    });
    return rows.map((r) => r.followedUserId);
  }
}
