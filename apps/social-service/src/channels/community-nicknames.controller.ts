import { Body, Controller, Get, Headers, Param, Put, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { CommunityNicknamesService } from './community-nicknames.service';
import { SetCommunityNicknameDto } from './dto/community-nickname.dto';

/**
 * A community's nicknames ("Modifier les pseudos"). Under `channels/workspaces/...` with the rest of a
 * community's routes; the rules are the service's.
 */
@Controller('channels')
export class CommunityNicknamesController {
  constructor(private readonly nicknames: CommunityNicknamesService) {}

  /** Every nickname state of the community (set and cleared), for a member of it. */
  @UseGuards(NginxAuthGuard)
  @Get('workspaces/:workspaceId/nicknames')
  list(@Headers('x-user-id') xUserId: string, @Param('workspaceId') workspaceId: string) {
    return this.nicknames.list(workspaceId, xUserId.trim().toLowerCase());
  }

  /**
   * Sets `userId`'s nickname in the community - `{ nickname: string | null }`, a value empty once
   * normalized clearing it. A moderator names anybody; a member may clear their own.
   */
  @UseGuards(NginxAuthGuard)
  @Put('workspaces/:workspaceId/nicknames/:userId')
  set(
    @Headers('x-user-id') xUserId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() body: SetCommunityNicknameDto
  ) {
    return this.nicknames.set(workspaceId, xUserId, userId, body?.nickname ?? null);
  }
}
