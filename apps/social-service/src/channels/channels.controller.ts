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
  type RenameChannelDto,
  type SendChannelMessageDto,
} from './dto/channel.dto';

@Controller('channels')
export class ChannelsController {
  constructor(private readonly service: ChannelService) {}

  @Get('health')
  health() {
    return {
      service: 'channel-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @UseGuards(NginxAuthGuard)
  @Post('workspaces')
  createWorkspace(@Headers('x-user-id') xUserId: string, @Body() body: CreateWorkspaceDto) {
    return this.service.createWorkspace({ ...body, createdBy: xUserId.trim().toLowerCase() });
  }

  @Get('workspaces/by-slug/:slug')
  getWorkspaceBySlug(@Param('slug') slug: string) {
    return this.service.getWorkspaceBySlug(slug);
  }

  @UseGuards(NginxAuthGuard)
  @Get('workspaces/user/me')
  listWorkspaces(@Headers('x-user-id') xUserId: string) {
    return this.service.listWorkspacesForUser(xUserId.trim().toLowerCase());
  }

  @UseGuards(NginxAuthGuard)
  @Post('roles')
  createRole(@Body() body: CreateRoleDto) {
    return this.service.createRole(body);
  }

  @UseGuards(NginxAuthGuard)
  @Post()
  createChannel(@Headers('x-user-id') xUserId: string, @Body() body: CreateChannelDto) {
    return this.service.createChannel({ ...body, actorUserId: xUserId.trim().toLowerCase() });
  }

  @UseGuards(NginxAuthGuard)
  @Get('workspace/:workspaceId/user/me')
  listChannels(@Headers('x-user-id') xUserId: string, @Param('workspaceId') workspaceId: string) {
    return this.service.listChannelsForUser(workspaceId, xUserId.trim().toLowerCase());
  }

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

  @UseGuards(NginxAuthGuard)
  @Get(':channelId/members')
  listChannelMembers(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.listChannelMembers(channelId, xUserId.trim().toLowerCase());
  }

  @UseGuards(NginxAuthGuard)
  @Get(':channelId/key')
  getChannelKey(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.getChannelKey(channelId, xUserId.trim().toLowerCase());
  }

  @UseGuards(NginxAuthGuard)
  @Post(':channelId/key/rotate')
  rotateChannelKey(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.rotateChannelKey(channelId, xUserId.trim().toLowerCase());
  }

  @UseGuards(NginxAuthGuard)
  @Patch(':channelId')
  renameChannel(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Body() body: RenameChannelDto
  ) {
    return this.service.renameChannel(channelId, xUserId.trim().toLowerCase(), body.name);
  }

  @UseGuards(NginxAuthGuard)
  @Delete(':channelId')
  archiveChannel(@Headers('x-user-id') xUserId: string, @Param('channelId') channelId: string) {
    return this.service.archiveChannel(channelId, xUserId.trim().toLowerCase());
  }

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
      console.error('CONTROLLER SEND ERROR', err);
      throw new HttpException(
        {
          statusCode: err.status || 500,
          message: err.message || 'Internal server error',
          stack: err.stack,
        },
        err.status ? Number(err.status) : HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @UseGuards(NginxAuthGuard)
  @Get(':channelId/messages')
  listMessages(
    @Headers('x-user-id') xUserId: string,
    @Param('channelId') channelId: string,
    @Query() query: GetChannelMessagesQuery
  ) {
    const limit = query.limit ? Number(query.limit) : 100;
    return this.service.listMessages(channelId, xUserId.trim().toLowerCase(), limit);
  }
}
