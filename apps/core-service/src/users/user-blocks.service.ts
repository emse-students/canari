import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { UserBlock } from './entities/user-block.entity';
import { User } from './entities/user.entity';
import { socialUrl } from '../internal/service-urls';

/**
 * How many people one account may block.
 *
 * NOT a product rule - nobody should ever meet it. It bounds the table and, more to the point, the
 * exclusion list this service hands to every user search: an unbounded list would put an unbounded
 * clause on the hottest query in the app.
 */
const MAX_BLOCKS_PER_USER = 200;

/** One blocked person, as the blocker's own list shows them. */
export interface BlockedUserRow {
  userId: string;
  displayName: string | null;
  createdAt: string;
}

/**
 * Blocking, from the two people's side.
 *
 * WHAT A BLOCK DOES, exhaustively: the two accounts stop finding each other in target pickers
 * (user search, mention autocomplete), neither can open a 1-to-1 with the other, neither can add
 * the other to a group, and neither can invite the other into a private salon - inside a shared
 * community included. Existing conversations, existing groups, community membership and post
 * visibility are all untouched.
 *
 * WHAT IT IS NOT: it is not a report and not a moderation signal. Nothing about a block reaches an
 * administrator, by the user's decision of 2026-08-27 - these are conflicts between two people, and
 * a dashboard counting them would turn a private gesture into a record a third party reads. Someone
 * who wants a moderator involved files a report, which is a separate and deliberate act.
 *
 * ENFORCEMENT DOES NOT LIVE HERE. Hiding a person from a search stops nobody who knows a uuid, so
 * the refusals sit at the mutations themselves - `addGroupMember` in chat-delivery-service and the
 * salon invitation in social-service, each reading `user_blocks` directly. This service owns the
 * list and the search exclusion.
 */
@Injectable()
export class UserBlocksService {
  private readonly logger = new Logger(UserBlocksService.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  constructor(
    @InjectRepository(UserBlock)
    private readonly blockRepo: Repository<UserBlock>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>
  ) {}

  /**
   * Every account this user must not be shown, in EITHER direction - the ones they blocked and the
   * ones who blocked them.
   *
   * One query, because both halves answer the same question. A caller that asked only about its own
   * blocks would leave the blocked party still able to find the blocker, which is the half that
   * matters.
   */
  async invisibleUserIdsFor(userId: string): Promise<string[]> {
    if (!userId) return [];
    const rows: { otherId: string }[] = await this.blockRepo.manager.query(
      `SELECT "blockedId" AS "otherId" FROM user_blocks WHERE "blockerId" = $1
       UNION
       SELECT "blockerId" AS "otherId" FROM user_blocks WHERE "blockedId" = $1`,
      [userId]
    );
    return rows.map((r) => r.otherId);
  }

  /** True when a block exists between the two accounts, whichever of them asked for it. */
  async isBlockedBetween(a: string, b: string): Promise<boolean> {
    if (!a || !b || a === b) return false;
    const rows = await this.blockRepo.manager.query(
      `SELECT 1 FROM user_blocks
       WHERE ("blockerId" = $1 AND "blockedId" = $2)
          OR ("blockerId" = $2 AND "blockedId" = $1)
       LIMIT 1`,
      [a, b]
    );
    return rows.length > 0;
  }

  /** The people this user has blocked, newest first, with the names needed to unblock them. */
  async listBlocks(blockerId: string): Promise<BlockedUserRow[]> {
    const blocks = await this.blockRepo.find({
      where: { blockerId },
      order: { createdAt: 'DESC' },
    });
    if (blocks.length === 0) return [];

    // The blocked person is hidden from search, so their name cannot be resolved the usual way and
    // the list would be a column of uuids nobody can act on. It is read here directly.
    const rows: { id: string; displayName: string | null }[] = await this.userRepo.manager.query(
      `SELECT id, "displayName" FROM users WHERE id = ANY($1)`,
      [blocks.map((b) => b.blockedId)]
    );
    const names = new Map(rows.map((r) => [r.id, r.displayName]));

    return blocks.map((b) => ({
      userId: b.blockedId,
      displayName: names.get(b.blockedId) ?? null,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  /**
   * Blocks `blockedId` on behalf of `blockerId`. Idempotent: blocking twice is the same block.
   *
   * Severing the two follows is part of the act, not a follow-up - staying subscribed to someone
   * you have just blocked is a state nobody asked for. It is a cross-service call and therefore
   * BEST-EFFORT AND LOUD: the block itself is already durable when this runs, so a social-service
   * outage must not fail the request, but it must not pass unnoticed either.
   */
  async block(blockerId: string, blockedId: string): Promise<{ ok: true }> {
    this.logger.log(`[block] blocker=${blockerId} blocked=${blockedId}`);
    if (!blockedId) throw new BadRequestException('A user to block is required');
    if (blockerId === blockedId) throw new BadRequestException('You cannot block yourself');

    const target = await this.userRepo.findOne({ where: { id: blockedId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found');

    const existing = await this.blockRepo.findOne({ where: { blockerId, blockedId } });
    if (existing) {
      this.logger.log(`[block] already blocked, no-op blocker=${blockerId} blocked=${blockedId}`);
      return { ok: true };
    }

    const current = await this.blockRepo.count({ where: { blockerId } });
    if (current >= MAX_BLOCKS_PER_USER) {
      throw new UnprocessableEntityException(
        `You cannot block more than ${MAX_BLOCKS_PER_USER} people`
      );
    }

    await this.blockRepo.save(this.blockRepo.create({ blockerId, blockedId }));
    await this.severFollows(blockerId, blockedId);
    return { ok: true };
  }

  /** Lifts a block. Only the blocker can, which is why the row keeps its direction. */
  async unblock(blockerId: string, blockedId: string): Promise<{ ok: true }> {
    this.logger.log(`[unblock] blocker=${blockerId} blocked=${blockedId}`);
    const res = await this.blockRepo.delete({ blockerId, blockedId });
    if (!res.affected) throw new NotFoundException('This person is not blocked');
    return { ok: true };
  }

  /** Removes every block this account is party to, in both directions. Used by account deletion. */
  async deleteAllFor(userId: string): Promise<void> {
    const removed = await this.blockRepo.manager.query(
      `DELETE FROM user_blocks WHERE "blockerId" = $1 OR "blockedId" = $1 RETURNING id`,
      [userId]
    );
    this.logger.log(
      `[deleteAllFor] user=${userId} rows=${Array.isArray(removed) ? removed.length : 0}`
    );
  }

  /** Asks social-service to drop both follow relationships between the two accounts. */
  private async severFollows(a: string, b: string): Promise<void> {
    try {
      await axios.delete(
        socialUrl(`internal/follows/between/${encodeURIComponent(a)}/${encodeURIComponent(b)}`),
        { headers: { 'x-internal-secret': this.internalSecret }, timeout: 5_000 }
      );
    } catch (err) {
      this.logger.warn(
        `[block] follow severing failed, the two accounts may still follow each other: ` +
          `a=${a} b=${b}: ${String(err)}`
      );
    }
  }
}
