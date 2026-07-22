import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { ChannelService } from './channel.service';
import {
  type ChannelJoinDto,
  type ChannelInviteDto,
  type ChannelKickDto,
  type ChannelLeaveDto,
  type ChannelUpdateRoleDto,
  type CreateChannelDto,
  type CreateRoleDto,
  type CreateWorkspaceDto,
  type GetChannelMessagesQuery,
  type MarkDistributionReceivedDto,
  type RenameChannelDto,
  type ReorderWorkspacesDto,
  type SendChannelMessageDto,
  type SetChannelNotificationLevelDto,
  type UpdateChannelImageDto,
  CHANNEL_NOTIFICATION_LEVELS,
} from './dto/channel.dto';

/** Manages workspace and channel resources including membership, keys, and messages. */
@Controller('channels')
export class ChannelsController {
  constructor(private readonly service: ChannelService) {}

  /** Returns the health status of the channel service. */
  @Get('health')
  health() {
    return {
      service: 'channel-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  /** Creates a new workspace owned by the calling user. */
  @UseGuards(NginxAuthGuard)
  @Post('workspaces')
  createWorkspace(@Headers('x-user-id') xUserId: string, @Body() body: CreateWorkspaceDto) {
    return this.service.createWorkspace({ ...body, createdBy: xUserId.trim().toLowerCase() });
  }

  /** Returns a workspace looked up by its URL slug. */
  @UseGuards(NginxAuthGuard)
  @Get('workspaces/by-slug/:slug')
  getWorkspaceBySlug(@Param('slug') slug: string) {
    return this.service.getWorkspaceBySlug(slug);
  }

  /** Returns all workspaces the calling user belongs to. */
  @UseGuards(NginxAuthGuard)
  @Get('workspaces/user/me')
  listWorkspaces(@Headers('x-user-id') xUserId: string) {
    return this.service.listWorkspacesForUser(xUserId.trim().toLowerCase());
  }

  /** Persists the calling user's personal top-to-bottom order for their communities. */
  @UseGuards(NginxAuthGuard)
  @Patch('workspaces/reorder')
  reorderWorkspaces(@Headers('x-user-id') xUserId: string, @Body() body: ReorderWorkspacesDto) {
    return this.service.reorderWorkspacesForUser(xUserId.trim().toLowerCase(), body.orderedIds);
  }

  /** Creates a shareable invite link for a community (requires INVITE_USERS / MANAGE_WORKSPACE). */
  @UseGuards(NginxAuthGuard)
  @Post('workspaces/:workspaceId/invites')
  createWorkspaceInvite(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: { expiresAt?: string | null; maxUses?: number | null }
  ) {
    return this.service.createWorkspaceInvite(
      workspaceId,
      xUserId.trim().toLowerCase(),
      body ?? {}
    );
  }

  /** Preview of an invite link (community name/image) shown before joining. */
  @UseGuards(NginxAuthGuard)
  @Get('invites/:token')
  getInvitePreview(@Param('token') token: string) {
    return this.service.getWorkspaceInvitePreview(token);
  }

  /** Joins the calling user into the community behind an invite link. */
  @UseGuards(NginxAuthGuard)
  @Post('invites/:token/accept')
  acceptInvite(@Headers('x-user-id') xUserId: string, @Param('token') token: string) {
    return this.service.acceptWorkspaceInvite(token, xUserId.trim().toLowerCase());
  }

  /** Creates a new role in a workspace on behalf of the calling user. */
  @UseGuards(NginxAuthGuard)
  @Post('roles')
  createRole(@Headers('x-user-id') xUserId: string, @Body() body: CreateRoleDto) {
    return this.service.createRole({ ...body, actorUserId: xUserId.trim().toLowerCase() });
  }

  /** Creates a new channel inside a workspace. */
  @UseGuards(NginxAuthGuard)
  @Post()
  createChannel(@Headers('x-user-id') xUserId: string, @Body() body: CreateChannelDto) {
    return this.service.createChannel({ ...body, actorUserId: xUserId.trim().toLowerCase() });
  }

  /** Returns all channels in a workspace that the calling user has access to. */
  @UseGuards(NginxAuthGuard)
  @Get('workspace/:workspaceId/user/me')
  listChannels(@Headers('x-user-id') xUserId: string, @Param('workspaceId') workspaceId: string) {
    return this.service.listChannelsForUser(workspaceId, xUserId.trim().toLowerCase());
  }

  /** Returns the current encryption key bootstrap data for the calling user in a channel. */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/key')
  getChannelKeyBootstrap(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string
  ) {
    return this.service.getChannelKeyBootstrapForUser(channelId, xUserId.trim().toLowerCase());
  }

  /** Returns historical encryption keys for a channel to allow decryption of past messages. */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/keys/history')
  getChannelHistoryKeys(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string
  ) {
    return this.service.getChannelHistoryKeysForUser(channelId, xUserId.trim().toLowerCase());
  }

  /** Adds the calling user as a member of the specified channel. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/members/join')
  join(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: ChannelJoinDto
  ) {
    const userId = xUserId.trim().toLowerCase();
    return this.service.joinChannel(channelId, { ...body, userId, actorUserId: userId });
  }

  /** Invites a target user to a channel on behalf of the calling user. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/members/invite')
  invite(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: ChannelInviteDto
  ) {
    const actorUserId = xUserId.trim().toLowerCase();
    return this.service.inviteToChannel(channelId, {
      ...body,
      targetUserId: body.targetUserId?.trim().toLowerCase(),
      actorUserId,
    });
  }

  /** Removes the calling user from the specified channel. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/members/leave')
  leave(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: ChannelLeaveDto
  ) {
    return this.service.leaveChannel(channelId, {
      ...body,
      userId: xUserId.trim().toLowerCase(),
    });
  }

  /** Kicks a member from a channel; requires sufficient role on the calling user. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/members/kick')
  kick(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: ChannelKickDto
  ) {
    return this.service.kickMember(channelId, {
      ...body,
      actorUserId: xUserId.trim().toLowerCase(),
    });
  }

  /** Updates the role of a channel member. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/members/role')
  updateMemberRole(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: ChannelUpdateRoleDto
  ) {
    return this.service.updateMemberRole(channelId, {
      ...body,
      actorUserId: xUserId.trim().toLowerCase(),
    });
  }

  /** Returns all members of a channel visible to the calling user. */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/members')
  listChannelMembers(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.listChannelMembers(channelId, xUserId.trim().toLowerCase());
  }

  /** Rotates the encryption key for a channel, generating a new key version. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/key/rotate')
  rotateChannelKey(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.rotateChannelKey(channelId, xUserId.trim().toLowerCase());
  }

  /** Marks a key distribution as sent by the calling user. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/key-distributions/:distributionId/sent')
  markKeyDistributionSent(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Param('distributionId') distributionId: string
  ) {
    return this.service.markKeyDistributionSent(
      channelId,
      distributionId,
      xUserId.trim().toLowerCase()
    );
  }

  /** Marks a key distribution as received and records the accepted key version. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/key-distributions/:distributionId/received')
  markKeyDistributionReceived(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Param('distributionId') distributionId: string,
    @Body() body: MarkDistributionReceivedDto
  ) {
    return this.service.markKeyDistributionReceived(
      channelId,
      distributionId,
      xUserId.trim().toLowerCase(),
      Number(body.keyVersion)
    );
  }

  /** Removes the calling user from a workspace. */
  @UseGuards(NginxAuthGuard)
  @Post('workspaces/:workspaceId/leave')
  leaveWorkspace(@Headers('x-user-id') xUserId: string, @Param('workspaceId') workspaceId: string) {
    return this.service.leaveWorkspace(workspaceId, xUserId.trim().toLowerCase());
  }

  /** Updates the cover image of a workspace. */
  @UseGuards(NginxAuthGuard)
  @Patch('workspaces/:workspaceId/image')
  async updateWorkspaceImage(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: UpdateChannelImageDto
  ) {
    return await this.service.updateWorkspaceImage(
      workspaceId,
      xUserId.trim().toLowerCase(),
      body.mediaId
    );
  }

  /** Acknowledges receipt and processing of a key distribution for a channel. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/key-distributions/:distributionId/ack')
  ackKeyDistribution(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Param('distributionId') distributionId: string,
    @Body() body: MarkDistributionReceivedDto
  ) {
    return this.service.ackKeyDistribution(
      channelId,
      distributionId,
      xUserId.trim().toLowerCase(),
      Number(body.keyVersion)
    );
  }

  /** Returns the channel's access settings (isPrivate, allowedRoles) and the workspace role list. */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/access')
  getChannelAccess(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.getChannelAccess(channelId, xUserId.trim().toLowerCase());
  }

  /** Updates the channel's isPrivate flag and allowedUsers list. */
  @UseGuards(NginxAuthGuard)
  @Patch(':channelId/access')
  updateChannelAccess(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: { isPrivate: boolean; allowedUserIds: string[] }
  ) {
    return this.service.updateChannelAccess(
      channelId,
      xUserId.trim().toLowerCase(),
      body.isPrivate,
      body.allowedUserIds ?? []
    );
  }

  /** Renames a channel. */
  @UseGuards(NginxAuthGuard)
  @Patch(':channelId')
  renameChannel(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: RenameChannelDto
  ) {
    return this.service.renameChannel(channelId, xUserId.trim().toLowerCase(), body.name);
  }

  /** Archives (soft-deletes) the specified channel. */
  @UseGuards(NginxAuthGuard)
  @Delete(':channelId')
  archiveChannel(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.archiveChannel(channelId, xUserId.trim().toLowerCase());
  }

  /** Sends an encrypted message to a channel. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/messages')
  async sendMessage(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: SendChannelMessageDto
  ) {
    const userId = xUserId.trim().toLowerCase();
    try {
      return await this.service.sendMessage(channelId, { ...body, senderId: userId });
    } catch (err: any) {
      throw new HttpException(
        {
          statusCode: err.status || 500,
          message: err.message || 'Internal server error',
        },
        err.status ? Number(err.status) : HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /** Broadcasts an ephemeral "typing" signal to channel members (not persisted). */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/typing')
  async typing(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: { typing?: boolean }
  ) {
    await this.service.publishTyping(
      channelId,
      xUserId.trim().toLowerCase(),
      body?.typing !== false
    );
    return { ok: true };
  }

  /** Returns the calling user's push notification level for a channel (all | mentions | none). */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/notification-level')
  getNotificationLevel(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string
  ) {
    return this.service.getNotificationLevel(channelId, xUserId.trim().toLowerCase());
  }

  /** Sets the calling user's push notification level for a channel (all | mentions | none). */
  @UseGuards(NginxAuthGuard)
  @Patch(':channelId/notification-level')
  setNotificationLevel(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: SetChannelNotificationLevelDto
  ) {
    if (!CHANNEL_NOTIFICATION_LEVELS.includes(body?.level)) {
      throw new HttpException(
        { statusCode: HttpStatus.BAD_REQUEST, message: 'Invalid notification level' },
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.setNotificationLevel(channelId, xUserId.trim().toLowerCase(), body.level);
  }

  /** Pins or unpins a message in a channel (broadcasts a channel.pin event). */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/messages/:messageId/pin')
  async pinMessage(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Body() body: { pinned?: boolean }
  ) {
    await this.service.setMessagePinned(
      channelId,
      messageId,
      xUserId.trim().toLowerCase(),
      body?.pinned !== false
    );
    return { ok: true };
  }

  /** Records the caller's vote on a poll message (empty optionIds retracts the vote). */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/messages/:messageId/poll/vote')
  votePoll(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Body() body: { optionIds?: string[] }
  ) {
    return this.service.votePoll(
      channelId,
      messageId,
      xUserId.trim().toLowerCase(),
      Array.isArray(body?.optionIds) ? body.optionIds : []
    );
  }

  /** Closes a poll now (author or moderator only): forces the deadline and unpins it. */
  @UseGuards(NginxAuthGuard)
  @Patch(':channelId/messages/:messageId/poll/close')
  closePoll(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string
  ) {
    return this.service.closePoll(channelId, messageId, xUserId.trim().toLowerCase());
  }

  /** Returns the IDs of the pinned messages in a channel. */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/pins')
  listPins(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.listPinnedMessageIds(channelId, xUserId.trim().toLowerCase());
  }

  /**
   * Signals that the caller has read a channel, fanning out a silent `channel_read` push to the
   * caller's OTHER devices so they clear the channel's notification (cross-device read-state sync).
   */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/read')
  async markRead(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    await this.service.markChannelRead(channelId, xUserId.trim().toLowerCase());
    return { ok: true };
  }

  /** Returns recent messages for a channel accessible to the calling user. */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/messages')
  listMessages(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Query() query: GetChannelMessagesQuery
  ) {
    const limit = query.limit ? Math.min(Number(query.limit), 200) : 100;
    const before =
      typeof query.before === 'string' && query.before.trim() ? query.before.trim() : undefined;
    return this.service.listMessages(channelId, xUserId.trim().toLowerCase(), limit, before);
  }
}
