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

/** Manages workspaces, channels, roles, members, key distribution, and encrypted messages. */
@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);
  private readonly deliveryUrl =
    process.env.DELIVERY_INTERNAL_URL ?? 'http://chat-delivery-service:3010';
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  /** Normalises a French or English role label to one of three canonical values: admin, moderator, or member. */
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

  /** Maps any role name input to the canonical display name stored in the workspace roles table. */
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

  /** Returns true if the user can access a private channel.
   * When allowedUsers is set, the check is user-based only (role fallthrough is not allowed
   * because it would bypass the allowlist when userId is absent). Public channels always return true. */
  private canAccessChannel(channel: Channel, member: ChannelMember, userId?: string): boolean {
    if (!channel.isPrivate) return true;
    const allowedUsers = channel.allowedUsers || [];
    if (allowedUsers.length > 0) {
      return !!userId && allowedUsers.includes(userId.trim().toLowerCase());
    }
    const roleIds = member.roleIds || [];
    const allowed = channel.allowedRoles || [];
    if (allowed.length === 0) return true;
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

  /** Builds the bootstrap payload (channelId, keyVersion, base64 epoch key) sent to a client on join or key refresh. */
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

  /** Creates a workspace with default Administrateur/Modérateur/Membre roles, adds the creator as admin, and creates a public #general channel. */
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

  /** Loads a workspace by its URL slug together with its channels, members, and roles. */
  async getWorkspaceBySlug(slug: string) {
    const ws = await this.workspaceRepo.findOne({ where: { slug } });
    if (!ws) throw new NotFoundException('Workspace not found');

    const channels = await this.channelRepo.find({ where: { workspaceId: ws.id } });
    const members = await this.memberRepo.find({ where: { workspaceId: ws.id } });
    const roles = await this.roleRepo.find({ where: { workspaceId: ws.id } });

    return { workspace: ws, channels, members, roles };
  }

  /** Returns all workspaces the user belongs to (derived from their ChannelMember records). */
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

  /** Creates a new workspace role. Only members with MANAGE_WORKSPACE or MANAGE_ROLES permission may call this. */
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

  /** Creates a channel inside a workspace. Private channels restrict access to Admin and Moderator roles by default. */
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

    const channelName = (input.name ?? '').trim().toLowerCase();
    if (!channelName) throw new BadRequestException('Channel name cannot be empty');
    if (channelName.length > 80)
      throw new BadRequestException('Channel name too long (max 80 characters)');

    const masterSecret = crypto.randomBytes(32).toString('base64');
    const isPrivate = input.visibility === 'private';

    const channel = this.channelRepo.create({
      workspaceId: input.workspaceId,
      name: channelName,
      isPrivate,
      allowedRoles: [],
      allowedUsers: isPrivate ? [input.actorUserId.trim().toLowerCase()] : [],
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

  /** Updates the channel's cover image and broadcasts a channel.updated event to all workspace members. */
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

  /** Updates the workspace's cover image and broadcasts a workspace.updated event to all members. */
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

  /** Removes the user from the workspace and broadcasts a member-kicked event so other clients clean up their UI. */
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

  /** Renames a channel (lowercased) and broadcasts a channel.updated event so connected clients update their sidebar. */
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

    const trimmedName = newName.trim().toLowerCase();
    if (!trimmedName) throw new BadRequestException('Channel name cannot be empty');
    if (trimmedName.length > 80)
      throw new BadRequestException('Channel name too long (max 80 characters)');

    channel.name = trimmedName;
    await this.channelRepo.save(channel);

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.updated',
      { channelId, name: channel.name, workspaceId: channel.workspaceId },
      workspaceMemberIds
    );

    return { success: true, channelId, name: channel.name };
  }

  /** Returns the channel's current access settings plus the workspace's available roles. */
  async getChannelAccess(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    return {
      channelId,
      isPrivate: channel.isPrivate,
      allowedUsers: channel.allowedUsers || [],
    };
  }

  /** Updates the channel's visibility and allowed-user list. Requires MANAGE_CHANNELS permission. */
  async updateChannelAccess(
    channelId: string,
    actorUserId: string,
    isPrivate: boolean,
    allowedUserIds: string[]
  ) {
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

    channel.isPrivate = isPrivate;
    channel.allowedUsers = isPrivate ? allowedUserIds.map((u) => u.trim().toLowerCase()) : [];
    await this.channelRepo.save(channel);

    return {
      ok: true,
      channelId,
      isPrivate: channel.isPrivate,
      allowedUsers: channel.allowedUsers,
    };
  }

  /** Marks a channel as archived (hidden from listings) and broadcasts a channel.deleted event to workspace members. */
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

  /** Constructs the ChannelKeyDistributionPayloadDto sent to the invited user so they can decrypt historical messages. */
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

  /** Advances a key-distribution record through its lifecycle (pending → sent → received → acked). Enforces valid state transitions. Accepts either an already-loaded entity or its UUID to avoid redundant DB round-trips. */
  private async updateDistributionStatus(
    distributionOrId: ChannelKeyDistribution | string,
    status: ChannelKeyDistributionStatus,
    actorUserId?: string
  ) {
    const distribution =
      typeof distributionOrId === 'string'
        ? await this.keyDistributionRepo.findOne({ where: { id: distributionOrId } })
        : distributionOrId;
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

  /** Lists all non-archived channels the user can access in a workspace, including the current epoch key bootstrap for each. */
  async listChannelsForUser(workspaceId: string, userId: string) {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const channels = await this.channelRepo.find({ where: { workspaceId, archived: false } });
    return channels
      .filter((ch) => this.canAccessChannel(ch, member, userId))
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

  /** Returns the current epoch key bootstrap for a single channel, used when reconnecting after a missed key rotation. */
  async getChannelKeyBootstrapForUser(channelId: string, userId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    if (!this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    return this.buildChannelBootstrap(channel);
  }

  /** Returns all epoch keys (versions 1…N) for a channel, allowing a new member to decrypt historical messages. */
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
    if (!this.canAccessChannel(channel, member, userId)) {
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

  /** Adds a user to a workspace channel. Creates the workspace membership with the default Member role if this is their first channel in the workspace. */
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

  /**
   * Returns false when the user has no active MLS device registered in chat-delivery.
   * Fails open (returns true) on network error so a misconfigured secret never blocks invitations.
   */
  private async userHasMlsDevices(userId: string): Promise<boolean> {
    if (!this.internalSecret) return true;
    try {
      const res = await fetch(`${this.deliveryUrl}/mls/devices/${encodeURIComponent(userId)}`, {
        headers: { 'X-Internal-Secret': this.internalSecret },
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) return true;
      const devices: unknown[] = await res.json();
      return devices.length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Validates an active key-distribution record for the given target user and returns the loaded
   * entities. Shared by markKeyDistributionReceived and ackKeyDistribution to avoid duplication.
   */
  private async resolveDistributionForTarget(
    channelId: string,
    distributionId: string,
    actorUserId: string,
    keyVersion: number
  ): Promise<{ distribution: ChannelKeyDistribution; member: ChannelMember; channel: Channel }> {
    const distribution = await this.keyDistributionRepo.findOne({ where: { id: distributionId } });
    if (!distribution || distribution.channelId !== channelId) {
      throw new NotFoundException('Channel key distribution not found');
    }
    if (distribution.keyVersion !== keyVersion) {
      throw new ForbiddenException('Distribution keyVersion mismatch');
    }
    const [member, channel] = await Promise.all([
      this.memberRepo.findOne({
        where: { workspaceId: distribution.workspaceId, userId: actorUserId },
      }),
      this.channelRepo.findOne({ where: { id: distribution.channelId } }),
    ]);
    if (!member || !channel || !this.canAccessChannel(channel, member, actorUserId)) {
      throw new ForbiddenException('Target user no longer authorized for this channel');
    }
    return { distribution, member, channel };
  }

  /** Invites a user to a channel. Rotates the channel key if it's a new member, then returns a full key-distribution payload so the invitee can decrypt all past messages. */
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

    // Reject early if the invitee has no MLS device - the key DM could never be delivered.
    const hasDevices = await this.userHasMlsDevices(input.targetUserId);
    if (!hasDevices) {
      throw new BadRequestException(
        `L'utilisateur ${input.targetUserId} n'a pas encore configuré Canari sur un appareil.`
      );
    }

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

      // For private channels with user-based access, add the new member to allowedUsers.
      if (channel.isPrivate) {
        const existing = channel.allowedUsers || [];
        const normalized = input.targetUserId.trim().toLowerCase();
        if (!existing.includes(normalized)) {
          channel.allowedUsers = [...existing, normalized];
        }
      }

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

    // Upsert: reuse any in-flight distribution for same channel/user/version to prevent
    // duplicates when two admins invite simultaneously or the inviter retries.
    const existingDist = await this.keyDistributionRepo.findOne({
      where: {
        channelId: channel.id,
        targetUserId: input.targetUserId,
        keyVersion: channel.keyVersion,
        status: In(['pending_key_distribution', 'key_sent']),
      },
      order: { createdAt: 'DESC' },
    });
    const savedDistribution = await this.keyDistributionRepo.save(
      existingDist
        ? {
            ...existingDist,
            invitedBy: input.actorUserId,
            status: 'pending_key_distribution' as const,
          }
        : this.keyDistributionRepo.create({
            workspaceId: channel.workspaceId,
            channelId: channel.id,
            targetUserId: input.targetUserId,
            invitedBy: input.actorUserId,
            keyVersion: channel.keyVersion,
            status: 'pending_key_distribution',
          })
    );

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

  /** Removes a user from a channel (or strips their private-channel roles) and rotates the key so the departing user's copy is invalidated. */
  async leaveChannel(channelId: string, input: ChannelLeaveDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.userId },
    });
    if (!member) throw new NotFoundException('Member not found');

    // Rotate the key BEFORE removing the member so there is no window where the member
    // is absent but the key hasn't been rotated - which would let them decrypt messages
    // sent with the still-valid old key during that gap.
    if (!channel.masterSecret) {
      channel.masterSecret = crypto.randomBytes(32).toString('base64');
    }
    channel.keyVersion += 1;

    if (channel.isPrivate) {
      const normalized = input.userId.trim().toLowerCase();
      channel.allowedUsers = (channel.allowedUsers || []).filter((u) => u !== normalized);
    } else {
      await this.memberRepo.delete({ workspaceId: channel.workspaceId, userId: input.userId });
    }
    // Single save: atomically persists both the key rotation and the membership change.
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

  /** Called by the inviter once they have transmitted the encrypted key to the target device. Advances status → key_sent. */
  async markKeyDistributionSent(channelId: string, distributionId: string, actorUserId: string) {
    const distribution = await this.keyDistributionRepo.findOne({ where: { id: distributionId } });
    if (!distribution || distribution.channelId !== channelId) {
      throw new NotFoundException('Channel key distribution not found');
    }
    if (distribution.invitedBy !== actorUserId) {
      throw new ForbiddenException('Only inviter can mark distribution as sent');
    }
    await this.updateDistributionStatus(distribution, 'key_sent');
    return { success: true, distributionId, status: 'key_sent' };
  }

  /** Called by the target user once they have received (but not yet decrypted) the key package. Advances status → key_received. */
  async markKeyDistributionReceived(
    channelId: string,
    distributionId: string,
    actorUserId: string,
    keyVersion: number
  ) {
    const { distribution } = await this.resolveDistributionForTarget(
      channelId,
      distributionId,
      actorUserId,
      keyVersion
    );
    await this.updateDistributionStatus(distribution, 'key_received', actorUserId);
    return { success: true, distributionId, status: 'key_received' };
  }

  /** Called by the target user once they have successfully decrypted and stored the key. Advances status → key_acked. */
  async ackKeyDistribution(
    channelId: string,
    distributionId: string,
    actorUserId: string,
    keyVersion: number
  ) {
    const { distribution } = await this.resolveDistributionForTarget(
      channelId,
      distributionId,
      actorUserId,
      keyVersion
    );
    await this.updateDistributionStatus(distribution, 'key_acked', actorUserId);
    return { success: true, distributionId, status: 'key_acked' };
  }

  /** Removes a member from the workspace, broadcasts a kicked event, then rotates the channel key so the removed user can no longer decrypt new messages. */
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

    if (channel.isPrivate) {
      const normalized = input.targetUserId.trim().toLowerCase();
      channel.allowedUsers = (channel.allowedUsers || []).filter((u) => u !== normalized);
      await this.channelRepo.save(channel);
    }

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

  /** Adds a new role to a workspace member's roleIds (does not remove existing roles). Requires MANAGE_WORKSPACE or MANAGE_ROLES permission. */
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

  /** Returns all members of the workspace that owns the channel, each with their highest-priority role normalized to admin/moderator/member. */
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

  /** Persists a client-encrypted message after validating keyVersion against the current channel epoch, then publishes the ciphertext to all workspace members via Redis. */
  async sendMessage(channelId: string, input: SendChannelMessageDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.senderId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    if (!this.canAccessChannel(channel, member, input.senderId)) {
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
      // Never use a client-supplied ID as the DB primary key - the server
      // always generates a fresh UUID to prevent IDOR / row-overwrite attacks.
      workspaceId: channel.workspaceId,
      channelId,
      authorId: input.senderId,
      content: input.ciphertext,
      nonce: input.nonce,
      keyVersion: input.keyVersion ?? null,
    });

    const savedMsg = await this.messageRepo.save(msg);

    // Publish event fire-and-forget - do not block the HTTP response
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

  /** Returns up to 200 messages from a channel in reverse chronological order (newest first). Access-controlled by canAccessChannel. */
  async listMessages(channelId: string, userId: string, limit = 50) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
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
