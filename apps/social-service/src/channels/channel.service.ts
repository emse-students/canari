import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as crypto from 'crypto';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import {
  ChannelKeyDistribution,
  type ChannelKeyDistributionStatus,
} from './entities/channel-key-distribution.entity';
import { RedisService } from '../common/redis';

import {
  CreateChannelDto,
  CreateRoleDto,
  CreateWorkspaceDto,
  ChannelJoinDto,
  ChannelLeaveDto,
  ChannelKickDto,
  ChannelInviteDto,
  ChannelUpdateRoleDto,
  SendChannelMessageDto,
  type ChannelBootstrapDto,
  type ChannelHistoryKeysDto,
  type ChannelKeyDistributionPayloadDto,
} from './dto/channel.dto';

@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  private normalizeRoleLabelToCanonical(name?: string | null): 'admin' | 'moderator' | 'member' {
    const normalized = String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (
      normalized === 'administrateur' ||
      normalized === 'administrator' ||
      normalized === 'admin'
    ) {
      return 'admin';
    }
    if (normalized === 'moderateur' || normalized === 'moderator') {
      return 'moderator';
    }
    return 'member';
  }

  private mapRoleInputToWorkspaceRoleName(name?: string | null): string {
    const normalized = String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (!normalized || normalized === 'member' || normalized === 'membre') return 'Membre';
    if (
      normalized === 'admin' ||
      normalized === 'administrateur' ||
      normalized === 'administrator'
    ) {
      return 'Administrateur';
    }
    if (normalized === 'moderator' || normalized === 'moderateur' || normalized === 'modérateur') {
      return 'Modérateur';
    }
    return name?.trim() || 'Membre';
  }

  private canAccessChannel(channel: Channel, member: ChannelMember): boolean {
    if (!channel.isPrivate) return true;
    const roleIds = member.roleIds || [];
    const allowed = channel.allowedRoles || [];
    return allowed.some((roleId) => roleIds.includes(roleId));
  }

  /**
   * Derive a 32-byte AES-256 key from the channel's master secret + version.
   * Uses HKDF-SHA256 to produce a unique key per epoch.
   */
  private deriveEpochKey(masterSecret: string, channelId: string, version: number): Buffer {
    const salt = crypto
      .createHash('sha256')
      .update(`channel-epoch:${channelId}:${version}`)
      .digest();
    const raw = crypto.hkdfSync(
      'sha256',
      Buffer.from(masterSecret, 'base64'),
      salt,
      Buffer.from('canari-channel-e2ee-v1'),
      32
    );
    return Buffer.from(raw);
  }

  private buildChannelBootstrap(
    channel: Pick<Channel, 'id' | 'keyVersion' | 'masterSecret'>
  ): ChannelBootstrapDto {
    const epochKey = this.deriveEpochKey(channel.masterSecret, channel.id, channel.keyVersion);
    return {
      channelId: channel.id,
      keyVersion: channel.keyVersion,
      newEpochBaseKey: epochKey.toString('base64'),
    };
  }

  constructor(
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(Channel) private readonly channelRepo: Repository<Channel>,
    @InjectRepository(ChannelRole) private readonly roleRepo: Repository<ChannelRole>,
    @InjectRepository(ChannelMember) private readonly memberRepo: Repository<ChannelMember>,
    @InjectRepository(ChannelMessage) private readonly messageRepo: Repository<ChannelMessage>,
    @InjectRepository(ChannelKeyDistribution)
    private readonly keyDistributionRepo: Repository<ChannelKeyDistribution>,
    private readonly redis: RedisService
  ) {}

  /**
   * Get all user IDs in a workspace for event broadcasting.
   */
  private async getWorkspaceMemberIds(workspaceId: string): Promise<string[]> {
    const members = await this.memberRepo.find({ where: { workspaceId } });
    return members.map((m) => m.userId);
  }

  // ================= WORKSPACES =================

  async createWorkspace(input: CreateWorkspaceDto) {
    const ws = this.workspaceRepo.create({
      name: input.name,
      slug: input.slug,
      createdBy: input.createdBy,
    });
    const savedWs = await this.workspaceRepo.save(ws);

    const adminRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Administrateur',
      priority: 100,
      permissions: [
        'MANAGE_WORKSPACE',
        'MANAGE_CHANNELS',
        'MANAGE_ROLES',
        'SEND_MESSAGES',
        'MODERATE_MESSAGES',
        'INVITE_USERS',
      ],
    });
    const savedAdminRole = await this.roleRepo.save(adminRole);

    const moderatorRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Modérateur',
      priority: 50,
      permissions: ['MANAGE_CHANNELS', 'MODERATE_MESSAGES', 'INVITE_USERS', 'SEND_MESSAGES'],
    });
    await this.roleRepo.save(moderatorRole);

    const memberRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Membre',
      priority: 10,
      permissions: ['SEND_MESSAGES', 'INVITE_USERS'],
    });
    await this.roleRepo.save(memberRole);

    const adminMember = this.memberRepo.create({
      workspaceId: savedWs.id,
      userId: input.createdBy,
      roleIds: [savedAdminRole.id],
    });
    await this.memberRepo.save(adminMember);

    const generalChannel = this.channelRepo.create({
      workspaceId: savedWs.id,
      name: 'general',
      isPrivate: false,
      masterSecret: crypto.randomBytes(32).toString('base64'),
      keyVersion: 1,
    });
    const savedGeneralChannel = await this.channelRepo.save(generalChannel);

    await this.pushKeyToUser(savedGeneralChannel, input.createdBy);

    return savedWs;
  }

  async getWorkspaceBySlug(slug: string) {
    const ws = await this.workspaceRepo.findOne({ where: { slug } });
    if (!ws) throw new NotFoundException('Workspace not found');

    const channels = await this.channelRepo.find({ where: { workspaceId: ws.id } });
    const members = await this.memberRepo.find({ where: { workspaceId: ws.id } });
    const roles = await this.roleRepo.find({ where: { workspaceId: ws.id } });

    return { workspace: ws, channels, members, roles };
  }

  async listWorkspacesForUser(userId: string) {
    const roles = await this.memberRepo.find({ where: { userId } });
    if (roles.length === 0) return [];

    const workspaceIds = [...new Set(roles.map((r) => r.workspaceId))];
    const workspaces = await this.workspaceRepo.find({ where: { id: In(workspaceIds) } });

    return workspaces.map((w) => ({
      ...w,
      id: w.id,
    }));
  }

  // ================= ROLES =================

  async createRole(input: CreateRoleDto & { actorUserId: string }) {
    // Only workspace admins (MANAGE_WORKSPACE or MANAGE_ROLES) may create roles.
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: input.workspaceId, userId: input.actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) => r.permissions.includes('MANAGE_WORKSPACE') || r.permissions.includes('MANAGE_ROLES')
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_ROLES permission');

    const role = this.roleRepo.create({
      workspaceId: input.workspaceId,
      name: input.name,
      permissions: input.permissions,
    });
    return this.roleRepo.save(role);
  }

  // ================= CHANNELS =================

  async createChannel(input: CreateChannelDto) {
    // Check actor has permission to manage channels in this workspace
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: input.workspaceId, userId: input.actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes('MANAGE_WORKSPACE') || r.permissions.includes('MANAGE_CHANNELS')
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNELS permission');

    const masterSecret = crypto.randomBytes(32).toString('base64');
    const isPrivate = input.visibility === 'private';

    // For private channels, only Admin and Moderator roles can access by default
    let allowedRoles: string[] = [];
    if (isPrivate) {
      const adminAndMod = await this.roleRepo.find({
        where: { workspaceId: input.workspaceId, name: In(['Administrateur', 'Modérateur']) },
      });
      allowedRoles = adminAndMod.map((r) => r.id);
    }

    const channel = this.channelRepo.create({
      workspaceId: input.workspaceId,
      name: input.name,
      isPrivate,
      allowedRoles,
      masterSecret,
      keyVersion: 1,
    });
    const savedChannel = await this.channelRepo.save(channel);

    await this.pushKeyToUser(savedChannel, input.actorUserId);

    return {
      id: savedChannel.id,
      workspaceId: savedChannel.workspaceId,
      name: savedChannel.name,
      visibility: savedChannel.isPrivate ? 'private' : 'public',
      imageMediaId: savedChannel.imageMediaId ?? null,
      keyVersion: savedChannel.keyVersion,
      keyBootstrap: this.buildChannelBootstrap(savedChannel),
    };
  }

  async updateChannelImage(channelId: string, actorUserId: string, mediaId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mediaId)) {
      throw new ForbiddenException('Invalid mediaId format');
    }

    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes('MANAGE_WORKSPACE') || r.permissions.includes('MANAGE_CHANNELS')
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNELS permission');

    channel.imageMediaId = mediaId;
    await this.channelRepo.save(channel);

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.updated',
      { channelId, imageMediaId: mediaId, workspaceId: channel.workspaceId },
      workspaceMemberIds
    );

    return { success: true, channelId, imageMediaId: mediaId };
  }

  async updateWorkspaceImage(workspaceId: string, actorUserId: string, mediaId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mediaId)) {
      throw new ForbiddenException('Invalid mediaId format');
    }

    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some((r) => r.permissions.includes('MANAGE_WORKSPACE'));
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');

    workspace.imageMediaId = mediaId;
    await this.workspaceRepo.save(workspace);

    const workspaceMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    await this.redis.publishChannelEvent(
      'workspace.updated',
      { workspaceId, imageMediaId: mediaId },
      workspaceMemberIds
    );

    return { success: true, workspaceId, imageMediaId: mediaId };
  }

  async leaveWorkspace(workspaceId: string, userId: string) {
    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new NotFoundException('Not a member of this workspace');

    await this.memberRepo.delete({ workspaceId, userId });

    const remainingMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    await this.redis.publishChannelEvent(
      'channel.member.kicked',
      { workspaceId, kickedUserId: userId, kickedBy: userId },
      [...remainingMemberIds, userId]
    );

    return { success: true };
  }

  async renameChannel(channelId: string, actorUserId: string, newName: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes('MANAGE_WORKSPACE') || r.permissions.includes('MANAGE_CHANNELS')
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNELS permission');

    channel.name = newName.trim().toLowerCase();
    await this.channelRepo.save(channel);

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.updated',
      { channelId, name: channel.name, workspaceId: channel.workspaceId },
      workspaceMemberIds
    );

    return { success: true, channelId, name: channel.name };
  }

  async archiveChannel(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes('MANAGE_WORKSPACE') || r.permissions.includes('MANAGE_CHANNELS')
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNELS permission');

    channel.archived = true;
    await this.channelRepo.save(channel);

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.deleted',
      { channelId, workspaceId: channel.workspaceId },
      workspaceMemberIds
    );

    return { success: true };
  }

  /**
   * Rotate the channel key: increment keyVersion, derive a new epoch key,
   * and broadcast to all workspace members.
   */
  async rotateChannelKey(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes('MANAGE_WORKSPACE') || r.permissions.includes('MANAGE_CHANNELS')
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNELS permission');

    // Backfill master secret if missing
    if (!channel.masterSecret) {
      channel.masterSecret = crypto.randomBytes(32).toString('base64');
    }

    channel.keyVersion += 1;
    await this.channelRepo.save(channel);

    const epochKey = this.deriveEpochKey(channel.masterSecret, channelId, channel.keyVersion);

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.key.rotated',
      {
        channelId,
        newEpochBaseKey: epochKey.toString('base64'),
        keyVersion: channel.keyVersion,
      },
      workspaceMemberIds
    );

    return { channelId, keyVersion: channel.keyVersion };
  }

  /**
   * Push `channel.key.rotated` for a specific user (e.g. on join).
   */
  private async pushKeyToUser(channel: Channel, userId: string) {
    if (!channel.masterSecret) {
      channel.masterSecret = crypto.randomBytes(32).toString('base64');
      await this.channelRepo.save(channel);
    }

    const epochKey = this.deriveEpochKey(channel.masterSecret, channel.id, channel.keyVersion);
    await this.redis.publishChannelEvent(
      'channel.key.rotated',
      {
        channelId: channel.id,
        newEpochBaseKey: epochKey.toString('base64'),
        keyVersion: channel.keyVersion,
      },
      [userId]
    );
  }

  private toDistributionPayload(
    distribution: ChannelKeyDistribution,
    channel: Channel,
    channelName: string,
    epochKeyB64: string,
    epochKeys?: Array<{ keyVersion: number; encryptedChannelKey: string }>
  ): ChannelKeyDistributionPayloadDto {
    return {
      type: 'channel_key_distribution',
      channelId: channel.id,
      channelName,
      keyVersion: distribution.keyVersion,
      encryptedChannelKey: epochKeyB64,
      epochKeys,
      distributionId: distribution.id,
      issuedAt: distribution.createdAt.toISOString(),
      invitedBy: distribution.invitedBy,
    };
  }

  private async updateDistributionStatus(
    distributionId: string,
    status: ChannelKeyDistributionStatus,
    actorUserId?: string
  ) {
    const distribution = await this.keyDistributionRepo.findOne({ where: { id: distributionId } });
    if (!distribution) throw new NotFoundException('Channel key distribution not found');

    if (actorUserId && distribution.targetUserId !== actorUserId) {
      throw new ForbiddenException('Only target user can update this distribution');
    }

    const isValidTransition =
      (distribution.status === 'pending_key_distribution' && status === 'key_sent') ||
      (distribution.status === 'key_sent' &&
        (status === 'key_received' || status === 'key_acked')) ||
      (distribution.status === 'key_received' && status === 'key_acked') ||
      distribution.status === status;
    if (!isValidTransition) {
      throw new BadRequestException(
        `Invalid distribution status transition ${distribution.status} -> ${status}`
      );
    }

    distribution.status = status;
    if (status === 'key_sent') {
      distribution.sentAt = new Date();
      distribution.attempts += 1;
    }
    if (status === 'key_received') {
      distribution.receivedAt = new Date();
    }
    if (status === 'key_acked') {
      distribution.ackedAt = new Date();
      if (!distribution.receivedAt) distribution.receivedAt = distribution.ackedAt;
    }
    await this.keyDistributionRepo.save(distribution);
    return distribution;
  }

  async listChannelsForUser(workspaceId: string, userId: string) {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const channels = await this.channelRepo.find({ where: { workspaceId, archived: false } });
    return channels
      .filter((ch) => this.canAccessChannel(ch, member))
      .map((channel) => ({
        id: channel.id,
        workspaceId: channel.workspaceId,
        name: channel.name,
        visibility: channel.isPrivate ? 'private' : 'public',
        imageMediaId: channel.imageMediaId ?? null,
        keyVersion: channel.keyVersion,
        keyBootstrap: this.buildChannelBootstrap(channel),
      }));
  }

  async getChannelKeyBootstrapForUser(channelId: string, userId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    if (!this.canAccessChannel(channel, member)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    return this.buildChannelBootstrap(channel);
  }

  async getChannelHistoryKeysForUser(
    channelId: string,
    userId: string
  ): Promise<ChannelHistoryKeysDto> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    if (!this.canAccessChannel(channel, member)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    if (!channel.masterSecret) {
      channel.masterSecret = crypto.randomBytes(32).toString('base64');
      await this.channelRepo.save(channel);
    }

    const epochKeys = Array.from({ length: channel.keyVersion }, (_, index) => {
      const version = index + 1;
      const key = this.deriveEpochKey(channel.masterSecret, channel.id, version);
      return {
        keyVersion: version,
        encryptedChannelKey: key.toString('base64'),
      };
    });

    return {
      channelId: channel.id,
      latestKeyVersion: channel.keyVersion,
      epochKeys,
    };
  }

  async joinChannel(channelId: string, input: ChannelJoinDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const workspace = await this.workspaceRepo.findOne({ where: { id: channel.workspaceId } });

    let member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.userId },
    });
    const isNewMember = !member;

    if (!member) {
      const defaultRole = await this.roleRepo.findOne({
        where: { workspaceId: channel.workspaceId, name: 'Member' },
      });
      member = this.memberRepo.create({
        workspaceId: channel.workspaceId,
        userId: input.userId,
        roleIds: defaultRole ? [defaultRole.id] : [],
      });
      await this.memberRepo.save(member);
    }

    // Publish event to notify connected clients
    if (isNewMember) {
      const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
      await this.redis.publishChannelEvent(
        'channel.member.joined',
        {
          channelId,
          channelName: channel.name,
          workspaceId: channel.workspaceId,
          workspaceSlug: workspace?.slug,
          workspaceName: workspace?.name,
          visibility: channel.isPrivate ? 'private' : 'public',
          roleName: input.roleName || 'Member',
          joinedBy: input.userId,
        },
        workspaceMemberIds
      );
    }

    return { success: true };
  }

  async inviteToChannel(channelId: string, input: ChannelInviteDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const workspace = await this.workspaceRepo.findOne({ where: { id: channel.workspaceId } });

    // Check if actor has permission to invite
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes('INVITE_USERS') ||
          r.permissions.includes('MANAGE_WORKSPACE') ||
          r.permissions.includes('MANAGE_CHANNELS')
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing INVITE_USERS permission');

    // Add target user as member if not already
    let targetMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.targetUserId },
    });

    const isNewMember = !targetMember;

    if (!targetMember) {
      // Find the role to assign (default to Member if not specified)
      const roleName = this.mapRoleInputToWorkspaceRoleName(input.roleName || 'Membre');
      const role = await this.roleRepo.findOne({
        where: { workspaceId: channel.workspaceId, name: roleName },
      });
      const roleIds = role ? [role.id] : [];

      targetMember = this.memberRepo.create({
        workspaceId: channel.workspaceId,
        userId: input.targetUserId,
        roleIds,
      });
      await this.memberRepo.save(targetMember);
    }

    // Publish event to notify the invited user and connected clients
    if (isNewMember) {
      const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
      await this.redis.publishChannelEvent(
        'channel.member.joined',
        {
          channelId,
          channelName: channel.name,
          workspaceId: channel.workspaceId,
          workspaceSlug: workspace?.slug,
          workspaceName: workspace?.name,
          visibility: channel.isPrivate ? 'private' : 'public',
          roleName: this.mapRoleInputToWorkspaceRoleName(input.roleName || 'Membre'),
          joinedBy: input.targetUserId,
          invitedBy: input.actorUserId,
        },
        workspaceMemberIds
      );

      // Membership change => mandatory channel key rotation.
      if (!channel.masterSecret) {
        channel.masterSecret = crypto.randomBytes(32).toString('base64');
      }
      channel.keyVersion += 1;
      await this.channelRepo.save(channel);
    }

    // Existing members can be re-invited to resync historical keys.
    if (!channel.masterSecret) {
      channel.masterSecret = crypto.randomBytes(32).toString('base64');
      await this.channelRepo.save(channel);
    }

    const epochKey = this.deriveEpochKey(channel.masterSecret, channel.id, channel.keyVersion);
    const epochKeys = Array.from({ length: channel.keyVersion }, (_, index) => {
      const version = index + 1;
      const key = this.deriveEpochKey(channel.masterSecret, channel.id, version);
      return {
        keyVersion: version,
        encryptedChannelKey: key.toString('base64'),
      };
    });

    const distribution = this.keyDistributionRepo.create({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      targetUserId: input.targetUserId,
      invitedBy: input.actorUserId,
      keyVersion: channel.keyVersion,
      status: 'pending_key_distribution',
    });
    const savedDistribution = await this.keyDistributionRepo.save(distribution);

    const payload = this.toDistributionPayload(
      savedDistribution,
      channel,
      channel.name,
      epochKey.toString('base64'),
      epochKeys
    );

    return {
      success: true,
      userId: input.targetUserId,
      alreadyMember: !isNewMember,
      keyDistribution: payload,
    };
  }

  async leaveChannel(channelId: string, input: ChannelLeaveDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.userId },
    });
    if (!member) throw new NotFoundException('Member not found');

    if (channel.isPrivate) {
      const remainingRoles = member.roleIds.filter((r) => !channel.allowedRoles?.includes(r));
      member.roleIds = remainingRoles;
      await this.memberRepo.save(member);
    } else {
      await this.memberRepo.delete({ workspaceId: channel.workspaceId, userId: input.userId });
    }

    // Membership change => rotate key and distribute only to remaining members.
    if (!channel.masterSecret) {
      channel.masterSecret = crypto.randomBytes(32).toString('base64');
    }
    channel.keyVersion += 1;
    await this.channelRepo.save(channel);

    const newEpochKey = this.deriveEpochKey(channel.masterSecret, channel.id, channel.keyVersion);
    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.key.rotated',
      {
        channelId,
        newEpochBaseKey: newEpochKey.toString('base64'),
        keyVersion: channel.keyVersion,
      },
      workspaceMemberIds
    );

    return { success: true };
  }

  async markKeyDistributionSent(channelId: string, distributionId: string, actorUserId: string) {
    const distribution = await this.keyDistributionRepo.findOne({ where: { id: distributionId } });
    if (!distribution || distribution.channelId !== channelId) {
      throw new NotFoundException('Channel key distribution not found');
    }
    if (distribution.invitedBy !== actorUserId) {
      throw new ForbiddenException('Only inviter can mark distribution as sent');
    }
    await this.updateDistributionStatus(distributionId, 'key_sent');
    return { success: true, distributionId, status: 'key_sent' };
  }

  async markKeyDistributionReceived(
    channelId: string,
    distributionId: string,
    actorUserId: string,
    keyVersion: number
  ) {
    const distribution = await this.keyDistributionRepo.findOne({ where: { id: distributionId } });
    if (!distribution || distribution.channelId !== channelId) {
      throw new NotFoundException('Channel key distribution not found');
    }
    if (distribution.keyVersion !== keyVersion) {
      throw new ForbiddenException('Distribution keyVersion mismatch');
    }
    const member = await this.memberRepo.findOne({
      where: { workspaceId: distribution.workspaceId, userId: actorUserId },
    });
    const channel = await this.channelRepo.findOne({ where: { id: distribution.channelId } });
    if (!member || !channel || !this.canAccessChannel(channel, member)) {
      throw new ForbiddenException('Target user no longer authorized for this channel');
    }
    await this.updateDistributionStatus(distributionId, 'key_received', actorUserId);
    return { success: true, distributionId, status: 'key_received' };
  }

  async ackKeyDistribution(
    channelId: string,
    distributionId: string,
    actorUserId: string,
    keyVersion: number
  ) {
    const distribution = await this.keyDistributionRepo.findOne({ where: { id: distributionId } });
    if (!distribution || distribution.channelId !== channelId) {
      throw new NotFoundException('Channel key distribution not found');
    }
    if (distribution.keyVersion !== keyVersion) {
      throw new ForbiddenException('Distribution keyVersion mismatch');
    }
    const member = await this.memberRepo.findOne({
      where: { workspaceId: distribution.workspaceId, userId: actorUserId },
    });
    const channel = await this.channelRepo.findOne({ where: { id: distribution.channelId } });
    if (!member || !channel || !this.canAccessChannel(channel, member)) {
      throw new ForbiddenException('Target user no longer authorized for this channel');
    }
    await this.updateDistributionStatus(distributionId, 'key_acked', actorUserId);
    return { success: true, distributionId, status: 'key_acked' };
  }

  async kickMember(channelId: string, input: ChannelKickDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const adminMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.actorUserId },
    });
    if (!adminMember) throw new ForbiddenException('Not an admin');

    let hasPerm = false;
    if (adminMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(adminMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes('MANAGE_WORKSPACE') || r.permissions.includes('MANAGE_CHANNELS')
      );
    }

    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNELS permission');

    await this.memberRepo.delete({ workspaceId: channel.workspaceId, userId: input.targetUserId });

    // Publish event to notify the kicked user and connected clients
    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    // Also include the kicked user so they're notified
    const notifyIds = [...new Set([...workspaceMemberIds, input.targetUserId])];
    await this.redis.publishChannelEvent(
      'channel.member.kicked',
      {
        channelId,
        channelName: channel.name,
        workspaceId: channel.workspaceId,
        kickedUserId: input.targetUserId,
        kickedBy: input.actorUserId,
      },
      notifyIds
    );

    // Rotate key so the kicked user's in-memory epoch keys are no longer valid
    // for future messages. Backfill master secret if needed.
    if (!channel.masterSecret) {
      channel.masterSecret = crypto.randomBytes(32).toString('base64');
    }
    channel.keyVersion += 1;
    await this.channelRepo.save(channel);

    const newEpochKey = this.deriveEpochKey(channel.masterSecret, channel.id, channel.keyVersion);
    // Only notify remaining members (not the kicked user) of the new key
    await this.redis.publishChannelEvent(
      'channel.key.rotated',
      {
        channelId,
        newEpochBaseKey: newEpochKey.toString('base64'),
        keyVersion: channel.keyVersion,
      },
      workspaceMemberIds
    );

    return { success: true };
  }

  async updateMemberRole(channelId: string, input: ChannelUpdateRoleDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const adminMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.actorUserId },
    });
    if (!adminMember) throw new ForbiddenException('Not an admin');

    let hasPerm = false;
    if (adminMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(adminMember.roleIds) } });
      hasPerm = roles.some(
        (r) => r.permissions.includes('MANAGE_WORKSPACE') || r.permissions.includes('MANAGE_ROLES')
      );
    }

    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_ROLES permission');

    const targetMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.targetUserId },
    });
    if (!targetMember) throw new NotFoundException('Target member not found');

    const role = await this.roleRepo.findOne({
      where: {
        workspaceId: channel.workspaceId,
        name: this.mapRoleInputToWorkspaceRoleName(input.roleName),
      },
    });
    if (!role) throw new NotFoundException('Role not found');
    const roleIds = [...new Set([...(targetMember.roleIds || []), role.id])];

    targetMember.roleIds = roleIds;

    await this.memberRepo.save(targetMember);
    return { success: true };
  }

  // ================= CHANNEL MEMBERS =================

  async listChannelMembers(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    const roles = await this.roleRepo.find({ where: { workspaceId: channel.workspaceId } });
    const roleMap = new Map(roles.map((r) => [r.id, r]));

    return members.map((m) => {
      const memberRoles = (m.roleIds || []).map((rid) => roleMap.get(rid)).filter(Boolean);
      const highestRole = memberRoles.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
      return {
        id: m.id,
        userId: m.userId,
        role: this.normalizeRoleLabelToCanonical(highestRole?.name),
        joinedAt: m.createdAt,
      };
    });
  }

  // ================= MESSAGES =================

  async sendMessage(channelId: string, input: SendChannelMessageDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.senderId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    if (!this.canAccessChannel(channel, member)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }
    if (input.keyVersion === undefined || input.keyVersion === null) {
      throw new BadRequestException('keyVersion is required for channel messages');
    }
    if (input.keyVersion !== channel.keyVersion) {
      throw new ForbiddenException(
        `Stale or invalid keyVersion (${input.keyVersion}) for channel epoch ${channel.keyVersion}`
      );
    }

    const msg = this.messageRepo.create({
      // Never use a client-supplied ID as the DB primary key — the server
      // always generates a fresh UUID to prevent IDOR / row-overwrite attacks.
      workspaceId: channel.workspaceId,
      channelId,
      authorId: input.senderId,
      content: input.ciphertext,
      nonce: input.nonce,
      keyVersion: input.keyVersion ?? null,
    });

    const savedMsg = await this.messageRepo.save(msg);

    // Publish event fire-and-forget — do not block the HTTP response
    this.getWorkspaceMemberIds(channel.workspaceId)
      .then((workspaceMemberIds) =>
        this.redis.publishChannelEvent(
          'channel.message.created',
          {
            channelId,
            messageId: savedMsg.id,
            senderId: input.senderId,
            ciphertext: input.ciphertext,
            nonce: input.nonce,
            keyVersion: input.keyVersion,
            createdAt: savedMsg.createdAt,
          },
          workspaceMemberIds
        )
      )
      .catch((err) => this.logger.error(`Failed to publish channel message event: ${err}`));

    return savedMsg;
  }

  async listMessages(channelId: string, userId: string, limit = 50) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const safeLimit = Math.min(Math.max(1, limit), 200);

    const msgs = await this.messageRepo.find({
      where: { channelId },
      order: { createdAt: 'DESC' },
      take: safeLimit,
    });
    return msgs.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      senderId: m.authorId,
      ciphertext: m.content,
      nonce: m.nonce ?? null,
      keyVersion: m.keyVersion ?? null,
      replyTo: m.replyTo ?? null,
      createdAt: m.createdAt,
    }));
  }
}
