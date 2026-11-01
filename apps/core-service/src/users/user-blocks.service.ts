import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { UserBlock } from './entities/user-block.entity';
import { User } from './entities/user.entity';
import { socialUrl } from '../internal/service-urls';
import { RefusalCode, refusalBody } from '../common/refusal-codes';

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
 * the other to a group, neither can invite the other into a private salon - inside a shared
 * community included - and neither is shown the other's PERSONAL posts or their comments, in the
 * feed, in search, by id or under an agenda event. Existing conversations, existing groups and
 * community membership are untouched.
 *
 * AN ASSOCIATION POST AND AN ANONYMOUS ONE ARE EXEMPT FROM THAT LAST ITEM, which is a rule and not
 * an oversight: their publisher is hidden from the viewer already, so filtering them on authorship
 * would answer the question the mask exists to refuse - block a suspect, see whether the post
 * leaves the feed, unblock. `PostsService.blockedAuthorSql` carries the reasoning.
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
    if (blockerId === blockedId)
      throw new BadRequestException(
        refusalBody(RefusalCode.BLOCK_SELF, 'You cannot block yourself')
      );

    const target = await this.userRepo.findOne({ where: { id: blockedId }, select: { id: true } });
    if (!target)
      throw new NotFoundException(
        refusalBody(RefusalCode.BLOCK_TARGET_NOT_FOUND, 'User not found')
      );

    const existing = await this.blockRepo.findOne({ where: { blockerId, blockedId } });
    if (existing) {
      this.logger.log(`[block] already blocked, no-op blocker=${blockerId} blocked=${blockedId}`);
      return { ok: true };
    }

    const current = await this.blockRepo.count({ where: { blockerId } });
    if (current >= MAX_BLOCKS_PER_USER) {
      throw new UnprocessableEntityException(
        refusalBody(
          RefusalCode.BLOCK_LIMIT_REACHED,
          `You cannot block more than ${MAX_BLOCKS_PER_USER} people`,
          { max: MAX_BLOCKS_PER_USER }
        )
      );
    }

    await this.blockRepo.save(this.blockRepo.create({ blockerId, blockedId }));
    await this.severFollows(blockerId, blockedId);
    await this.dropFeedCache();
    return { ok: true };
  }

  /**
   * Lifts a block. Only the blocker can, which is why the row keeps its direction.
   *
   * THE BLOCK ROW IS THE DURABLE RECORD THAT THE PAIR'S FOLLOWS ARE OWED A SEVERING (WP-F5, F2 of
   * its review). The severing at `block` is best-effort, and while the block stands that costs
   * nothing - every reader of a follow hides a pair a block stands between. But a follow row it
   * missed would come back the moment the block went, and since WP-F5 an accepted follow OPENS the
   * person's posts across spaces: lifting a block must not resurrect that. So the follows are
   * severed (both directions, idempotent) BEFORE the row is deleted, and a severing that fails
   * refuses the unblock with a 503 and leaves the block in place - retried by the person, never
   * by a clock. Nothing can recreate a follow in between: an ask and an acceptance are both refused
   * across a block inside their own statement, and the block is still there.
   */
  async unblock(blockerId: string, blockedId: string): Promise<{ ok: true }> {
    this.logger.log(`[unblock] blocker=${blockerId} blocked=${blockedId}`);
    const existing = await this.blockRepo.findOne({ where: { blockerId, blockedId } });
    if (!existing)
      throw new NotFoundException(
        refusalBody(RefusalCode.NOT_BLOCKED, 'This person is not blocked')
      );
    try {
      await this.severFollowsOrThrow(blockerId, blockedId);
    } catch (err) {
      this.logger.warn(
        `[unblock] REFUSED, the block stays: the pair's follows could not be severed first, and ` +
          `lifting it would re-open what a left-over follow opens: a=${blockerId} b=${blockedId}: ${String(err)}`
      );
      throw new ServiceUnavailableException('The block could not be lifted now, try again');
    }
    const res = await this.blockRepo.delete({ blockerId, blockedId });
    if (!res.affected)
      throw new NotFoundException(
        refusalBody(RefusalCode.NOT_BLOCKED, 'This person is not blocked')
      );
    // Lifting one restores no follow; this is what tells the feed its cached pages are answers to
    // a question that has changed.
    await this.dropFeedCache();
    return { ok: true };
  }

  /**
   * Asks social-service to throw its cached feed pages away.
   *
   * A block decides what a feed may show, and that feed is cached for 30 seconds per reader - so
   * without this the person who just blocked somebody opens the feed and finds their posts still
   * sitting there. BEST-EFFORT AND LOUD, exactly like `severFollows`: the block is already durable
   * when this runs, so a social-service outage must not fail the request, and a stale page for the
   * rest of one TTL is the whole cost. It must not pass unnoticed either.
   */
  private async dropFeedCache(): Promise<void> {
    try {
      await axios.post(
        socialUrl('internal/posts/list-cache/invalidate'),
        {},
        { headers: { 'x-internal-secret': this.internalSecret }, timeout: 5_000 }
      );
    } catch (err) {
      this.logger.warn(
        `[block] feed cache invalidation failed, a blocked account's posts may linger in a ` +
          `cached feed page for up to its TTL: ${String(err)}`
      );
    }
  }

  /** Asks social-service to drop both follow relationships between the two accounts; throws on failure. */
  private async severFollowsOrThrow(a: string, b: string): Promise<void> {
    await axios.delete(
      socialUrl(`internal/follows/between/${encodeURIComponent(a)}/${encodeURIComponent(b)}`),
      { headers: { 'x-internal-secret': this.internalSecret }, timeout: 5_000 }
    );
  }

  /**
   * The severing at BLOCK time: best-effort and loud, because the block is already durable and hides
   * the pair's follows from every reader while it stands; `unblock` severs again, and THAT one may
   * not fail.
   */
  private async severFollows(a: string, b: string): Promise<void> {
    try {
      await this.severFollowsOrThrow(a, b);
    } catch (err) {
      this.logger.warn(
        `[block] follow severing failed, the two accounts may still follow each other: ` +
          `a=${a} b=${b}: ${String(err)}`
      );
    }
  }
}
