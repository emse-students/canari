import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CHANNEL_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  DEFAULT_MODERATOR_PERMISSIONS,
  DEFAULT_OWNER_PERMISSIONS,
  type ChannelPermission,
} from './permissions';
import { Workspace } from './schemas/workspace.schema';
import { ChannelRole } from './schemas/channel-role.schema';
import { Channel } from './schemas/channel.schema';
import { ChannelMember } from './schemas/channel-member.schema';
import { ChannelMessage } from './schemas/channel-message.schema';
import {
  type ChannelJoinDto,
  type ChannelKickDto,
  type ChannelLeaveDto,
  type ChannelUpdateRoleDto,
  type CreateChannelDto,
  type CreateRoleDto,
  type CreateWorkspaceDto,
  type SendChannelMessageDto,
} from './dto/channel.dto';
import Redis from 'ioredis';

@Injectable()
export class ChannelService {
  private readonly redis: Redis;

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(ChannelRole.name)
    private readonly roleModel: Model<ChannelRole>,
    @InjectModel(Channel.name)
    private readonly channelModel: Model<Channel>,
    @InjectModel(ChannelMember.name)
    private readonly memberModel: Model<ChannelMember>,
    @InjectModel(ChannelMessage.name)
    private readonly messageModel: Model<ChannelMessage>
  ) {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }

  async createWorkspace(input: CreateWorkspaceDto) {
    const slug = input.slug.trim().toLowerCase();
    const name = input.name.trim();
    const owner = input.createdBy.trim().toLowerCase();
    if (!slug || !name || !owner) {
      throw new BadRequestException('slug, name and createdBy are required');
    }

    const existingWorkspace = await this.workspaceModel.findOne({ slug });
    if (existingWorkspace) {
      await this.ensureDefaultRoles(existingWorkspace.id);
      return existingWorkspace;
    }

    const workspace = await this.workspaceModel.create({
      slug,
      name,
      createdBy: owner,
    });

    await this.ensureDefaultRoles(workspace.id);

    return workspace;
  }

  async getWorkspaceBySlug(slugRaw: string) {
    const slug = slugRaw.trim().toLowerCase();
    if (!slug) {
      throw new BadRequestException('slug is required');
    }

    const workspace = await this.workspaceModel.findOne({ slug }).lean();
    if (!workspace) {
      throw new NotFoundException('workspace not found');
    }

    return workspace;
  }

  async listWorkspacesForUser(userIdRaw: string) {
    const userId = userIdRaw.trim().toLowerCase();
    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    const ownedWorkspaces = await this.workspaceModel.find({ createdBy: userId }).lean();
    const memberWorkspaceIds = await this.memberModel.distinct('workspaceId', {
      userId,
      leftAt: null,
    });
    const membershipWorkspaces =
      memberWorkspaceIds.length > 0
        ? await this.workspaceModel.find({ _id: { $in: memberWorkspaceIds } }).lean()
        : [];

    const byId = new Map<string, (typeof ownedWorkspaces)[number]>();
    for (const workspace of [...ownedWorkspaces, ...membershipWorkspaces]) {
      byId.set(String(workspace._id), workspace);
    }

    return Array.from(byId.values());
  }

  async createRole(input: CreateRoleDto) {
    await this.assertWorkspace(input.workspaceId);

    const role = await this.roleModel.create({
      workspaceId: input.workspaceId,
      name: input.name.trim().toLowerCase(),
      priority: input.priority,
      permissions: input.permissions,
    });

    return role;
  }

  async createChannel(input: CreateChannelDto) {
    await this.assertWorkspace(input.workspaceId);

    const actor = input.actorUserId.trim().toLowerCase();
    const ownerRole = await this.getRoleByName(input.workspaceId, 'owner');
    if (!ownerRole) {
      throw new BadRequestException('owner role missing in workspace');
    }

    const channel = await this.channelModel.create({
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      visibility: input.visibility ?? 'public',
      keyVersion: 1,
      archived: false,
    });

    await this.memberModel.updateOne(
      { channelId: channel.id, userId: actor },
      {
        $set: {
          channelId: channel.id,
          workspaceId: input.workspaceId,
          userId: actor,
          roleName: ownerRole.name,
          leftAt: null,
        },
      },
      { upsert: true }
    );

    return channel;
  }

  async joinChannel(channelId: string, input: ChannelJoinDto) {
    const channel = await this.requireChannel(channelId);

    const actorPerms = await this.getPermissions(
      channel.workspaceId,
      input.actorUserId,
      channel.id
    );
    const isPublic = channel.visibility === 'public';
    const canInvite = actorPerms.has(CHANNEL_PERMISSIONS.MEMBER_INVITE);

    if (!isPublic && !canInvite) {
      throw new ForbiddenException('cannot join private channel without invite permission');
    }

    const roleName = (input.roleName || 'member').toLowerCase();
    const role = await this.getRoleByName(channel.workspaceId, roleName);
    if (!role) throw new BadRequestException(`unknown role ${roleName}`);

    const userId = input.userId.trim().toLowerCase();
    await this.memberModel.updateOne(
      { channelId, userId },
      {
        $set: {
          channelId,
          workspaceId: channel.workspaceId,
          userId,
          roleName: role.name,
          leftAt: null,
          joinedAt: new Date(),
        },
      },
      { upsert: true }
    );

    const workspace = await this.workspaceModel.findById(channel.workspaceId).lean();
    await this.redis.publish(
      'chat:channel_events',
      JSON.stringify({
        userIds: [userId],
        type: 'channel.member.joined',
        data: {
          channelId: channel.id,
          workspaceId: channel.workspaceId,
          workspaceSlug: workspace?.slug,
          workspaceName: workspace?.name,
          channelName: channel.name,
          visibility: channel.visibility,
          roleName: role.name,
          joinedBy: input.actorUserId.trim().toLowerCase(),
        },
      })
    );

    // Soft mode: keep old messages accessible for new members.
    return { joined: true, historyVisible: true, keyVersion: channel.keyVersion };
  }

  async leaveChannel(channelId: string, input: ChannelLeaveDto) {
    await this.requireChannel(channelId);
    const userId = input.userId.trim().toLowerCase();

    await this.memberModel.updateOne(
      { channelId, userId, leftAt: null },
      { $set: { leftAt: new Date() } }
    );

    return { left: true };
  }

  async kickMember(channelId: string, input: ChannelKickDto) {
    const channel = await this.requireChannel(channelId);
    const actorPerms = await this.getPermissions(
      channel.workspaceId,
      input.actorUserId,
      channel.id
    );

    if (!actorPerms.has(CHANNEL_PERMISSIONS.MEMBER_KICK)) {
      throw new ForbiddenException('missing member.kick permission');
    }

    const target = input.targetUserId.trim().toLowerCase();
    await this.memberModel.updateOne(
      { channelId, userId: target, leftAt: null },
      { $set: { leftAt: new Date() } }
    );

    await this.redis.publish(
      'chat:channel_events',
      JSON.stringify({
        userIds: [target],
        type: 'channel.member.kicked',
        data: {
          channelId: channel.id,
          workspaceId: channel.workspaceId,
          channelName: channel.name,
          kickedBy: input.actorUserId.trim().toLowerCase(),
        },
      })
    );

    // Soft encryption policy: no mandatory key rotation on kick.
    return { kicked: true, keyRotated: false };
  }

  async updateMemberRole(channelId: string, input: ChannelUpdateRoleDto) {
    const channel = await this.requireChannel(channelId);
    const actorPerms = await this.getPermissions(
      channel.workspaceId,
      input.actorUserId,
      channel.id
    );

    if (!actorPerms.has(CHANNEL_PERMISSIONS.ROLE_MANAGE)) {
      throw new ForbiddenException('missing role.manage permission');
    }

    const roleName = input.roleName.trim().toLowerCase();
    const role = await this.getRoleByName(channel.workspaceId, roleName);
    if (!role) {
      throw new BadRequestException(`unknown role ${roleName}`);
    }

    const targetUserId = input.targetUserId.trim().toLowerCase();
    const membership = await this.memberModel.findOne({
      channelId: channel.id,
      userId: targetUserId,
      leftAt: null,
    });

    if (!membership) {
      throw new NotFoundException('target user is not an active member of this channel');
    }

    membership.roleName = role.name;
    await membership.save();

    return {
      updated: true,
      channelId: channel.id,
      userId: targetUserId,
      roleName: role.name,
    };
  }

  async sendMessage(channelId: string, input: SendChannelMessageDto) {
    const channel = await this.requireChannel(channelId);
    const sender = input.senderId.trim().toLowerCase();

    const perms = await this.getPermissions(channel.workspaceId, sender, channel.id);
    if (!perms.has(CHANNEL_PERMISSIONS.CHANNEL_WRITE)) {
      throw new ForbiddenException('missing channel.write permission');
    }

    const message = await this.messageModel.create({
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      senderId: sender,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      keyVersion: channel.keyVersion,
      createdAt: new Date(),
    });

    // Notify ALL currently active members
    const members = await this.memberModel.find({ channelId: channel.id, leftAt: null }).lean();
    const userIds = members.map((m) => m.userId);

    if (userIds.length > 0) {
      await this.redis.publish(
        'chat:channel_events',
        JSON.stringify({
          userIds,
          type: 'channel.message.created',
          data: {
            id: message._id.toString(),
            channelId: message.channelId,
            workspaceId: message.workspaceId,
            senderId: message.senderId,
            ciphertext: message.ciphertext,
            nonce: message.nonce,
            keyVersion: message.keyVersion,
            createdAt: message.createdAt,
          },
        })
      );
    }

    return message;
  }

  async listMessages(channelId: string, userId: string, limit = 100) {
    const channel = await this.requireChannel(channelId);
    const perms = await this.getPermissions(channel.workspaceId, userId, channel.id);
    if (!perms.has(CHANNEL_PERMISSIONS.CHANNEL_READ)) {
      throw new ForbiddenException('missing channel.read permission');
    }

    const docs = await this.messageModel
      .find({ channelId: channel.id })
      .sort({ createdAt: -1 })
      .limit(Math.max(1, Math.min(limit, 200)))
      .lean();

    return docs.reverse().map((doc) => ({
      id: String(doc._id),
      channelId: doc.channelId,
      workspaceId: doc.workspaceId,
      senderId: doc.senderId,
      keyVersion: doc.keyVersion,
      createdAt: doc.createdAt,
      ciphertext: doc.ciphertext,
      nonce: doc.nonce,
    }));
  }

  async listChannelsForUser(workspaceId: string, userId: string) {
    await this.assertWorkspace(workspaceId);
    const memberships = await this.memberModel
      .find({ workspaceId, userId: userId.toLowerCase(), leftAt: null })
      .lean();

    const ids = memberships.map((m) => m.channelId);
    if (ids.length === 0) return [];

    return await this.channelModel.find({ _id: { $in: ids } }).lean();
  }

  private async assertWorkspace(workspaceId: string) {
    const ws = await this.workspaceModel.findById(String(workspaceId));
    if (!ws) throw new NotFoundException('workspace not found');
  }

  private async requireChannel(channelId: string) {
    const channel = await this.channelModel.findById(String(channelId));
    if (!channel) throw new NotFoundException('channel not found');
    return channel;
  }

  private async getRoleByName(workspaceId: string, roleName: string) {
    return this.roleModel.findOne({
      workspaceId: String(workspaceId),
      name: String(roleName).toLowerCase()
    });
  }

  private async ensureDefaultRoles(workspaceId: string) {
    const defaults: Array<{ name: string; priority: number; permissions: ChannelPermission[] }> = [
      { name: 'owner', priority: 100, permissions: DEFAULT_OWNER_PERMISSIONS },
      { name: 'admin', priority: 80, permissions: DEFAULT_ADMIN_PERMISSIONS },
      { name: 'moderator', priority: 50, permissions: DEFAULT_MODERATOR_PERMISSIONS },
      { name: 'member', priority: 10, permissions: DEFAULT_MEMBER_PERMISSIONS },
    ];

    for (const role of defaults) {
      await this.roleModel.updateOne(
        { workspaceId, name: role.name },
        {
          $setOnInsert: {
            workspaceId,
            name: role.name,
            priority: role.priority,
            permissions: role.permissions,
          },
        },
        { upsert: true }
      );
    }
  }

  private async getPermissions(
    workspaceId: string,
    userIdRaw: string,
    channelId: string
  ): Promise<Set<ChannelPermission>> {
    const userId = userIdRaw.trim().toLowerCase();
    const member = await this.memberModel.findOne({ channelId, userId, leftAt: null });

    if (!member) {
      // No membership means no UI access to this channel.
      return new Set<ChannelPermission>();
    }

    const role = await this.roleModel.findOne({
      workspaceId,
      name: member.roleName.toLowerCase(),
    });

    const base = role?.permissions || [];
    return new Set(base);
  }
}
