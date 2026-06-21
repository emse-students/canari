import {
  Controller,
  Delete,
  Get,
  Param,
  Headers,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Post as PostEntity } from '../posts/entities/post.entity';
import { ChannelMember } from '../channels/entities/channel-member.entity';
import { ChannelMessage } from '../channels/entities/channel-message.entity';
import { AssociationMember } from '../associations/entities/association-member.entity';
import { AssociationRoleHistory } from '../associations/entities/association-role-history.entity';
import { UserFollow } from '../follows/entities/user-follow.entity';
import { AssociationFollow } from '../follows/entities/association-follow.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { UserModeration } from '../moderation/entities/user-moderation.entity';
import { ContentReport } from '../moderation/entities/content-report.entity';

/**
 * Internal-only user data deletion endpoint - called by core-service during account deletion.
 * NOT exposed through Nginx: only reachable via Docker-internal networking.
 * Auth: X-Internal-Secret header matched against INTERNAL_SECRET env var.
 */
@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);
  private readonly secret = process.env.INTERNAL_SECRET ?? '';

  constructor(
    @InjectRepository(PostEntity)
    private readonly postRepo: Repository<PostEntity>,
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
    @InjectRepository(ChannelMessage)
    private readonly channelMessageRepo: Repository<ChannelMessage>,
    @InjectRepository(AssociationMember)
    private readonly assocMemberRepo: Repository<AssociationMember>,
    @InjectRepository(AssociationRoleHistory)
    private readonly roleHistoryRepo: Repository<AssociationRoleHistory>,
    @InjectRepository(UserFollow)
    private readonly userFollowRepo: Repository<UserFollow>,
    @InjectRepository(AssociationFollow)
    private readonly assoFollowRepo: Repository<AssociationFollow>,
    @InjectRepository(UserTag)
    private readonly userTagRepo: Repository<UserTag>,
    @InjectRepository(PurchaseRecord)
    private readonly purchaseRepo: Repository<PurchaseRecord>,
    @InjectRepository(UserModeration)
    private readonly moderationRepo: Repository<UserModeration>,
    @InjectRepository(ContentReport)
    private readonly reportRepo: Repository<ContentReport>
  ) {}

  /** Returns member user IDs for an association (core-service directory filter). */
  @Get('associations/:associationId/member-user-ids')
  async listMemberUserIds(
    @Param('associationId') associationId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    const expected = Buffer.from(this.secret);
    const received = Buffer.from(headerSecret ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }
    const rows = await this.assocMemberRepo.find({
      where: { associationId },
      select: { userId: true },
    });
    return { userIds: rows.map((r) => r.userId) };
  }

  /**
   * Deletes or anonymises all social data for the given user.
   * Hard-deletes: posts, memberships, follows, tags, moderation records.
   * Anonymises (keeps record): channel messages, purchase records, content reports
   * - these are preserved for conversation continuity or legal/financial obligations.
   */
  @Delete('users/:userId')
  async deleteUserData(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    const expected = Buffer.from(this.secret);
    const received = Buffer.from(headerSecret ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }

    this.logger.log(`[INTERNAL_DELETE] starting social data for user=${userId}`);

    await Promise.all([
      // Hard deletes - user's own content and memberships
      this.postRepo.delete({ authorId: userId }),
      this.channelMemberRepo.delete({ userId }),
      this.assocMemberRepo.delete({ userId }),
      this.roleHistoryRepo.delete({ userId }),
      this.userFollowRepo.delete({ followerUserId: userId }),
      this.userFollowRepo.delete({ followedUserId: userId }),
      this.assoFollowRepo.delete({ followerUserId: userId }),
      this.userTagRepo.delete({ userId }),
      this.moderationRepo.delete({ userId }),

      // Anonymise - preserve records for legal/accounting obligations or conversation continuity
      this.channelMessageRepo.update({ authorId: userId }, { authorId: '[deleted]' }),
      this.purchaseRepo.update({ userId }, { userId: '[deleted]' }),
      this.reportRepo.update({ reporterId: userId }, { reporterId: '[deleted]' }),
    ]);

    this.logger.log(`[INTERNAL_DELETE] done social data for user=${userId}`);
    return { ok: true };
  }
}
