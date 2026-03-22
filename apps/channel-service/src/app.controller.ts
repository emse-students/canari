import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ChannelService } from './channel.service';
import {
  type ChannelJoinDto,
  type ChannelKickDto,
  type ChannelLeaveDto,
  type ChannelUpdateRoleDto,
  type CreateChannelDto,
  type CreateRoleDto,
  type CreateWorkspaceDto,
  type GetChannelMessagesQuery,
  type SendChannelMessageDto,
} from './dto/channel.dto';

@Controller('channels')
export class AppController {
  constructor(private readonly service: ChannelService) {}

  @Get('health')
  health() {
    return {
      service: 'channel-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Post('workspaces')
  createWorkspace(@Body() body: CreateWorkspaceDto) {
    return this.service.createWorkspace(body);
  }

  @Get('workspaces/by-slug/:slug')
  getWorkspaceBySlug(@Param('slug') slug: string) {
    return this.service.getWorkspaceBySlug(slug);
  }

  @Get('workspaces/user/:userId')
  listWorkspaces(@Param('userId') userId: string) {
    return this.service.listWorkspacesForUser(userId);
  }

  @Post('roles')
  createRole(@Body() body: CreateRoleDto) {
    return this.service.createRole(body);
  }

  @Post()
  createChannel(@Body() body: CreateChannelDto) {
    return this.service.createChannel(body);
  }

  @Get('workspace/:workspaceId/user/:userId')
  listChannels(@Param('workspaceId') workspaceId: string, @Param('userId') userId: string) {
    return this.service.listChannelsForUser(workspaceId, userId);
  }

  @Post(':channelId/members/join')
  join(@Param('channelId') channelId: string, @Body() body: ChannelJoinDto) {
    return this.service.joinChannel(channelId, body);
  }

  @Post(':channelId/members/leave')
  leave(@Param('channelId') channelId: string, @Body() body: ChannelLeaveDto) {
    return this.service.leaveChannel(channelId, body);
  }

  @Post(':channelId/members/kick')
  kick(@Param('channelId') channelId: string, @Body() body: ChannelKickDto) {
    return this.service.kickMember(channelId, body);
  }

  @Post(':channelId/members/role')
  updateMemberRole(@Param('channelId') channelId: string, @Body() body: ChannelUpdateRoleDto) {
    return this.service.updateMemberRole(channelId, body);
  }

  @Post(':channelId/messages')
  async sendMessage(
    @Param('channelId') channelId: string,
    @Body() body: SendChannelMessageDto,
    @Res() res: any,
  ) {
    try {
      const result = await this.service.sendMessage(channelId, body);
      return res.json(result);
    } catch (err: any) {
      console.error('CONTROLLER SEND ERROR', err);
      return res.status(err.status || 500).json({ statusCode: err.status || 500, message: err.message || 'Internal server error', stack: err.stack });
    }
  }

  @Get(':channelId/messages')
  listMessages(@Param('channelId') channelId: string, @Query() query: GetChannelMessagesQuery) {
    const limit = query.limit ? Number(query.limit) : 100;
    return this.service.listMessages(channelId, query.userId, limit);
  }
}
