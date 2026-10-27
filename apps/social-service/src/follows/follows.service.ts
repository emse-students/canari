import { randomUUID } from 'crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AssociationFollow } from './entities/association-follow.entity';
import { UserFollow } from './entities/user-follow.entity';
import { Association } from '../associations/entities/association.entity';
import { FOLLOW_ACCEPTED, FOLLOW_PENDING, type FollowStatus } from './follow-status';

/** How a follows log line names an account: its first 8 characters, never a whole account id. */
const short = (id: string): string => id.slice(0, 8);

/** The stable codes a follow refusal carries - the client maps the code, never the message. */
export const FOLLOW_CODES = {
  /** The id names no person: an association, a list, an institution, or nobody. */
  targetNotFound: 'FOLLOW_TARGET_NOT_FOUND',
  /** A block stands between the two, in either direction. */
  blocked: 'FOLLOW_BLOCKED',
} as const;

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

  // ── Association follows ───────────────────────────────────────────────────

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

  // ── User follows ──────────────────────────────────────────────────────────
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
   * for the call that wrote it.
   *
   * ONE `INSERT ... SELECT ... ON CONFLICT DO NOTHING`, never a read then a write: two taps at once
   * used to both read "no row", and the second save hit the unique key as a 500. The SELECT carries
   * the two conditions a request needs, so neither is a check-then-insert: the target is a PERSON
   * (a `users` row - an association's id, or any unknown id, is refused 404 FOLLOW_TARGET_NOT_FOUND)
   * and no block stands between the two, in either direction (403 FOLLOW_BLOCKED; core-service's
   * block status already tells either side, so nothing is hidden by refusing). A conflict changes
   * nothing - an accepted follow stays accepted - and its status is then READ in a second statement,
   * which sees the winner's committed row. When nothing was written and no row exists, the reason is
   * read; a row withdrawn in between is asked again, the loop bounded by the outcomes a pair can be
   * in, never by a clock.
   */
  async recordFollowRequest(
    followerUserId: string,
    followedUserId: string
  ): Promise<{ status: FollowStatus; created: boolean }> {
    this.logger.debug(`[FOLLOW] ${short(followerUserId)} asks to follow ${short(followedUserId)}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const inserted: { status: FollowStatus }[] = await this.userFollowRepo.query(
        `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status)
         SELECT $1::uuid, $2::varchar, $3::varchar, $4::varchar
          WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = $3)
            AND NOT EXISTS (SELECT 1 FROM user_blocks b
                             WHERE (b."blockerId" = $2 AND b."blockedId" = $3)
                                OR (b."blockerId" = $3 AND b."blockedId" = $2))
         ON CONFLICT DO NOTHING
         RETURNING status`,
        [randomUUID(), followerUserId, followedUserId, FOLLOW_PENDING]
      );
      if (inserted.length > 0) {
        this.logger.log(
          `[FOLLOW] ${short(followerUserId)} -> ${short(followedUserId)}: request recorded, pending`
        );
        return { status: FOLLOW_PENDING, created: true };
      }
      const existing = await this.userFollowStatus(followerUserId, followedUserId);
      if (existing) {
        this.logger.debug(`[FOLLOW] ${short(followerUserId)} already ${existing}: unchanged`);
        return { status: existing, created: false };
      }
      await this.assertMayRequest(followerUserId, followedUserId);
      this.logger.warn(
        `[FOLLOW] ${short(followerUserId)} -> ${short(followedUserId)}: the row that refused the insert was gone when read (attempt ${attempt})`
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
    const [why]: { person: boolean; blocked: boolean }[] = await this.userFollowRepo.query(
      `SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = $2) AS person,
              EXISTS (SELECT 1 FROM user_blocks b
                       WHERE (b."blockerId" = $1 AND b."blockedId" = $2)
                          OR (b."blockerId" = $2 AND b."blockedId" = $1)) AS blocked`,
      [followerUserId, followedUserId]
    );
    if (!why?.person) {
      this.logger.debug(`[FOLLOW] ${short(followedUserId)} refused: not a person`);
      throw new NotFoundException({
        code: FOLLOW_CODES.targetNotFound,
        message: 'No person with this id',
      });
    }
    if (why.blocked) {
      this.logger.debug(
        `[FOLLOW] ${short(followerUserId)} -> ${short(followedUserId)} refused: a block stands`
      );
      throw new ForbiddenException({ code: FOLLOW_CODES.blocked, message: 'A block stands' });
    }
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
