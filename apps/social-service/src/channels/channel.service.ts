import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
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
} from './dto/channel.dto';

@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  constructor(
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(Channel) private readonly channelRepo: Repository<Channel>,
    @InjectRepository(ChannelRole) private readonly roleRepo: Repository<ChannelRole>,
    @InjectRepository(ChannelMember) private readonly memberRepo: Repository<ChannelMember>,
    @InjectRepository(ChannelMessage) private readonly messageRepo: Repository<ChannelMessage>,
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
      name: 'Admin',
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

    const memberRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Member',
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
    });
    await this.channelRepo.save(generalChannel);

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

  async createRole(input: CreateRoleDto) {
    const role = this.roleRepo.create({
      workspaceId: input.workspaceId,
      name: input.name,
      permissions: input.permissions,
    });
    return this.roleRepo.save(role);
  }

  // ================= CHANNELS =================

  async createChannel(input: CreateChannelDto) {
    const channel = this.channelRepo.create({
      workspaceId: input.workspaceId,
      name: input.name,
      isPrivate: input.visibility === 'private',
      allowedRoles: [],
    });
    return this.channelRepo.save(channel);
  }

  async listChannelsForUser(workspaceId: string, userId: string) {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const channels = await this.channelRepo.find({ where: { workspaceId } });
    return channels.filter((ch) => {
      if (!ch.isPrivate) return true;
      return ch.allowedRoles?.some((rId) => member.roleIds?.includes(rId));
    });
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
      const roleName = input.roleName || 'Member';
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
          roleName: input.roleName || 'Member',
          joinedBy: input.targetUserId,
          invitedBy: input.actorUserId,
        },
        workspaceMemberIds
      );
    }

    return { success: true, userId: input.targetUserId };
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

    return { success: true };
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
      where: { workspaceId: channel.workspaceId, name: input.roleName },
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
      const memberRoles = (m.roleIds || [])
        .map((rid) => roleMap.get(rid))
        .filter(Boolean);
      const highestRole = memberRoles.sort((a, b) => (b!.priority ?? 0) - (a!.priority ?? 0))[0];
      return {
        id: m.id,
        userId: m.userId,
        role: highestRole?.name?.toLowerCase() ?? 'member',
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

    const msg = this.messageRepo.create({
      workspaceId: channel.workspaceId,
      channelId,
      authorId: input.senderId,
      content: input.ciphertext,
      nonce: input.nonce,
      keyVersion: input.keyVersion ?? null,
    });

    const savedMsg = await this.messageRepo.save(msg);

    // Publish event to notify all connected channel members in real-time
    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
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
    );

    return savedMsg;
  }

  async listMessages(channelId: string, userId: string, limit = 50) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const msgs = await this.messageRepo.find({
      where: { channelId },
      order: { createdAt: 'DESC' },
      take: limit,
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
