import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RedisService } from '../common/redis';
import { isBlockedBetween } from '../common/user-blocks';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { memberCanModerate } from './moderation-grant';
import {
  mayWriteCommunityNickname,
  NICKNAME_REQUIRES_MODERATION,
  NICKNAME_TARGET_NOT_MEMBER,
  nicknameReportSubject,
  normalizeNickname,
} from './community-nicknames';

/**
 * One member's nickname state in a community, as a client merges it: `nickname` null is a reset,
 * dated like a set (`at`, epoch ms on this server's clock) so a late event cannot resurrect it.
 * `reportSubject` is what a report of this exact version names (`nicknameReportSubject`).
 */
export interface CommunityNicknameEntry {
  userId: string;
  nickname: string | null;
  setBy: string;
  at: number;
  reportSubject: string;
}

interface NicknameRow {
  id: string;
  userId: string;
  nickname: string | null;
  nicknameSetBy: string | null;
  nicknameSetAt: Date | string | null;
}

/**
 * NICKNAMES IN A COMMUNITY ("Modifier les pseudos", owner 2026-10-14): a moderator names a member, in
 * the membership row's own columns (migration 149), and the server re-checks the moderation grant on
 * every write - the client is handed only the DECISION (`viewerCanModerate`), never a role name.
 *
 * An MLS group's nicknames are NOT here: they ride an MLS frame the server never reads
 * (frontend `conversationNicknames.svelte.ts`). The two mechanisms share one register shape, so the
 * client merges both the same way.
 */
@Injectable()
export class CommunityNicknamesService {
  private readonly logger = new Logger(CommunityNicknamesService.name);

  constructor(
    @InjectRepository(ChannelMember) private readonly memberRepo: Repository<ChannelMember>,
    @InjectRepository(ChannelRole) private readonly roleRepo: Repository<ChannelRole>,
    private readonly redis: RedisService
  ) {}

  /**
   * Every nickname state of a community - set ones and resets alike - for a member of it. A reset is
   * returned too, with its date, for the reason {@link CommunityNicknameEntry} gives.
   */
  async list(workspaceId: string, viewerId: string): Promise<CommunityNicknameEntry[]> {
    await this.memberOrRefuse(workspaceId, viewerId);
    const rows: NicknameRow[] = await this.memberRepo.query(
      `SELECT id::text, "userId", nickname, "nicknameSetBy", "nicknameSetAt"
         FROM channel_members
        WHERE "workspaceId" = $1 AND "nicknameSetAt" IS NOT NULL`,
      [workspaceId]
    );
    return rows.map(toEntry);
  }

  /**
   * Sets (or, with a value empty once normalized, clears) `targetId`'s nickname in a community.
   *
   * Refusals, each typed: `400 nickname_too_long`; `403` not a member; `404 NICKNAME_TARGET_NOT_MEMBER`;
   * `403 NICKNAME_REQUIRES_MODERATION` unless the actor moderates here or clears their own;
   * `403 USER_BLOCKED` when a block stands between actor and target (a blocked person cannot rename
   * the blocker, nor the reverse - the block is symmetric everywhere it is read).
   *
   * Written as a COLUMN UPDATE keyed by the row, never a `save` of a membership read earlier (the
   * rule of every membership write), and announced on `workspace.updated` - a type every client
   * already handles, whose absent fields mean "unchanged", so a build older than this one hears
   * nothing it would mistake for something else.
   */
  async set(
    workspaceId: string,
    actorId: string,
    targetId: string,
    raw: unknown
  ): Promise<CommunityNicknameEntry> {
    const actor = actorId.trim().toLowerCase();
    const target = targetId.trim().toLowerCase();
    const normalized = normalizeNickname(raw);
    // `=== false`, not `!`: this package compiles without strictNullChecks, where a truthiness test
    // does not narrow the union.
    if (normalized.ok === false) {
      throw new BadRequestException({ code: normalized.code, message: 'Nickname too long' });
    }
    const actorMember = await this.memberOrRefuse(workspaceId, actor);
    const targetMember = await this.memberRepo.findOne({ where: { workspaceId, userId: target } });
    if (!targetMember) {
      throw new NotFoundException({
        code: NICKNAME_TARGET_NOT_MEMBER,
        message: 'Not a member of this community',
      });
    }
    const allowed = mayWriteCommunityNickname({
      actorIsTarget: actor === target,
      isReset: normalized.value === null,
      actorCanModerate: await memberCanModerate(this.roleRepo, actorMember),
    });
    if (!allowed) {
      this.logger.warn(
        `[NICKNAME] refused workspace=${workspaceId} actor=${actor.slice(0, 8)} target=${target.slice(0, 8)}: no moderation grant`
      );
      throw new ForbiddenException({
        code: NICKNAME_REQUIRES_MODERATION,
        message: 'Only a moderator may name a member',
      });
    }
    if (actor !== target && (await isBlockedBetween(this.memberRepo.manager, actor, target))) {
      this.logger.log(
        `[NICKNAME] refused workspace=${workspaceId} actor=${actor.slice(0, 8)}: a block stands with the target`
      );
      throw new ForbiddenException({
        code: 'USER_BLOCKED',
        message: 'This person cannot be named by you',
      });
    }

    const updated: NicknameRow[][] | NicknameRow[] = await this.memberRepo.query(
      `UPDATE channel_members
          SET nickname = $3, "nicknameSetBy" = $4, "nicknameSetAt" = now()
        WHERE "workspaceId" = $1 AND "userId" = $2
        RETURNING id::text, "userId", nickname, "nicknameSetBy", "nicknameSetAt"`,
      [workspaceId, target, normalized.value, actor]
    );
    // node-postgres answers an UPDATE ... RETURNING through TypeORM as [rows, count].
    const rows = (Array.isArray(updated[0]) ? updated[0] : updated) as NicknameRow[];
    if (!rows[0]) {
      // The target left between the read above and this write: the membership is gone, and the
      // nickname with it.
      throw new NotFoundException({
        code: NICKNAME_TARGET_NOT_MEMBER,
        message: 'Not a member of this community',
      });
    }
    const entry = toEntry(rows[0]);
    this.logger.log(
      `[NICKNAME] workspace=${workspaceId} target=${target.slice(0, 8)} ${entry.nickname === null ? 'cleared' : 'set'} by=${actor.slice(0, 8)}`
    );

    const audience = (
      await this.memberRepo.find({ where: { workspaceId }, select: { userId: true } })
    ).map((m) => m.userId);
    await this.redis.publishChannelEvent(
      'workspace.updated',
      { workspaceId, nickname: entry },
      audience
    );
    return entry;
  }

  private async memberOrRefuse(workspaceId: string, userId: string): Promise<ChannelMember> {
    const member = await this.memberRepo.findOne({
      where: { workspaceId, userId: userId.trim().toLowerCase() },
    });
    if (!member) {
      this.logger.warn(
        `[NICKNAME] refused workspace=${workspaceId} user=${userId.slice(0, 8)}: not a member`
      );
      throw new ForbiddenException('Not a member of this workspace');
    }
    return member;
  }
}

function toEntry(row: NicknameRow): CommunityNicknameEntry {
  const at = row.nicknameSetAt ? new Date(row.nicknameSetAt).getTime() : 0;
  return {
    userId: row.userId,
    nickname: row.nickname,
    setBy: row.nicknameSetBy ?? '',
    at,
    reportSubject: nicknameReportSubject(row.id, at),
  };
}
