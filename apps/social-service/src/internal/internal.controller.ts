import { Controller, Delete, Get, Param, Headers, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { assertInternalSecret } from './internal-secret.util';
import { Post as PostEntity } from '../posts/entities/post.entity';
import { ChannelMember } from '../channels/entities/channel-member.entity';
import { ChannelMessage } from '../channels/entities/channel-message.entity';
import { Association } from '../associations/entities/association.entity';
import { AssociationMember } from '../associations/entities/association-member.entity';
import { AssociationRoleHistory } from '../associations/entities/association-role-history.entity';
import { UserFollow } from '../follows/entities/user-follow.entity';
import { AssociationFollow } from '../follows/entities/association-follow.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { UserModeration } from '../moderation/entities/user-moderation.entity';
import { ContentReport } from '../moderation/entities/content-report.entity';
import { ChannelService } from '../channels/channel.service';

/**
 * Internal-only user data deletion endpoint - called by core-service during account deletion.
 * NOT exposed through Nginx: only reachable via Docker-internal networking.
 * Auth: X-Internal-Secret header matched against INTERNAL_SECRET env var.
 */
@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  constructor(
    @InjectRepository(PostEntity)
    private readonly postRepo: Repository<PostEntity>,
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
    @InjectRepository(ChannelMessage)
    private readonly channelMessageRepo: Repository<ChannelMessage>,
    @InjectRepository(Association)
    private readonly assocRepo: Repository<Association>,
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
    private readonly reportRepo: Repository<ContentReport>,
    private readonly channelService: ChannelService
  ) {}

  /**
   * Drops every follow relationship between two accounts, in BOTH directions.
   *
   * Called by core-service when one of them blocks the other: staying subscribed to somebody you
   * have just blocked is a state nobody asked for, and follows live here while blocks live there.
   *
   * Idempotent - two people who never followed each other are a valid, silent zero. The count is
   * logged either way, because a sweep that reports nothing is a sweep nobody can tell ran.
   */
  @Delete('follows/between/:userA/:userB')
  async severFollowsBetween(
    @Param('userA') userA: string,
    @Param('userB') userB: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    assertInternalSecret(headerSecret);
    const [forward, backward] = await Promise.all([
      this.userFollowRepo.delete({ followerUserId: userA, followedUserId: userB }),
      this.userFollowRepo.delete({ followerUserId: userB, followedUserId: userA }),
    ]);
    const removed = (forward.affected ?? 0) + (backward.affected ?? 0);
    this.logger.log(`[INTERNAL_SEVER_FOLLOWS] a=${userA} b=${userB} removed=${removed}`);
    return { ok: true, removed };
  }

  /** Returns member user IDs for an association (core-service directory filter). */
  @Get('associations/:associationId/member-user-ids')
  async listMemberUserIds(
    @Param('associationId') associationId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    assertInternalSecret(headerSecret);
    const rows = await this.assocMemberRepo.find({
      where: { associationId },
      select: { userId: true },
    });
    return { userIds: rows.map((r) => r.userId) };
  }

  /**
   * Associations of a user for external profile display (e.g. Sky parrainage app):
   * `current` = memberships in active associations, `former` = memberships in
   * archived associations plus past role-history entries (CV). Read-only projection.
   */
  @Get('users/:userId/associations')
  async listUserAssociations(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    assertInternalSecret(headerSecret);

    const members = await this.assocMemberRepo.find({ where: { userId } });
    const history = await this.roleHistoryRepo.find({
      where: { userId },
      order: { sortOrder: 'ASC' },
    });

    // Resolve association names/logos for both memberships and history in one query.
    const ids = Array.from(
      new Set([...members.map((m) => m.associationId), ...history.map((h) => h.associationId)])
    );
    const assocs = ids.length ? await this.assocRepo.find({ where: { id: In(ids) } }) : [];
    const byId = new Map(assocs.map((a) => [a.id, a]));

    const current: {
      name: string;
      slug: string;
      role: string;
      logoUrl: string | null;
    }[] = [];
    const former: {
      name: string;
      role: string;
      logoUrl: string | null;
      startYear: number | null;
      endYear: number | null;
    }[] = [];

    for (const m of members) {
      const a = byId.get(m.associationId);
      if (!a) continue;
      if (a.archived) {
        former.push({
          name: a.name,
          role: m.role,
          logoUrl: a.logoUrl,
          startYear: null,
          endYear: null,
        });
      } else {
        current.push({ name: a.name, slug: a.slug, role: m.role, logoUrl: a.logoUrl });
      }
    }

    for (const h of history) {
      const a = byId.get(h.associationId);
      former.push({
        name: a?.name ?? 'Association',
        role: h.roleTitle,
        logoUrl: a?.logoUrl ?? null,
        startYear: h.startYear,
        endYear: h.endYear,
      });
    }

    return { current, former };
  }

  /**
   * Deletes or anonymises all social data for the given user.
   * Hard-deletes: posts, memberships, follows, tags, moderation records.
   * Anonymises (keeps record): channel messages, purchase records, content reports
   * - these are preserved for conversation continuity or legal/financial obligations.
   *
   * "Preserved" here means the ROW SURVIVES THE ACCOUNT, not that it survives forever: a handled
   * content report is deleted 90 days after a moderator answered it, by the weekly cron in
   * `forms-reminder.scheduler`. This docblock claimed indefinite retention while a 7-day lazy purge
   * was quietly deleting the same rows on every moderator page load - three statements, one table.
   *
   * Community memberships are deleted here directly, which is the ONE path that bypasses
   * `leaveWorkspace` and its governance guards - so the workspaces involved are captured first and
   * repaired afterwards, or a deleted account would leave communities with no admin, or with no
   * members at all, that nothing could recover.
   */
  @Delete('users/:userId')
  async deleteUserData(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    assertInternalSecret(headerSecret);

    this.logger.log(`[INTERNAL_DELETE] starting social data for user=${userId}`);

    const affectedWorkspaceIds = (
      await this.channelMemberRepo.find({ where: { userId }, select: { workspaceId: true } })
    ).map((m) => m.workspaceId);

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
      // A report whose entire subject is this account has nothing left to moderate once the account
      // is gone. Reports on their CONTENT are left alone: those rows describe a post or a comment,
      // and are anonymised on the reporter side below like every other one.
      this.reportRepo.delete({ contentType: 'user', contentId: userId }),

      // Anonymise - preserve records for legal/accounting obligations or conversation continuity
      this.channelMessageRepo.update({ authorId: userId }, { authorId: '[deleted]' }),
      this.purchaseRepo.update({ userId }, { userId: '[deleted]' }),
      this.reportRepo.update({ reporterId: userId }, { reporterId: '[deleted]' }),
    ]);

    await this.channelService.repairWorkspacesAfterAccountDeletion(affectedWorkspaceIds, userId);

    this.logger.log(
      `[INTERNAL_DELETE] done social data for user=${userId} workspaces=${affectedWorkspaceIds.length}`
    );
    return { ok: true };
  }
}
