import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';

import {
  CreateChannelDto,
  CreateRoleDto,
  CreateWorkspaceDto,
  ChannelJoinDto,
  ChannelLeaveDto,
  ChannelKickDto,
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
    @InjectRepository(ChannelMessage) private readonly messageRepo: Repository<ChannelMessage>
  ) {}

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

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.userId },
    });
    if (!member) {
      const defaultRole = await this.roleRepo.findOne({
        where: { workspaceId: channel.workspaceId, name: 'Member' },
      });
      const newMember = this.memberRepo.create({
        workspaceId: channel.workspaceId,
        userId: input.userId,
        roleIds: defaultRole ? [defaultRole.id] : [],
      });
      await this.memberRepo.save(newMember);
    }
    return { success: true };
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
      replyTo: input.nonce,
      metadata: { keyVersion: input.keyVersion },
    });

    const savedMsg = await this.messageRepo.save(msg);
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
    return msgs;
  }
}
