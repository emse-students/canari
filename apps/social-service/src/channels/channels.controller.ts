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
  type SendChannelMessageDto,
  type UpdateChannelImageDto,
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

  /** Updates the cover image of a channel. */
  @UseGuards(NginxAuthGuard)
  @Patch(':channelId/image')
  async updateChannelImage(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: UpdateChannelImageDto
  ) {
    return await this.service.updateChannelImage(
      channelId,
      xUserId.trim().toLowerCase(),
      body.mediaId
    );
  }

  /** Returns the channel's access settings (isPrivate, allowedRoles) and the workspace role list. */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/access')
  getChannelAccess(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string
  ) {
    return this.service.getChannelAccess(channelId, xUserId.trim().toLowerCase());
  }

  /** Updates the channel's isPrivate flag and allowedRoles list. */
  @UseGuards(NginxAuthGuard)
  @Patch(':channelId/access')
  updateChannelAccess(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: { isPrivate: boolean; allowedRoleIds: string[] }
  ) {
    return this.service.updateChannelAccess(
      channelId,
      xUserId.trim().toLowerCase(),
      body.isPrivate,
      body.allowedRoleIds ?? []
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

  /** Returns recent messages for a channel accessible to the calling user. */
  @UseGuards(NginxAuthGuard)
  @Get(':channelId/messages')
  listMessages(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Query() query: GetChannelMessagesQuery
  ) {
    const limit = query.limit ? Math.min(Number(query.limit), 200) : 100;
    return this.service.listMessages(channelId, xUserId.trim().toLowerCase(), limit);
  }
}
