import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
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
  type ChannelLeaveDto,
  type ChannelUpdateRoleDto,
  type CreateChannelDto,
  type CreateRoleDto,
  type CreateWorkspaceDto,
  type CreateWorkspaceInviteDto,
  type GetChannelMessagesQuery,
  type PublishDistributionGroupInfoDto,
  type RenameChannelDto,
  type ReorderWorkspacesDto,
  type SendChannelMessageDto,
  type SetChannelNotificationLevelDto,
  type UpdateChannelImageDto,
  type UpdateChannelAccessDto,
  type UpdateWorkspaceHistoryVisibilityDto,
  type UpdateWorkspaceMemberRoleDto,
  CHANNEL_NOTIFICATION_LEVELS,
  CHANNEL_WRITE_POLICIES,
} from './dto/channel.dto';
import { type SetRolePermissionsDto } from './dto/channel-permission.dto';
import { LiveGraineSessionsDto } from './dto/live-graine-sessions.dto';
import { CHANNEL_MESSAGE_RETENTION_DAYS } from './channel-retention.scheduler';

/** Manages workspace and channel resources including membership and messages. */
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

  /** Returns a workspace looked up by its URL slug, with viewerCanManage computed for the caller. */
  @UseGuards(NginxAuthGuard)
  @Get('workspaces/by-slug/:slug')
  getWorkspaceBySlug(@Headers('x-user-id') xUserId: string, @Param('slug') slug: string) {
    return this.service.getWorkspaceBySlug(slug, xUserId.trim().toLowerCase());
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

  /**
   * The community's Graine key-distribution group, with the latest GroupInfo published on it.
   *
   * Served by THIS service and not by chat-delivery because the answer is authorized by community
   * membership, which only lives here; chat-delivery's own MLS routes gate on a `dm_group_members`
   * row, and a distribution group has none by construction. See
   * `docs/wiki/protocols/channel-encryption.md`.
   */
  @UseGuards(NginxAuthGuard)
  @Get('workspaces/:workspaceId/distribution-group')
  getDistributionGroup(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string
  ) {
    return this.service.getDistributionGroupForMember(workspaceId, xUserId.trim().toLowerCase());
  }

  /** Publishes the GroupInfo a member just committed on the community's distribution group. */
  @UseGuards(NginxAuthGuard)
  @Post('workspaces/:workspaceId/distribution-group/group-info')
  publishDistributionGroupInfo(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: PublishDistributionGroupInfoDto
  ) {
    if (typeof body?.groupInfo !== 'string' || body.groupInfo.length === 0) {
      throw new HttpException('groupInfo (base64) is required', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(body?.baseEpoch) || body.baseEpoch < 0) {
      throw new HttpException('baseEpoch must be a non-negative integer', HttpStatus.BAD_REQUEST);
    }
    if (typeof body?.deviceId !== 'string' || body.deviceId.length === 0) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    return this.service.publishDistributionGroupInfoForMember(
      workspaceId,
      xUserId.trim().toLowerCase(),
      body.groupInfo,
      body.baseEpoch,
      body.deviceId
    );
  }

  /**
   * A PRIVATE salon's own Graine key-distribution group, with the latest GroupInfo published on it.
   *
   * The salon-scoped twin of the workspace route above, and the reason a private salon's seeds stop
   * being sealed to the whole community. Authorized by `canAccessChannel`, which since 2026-08-19
   * is `allowedUsers` and nothing else - an administrator must have joined the salon explicitly to
   * be served this, because the GroupInfo IS the capability to external-join.
   *
   * A public salon is refused here rather than answered with the community's group: it has none of
   * its own, on purpose, and pretending otherwise would hide the distinction from the client.
   */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/distribution-group')
  getChannelDistributionGroup(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string
  ) {
    return this.service.getChannelDistributionGroupForMember(
      channelId,
      xUserId.trim().toLowerCase()
    );
  }

  /** Publishes the GroupInfo a reader just committed on a private salon's distribution group. */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/distribution-group/group-info')
  publishChannelDistributionGroupInfo(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: PublishDistributionGroupInfoDto
  ) {
    if (typeof body?.groupInfo !== 'string' || body.groupInfo.length === 0) {
      throw new HttpException('groupInfo (base64) is required', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(body?.baseEpoch) || body.baseEpoch < 0) {
      throw new HttpException('baseEpoch must be a non-negative integer', HttpStatus.BAD_REQUEST);
    }
    if (typeof body?.deviceId !== 'string' || body.deviceId.length === 0) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    return this.service.publishChannelDistributionGroupInfoForMember(
      channelId,
      xUserId.trim().toLowerCase(),
      body.groupInfo,
      body.baseEpoch,
      body.deviceId
    );
  }

  /**
   * Puts an administrator into a private salon explicitly, so they appear in its roster and are
   * served its seeds.
   *
   * There is no silent bypass any more: `workspace.manage` shows an admin that the salon EXISTS,
   * and this route is how they enter it. Deliberately visible in the member list and deliberately
   * silent in the transcript - see the service method for why.
   */
  @UseGuards(NginxAuthGuard)
  @Post(':channelId/join-as-admin')
  joinPrivateChannelAsAdmin(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string
  ) {
    return this.service.joinPrivateChannelAsAdmin(channelId, xUserId.trim().toLowerCase());
  }

  /**
   * Returns the community's one live invite link, minting it if there is none (requires
   * INVITE_USERS / MANAGE_WORKSPACE). `rotate: true` revokes the live token and mints its
   * replacement - it is the only way to get a new one, so opening the panel cannot invalidate a
   * link somebody already shared.
   */
  @UseGuards(NginxAuthGuard)
  @Post('workspaces/:workspaceId/invites')
  createWorkspaceInvite(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateWorkspaceInviteDto
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

  /** Removes a member from a specific channel (not the workspace). Requires MANAGE_WORKSPACE or MANAGE_CHANNELS permission. */
  @UseGuards(NginxAuthGuard)
  @Delete(':channelId/members/:userId')
  removeMemberFromChannel(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Param('userId') userId: string
  ) {
    return this.service.removeMemberFromChannel(
      channelId,
      userId.trim().toLowerCase(),
      xUserId.trim().toLowerCase()
    );
  }

  /**
   * Returns the channel's own members. `?scope=workspace` returns the whole community roster
   * instead - needed by the settings panel to offer people who are not in the channel yet.
   */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/members')
  listChannelMembers(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Query('scope') scope?: string
  ) {
    return this.service.listChannelMembers(
      channelId,
      xUserId.trim().toLowerCase(),
      scope === 'workspace' ? 'workspace' : 'channel'
    );
  }

  /** Removes the calling user from a workspace. */
  @UseGuards(NginxAuthGuard)
  @Post('workspaces/:workspaceId/leave')
  leaveWorkspace(@Headers('x-user-id') xUserId: string, @Param('workspaceId') workspaceId: string) {
    return this.service.leaveWorkspace(workspaceId, xUserId.trim().toLowerCase());
  }

  /**
   * Deletes a whole community for every member, irreversibly. Requires MANAGE_WORKSPACE
   * (admin-only) AND `confirmationName` equal to the community's name - see
   * {@link ChannelService.deleteWorkspace} for why the name is checked on the server and not
   * only in the dialog. Declared before `DELETE :channelId` for readability; the two never
   * collide because this path carries two segments.
   *
   * The body is read defensively: a DELETE with no body at all is what an older client sends,
   * and it must reach the name check and be refused there rather than crash on a missing field.
   */
  @UseGuards(NginxAuthGuard)
  @Delete('workspaces/:workspaceId')
  deleteWorkspace(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body?: { confirmationName?: string }
  ) {
    return this.service.deleteWorkspace(
      workspaceId,
      xUserId.trim().toLowerCase(),
      body?.confirmationName ?? ''
    );
  }

  /** Kicks a member from a workspace (removes from all channels). Requires MANAGE_WORKSPACE, MANAGE_CHANNEL, or KICK_MEMBERS permission. */
  @UseGuards(NginxAuthGuard)
  @Delete('workspaces/:workspaceId/members/:userId')
  kickFromWorkspace(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string
  ) {
    return this.service.kickFromWorkspace(
      workspaceId,
      userId.trim().toLowerCase(),
      xUserId.trim().toLowerCase()
    );
  }

  /** Sets a workspace member's role (workspace-level). Requires MANAGE_WORKSPACE or MANAGE_ROLES. */
  @UseGuards(NginxAuthGuard)
  @Patch('workspaces/:workspaceId/members/:userId/role')
  updateWorkspaceMemberRole(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() body: UpdateWorkspaceMemberRoleDto
  ) {
    return this.service.updateWorkspaceMemberRole(
      workspaceId,
      userId.trim().toLowerCase(),
      body.roleName,
      xUserId.trim().toLowerCase()
    );
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

  /** Returns the whole community roster, for a caller holding no channel id (Graine history). */
  @UseGuards(NginxAuthGuard)
  @Get('workspaces/:workspaceId/members')
  listWorkspaceMembers(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string
  ) {
    return this.service.listWorkspaceMembers(workspaceId, xUserId.trim().toLowerCase());
  }

  /** Sets what this community lets a newcomer read (`shared` or `joined`). */
  @UseGuards(NginxAuthGuard)
  @Patch('workspaces/:workspaceId/history-visibility')
  async updateWorkspaceHistoryVisibility(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: UpdateWorkspaceHistoryVisibilityDto
  ) {
    return await this.service.updateWorkspaceHistoryVisibility(
      workspaceId,
      xUserId.trim().toLowerCase(),
      body.historyVisibility
    );
  }

  /** Returns the channel's access settings (isPrivate, allowedUsers, writePolicy). Readers only. */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/access')
  getChannelAccess(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.getChannelAccess(channelId, xUserId.trim().toLowerCase());
  }

  /** Updates the channel's isPrivate flag, allowedUsers list, and write policy (who may post). */
  @UseGuards(NginxAuthGuard)
  @Patch(':channelId/access')
  updateChannelAccess(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: UpdateChannelAccessDto
  ) {
    if (body.writePolicy && !CHANNEL_WRITE_POLICIES.includes(body.writePolicy)) {
      throw new HttpException(
        { statusCode: HttpStatus.BAD_REQUEST, message: 'Invalid write policy' },
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.updateChannelAccess(
      channelId,
      xUserId.trim().toLowerCase(),
      body.isPrivate,
      body.allowedUserIds ?? [],
      body.writePolicy
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

  /** Deletes a channel message: own message always, someone else's with `channel.moderate`. */
  @UseGuards(NginxAuthGuard)
  @Delete(':channelId/messages/:messageId')
  deleteChannelMessage(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string
  ) {
    return this.service.deleteChannelMessage(channelId, messageId, xUserId.trim().toLowerCase());
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

  // ═══════════════════════════════════════════════════════════════════
  // ROLE BASE PERMISSIONS
  // ═══════════════════════════════════════════════════════════════════

  /** Fetches a role's base permissions at the workspace level. */
  @UseGuards(NginxAuthGuard)
  @Get('roles/:roleId/permissions')
  getRolePermissions(@Headers('x-user-id') xUserId: string, @Param('roleId') roleId: string) {
    return this.service.getRoleBasePermissions(roleId, xUserId.trim().toLowerCase());
  }

  /**
   * Of the Graine sessions this device holds, which ones still have messages on the server.
   *
   * The device forgets the rest. This is what keeps the seeds' retention window IDENTICAL to the
   * messages' one without a second clock: the answer is derived from the rows that actually exist,
   * so a pinned message the sweep kept also keeps its seed, and a message deleted for any other
   * reason releases it. A POST because the id list is the request, not an addressable resource.
   *
   * `retentionDays` travels back with the answer so the CLIENT NEVER HOLDS A COPY of the window.
   * The device needs it for one thing only - refusing to drop a session younger than the window,
   * which cannot have lost its messages to the purge and may simply have none yet. Serving the
   * number rather than compiling it in keeps {@link CHANNEL_MESSAGE_RETENTION_DAYS} the single
   * copy, and sending DAYS rather than a cutoff instant keeps both sides of the comparison on the
   * device's own clock.
   */
  @UseGuards(NginxAuthGuard)
  @Post('graine/live-sessions')
  liveGraineSessions(
    @Headers('x-user-id') xUserId: string,
    @Body() body: LiveGraineSessionsDto
  ): Promise<{ live: string[]; retentionDays: number }> {
    return this.service
      .liveGraineSessions(xUserId.trim().toLowerCase(), body.sessionIds ?? [])
      .then((live) => ({ live, retentionDays: CHANNEL_MESSAGE_RETENTION_DAYS }));
  }

  /** Updates a role's base permissions (MANAGE_ROLES required). */
  @UseGuards(NginxAuthGuard)
  @Put('roles/:roleId/permissions')
  setRolePermissions(
    @Headers('x-user-id') xUserId: string,
    @Param('roleId') roleId: string,
    @Body() body: SetRolePermissionsDto
  ) {
    return this.service.setRoleBasePermissions(
      roleId,
      xUserId.trim().toLowerCase(),
      body.permissions ?? []
    );
  }
}
