import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { BanMinesweeperUserDto } from './dto/ban-minesweeper-user.dto';
import { SubmitMinesweeperDto } from './dto/submit-minesweeper.dto';
import { MinesweeperService } from './minesweeper.service';

/** Ranked Minesweeper API — challenges, verified submits, leaderboard. */
@Controller('minesweeper')
@UseGuards(NginxAuthGuard)
export class MinesweeperController {
  constructor(private readonly minesweeperService: MinesweeperService) {}

  /** Issues a seeded challenge; server clock starts here. */
  @Post('challenges')
  start(@Headers('x-user-id') userId: string) {
    return this.minesweeperService.startChallenge(userId);
  }

  /** Replays moves against the challenge seed; stores server-measured time if won. */
  @Post('challenges/:id/submit')
  submit(
    @Headers('x-user-id') userId: string,
    @Param('id') challengeId: string,
    @Body() dto: SubmitMinesweeperDto
  ) {
    return this.minesweeperService.submit(userId, challengeId, dto);
  }

  /** Best verified time per user, sorted ascending. */
  @Get('leaderboard')
  leaderboard(@Query('limit') limit?: string) {
    const n = limit ? Number.parseInt(limit, 10) : undefined;
    return this.minesweeperService.leaderboard(Number.isFinite(n) ? n : undefined);
  }

  /** Caller's personal best + rank, if any. */
  @Get('me')
  me(@Headers('x-user-id') userId: string) {
    return this.minesweeperService.me(userId);
  }

  /**
   * Public standing for a profile badge: personal best + rank, or null body fields
   * when the user has never submitted a verified clear.
   */
  @Get('users/:userId')
  async userStanding(@Param('userId') targetUserId: string) {
    const standing = await this.minesweeperService.userStanding(targetUserId);
    if (!standing) {
      return { personalBestMs: null as number | null, rank: null as number | null };
    }
    return standing;
  }

  // ---- Moderation: global admins only (`X-Global-Admin`, set by nginx from the JWT claim) ----

  /** Removes one verified score. The player keeps their others. */
  @Delete('scores/:scoreId')
  @UseGuards(GlobalAdminGuard)
  removeScore(
    @Headers('x-user-id') adminId: string,
    @Param('scoreId', ParseUUIDPipe) scoreId: string
  ) {
    return this.minesweeperService.removeScore(scoreId, adminId);
  }

  /** Everyone banned from the ranked game. */
  @Get('bans')
  @UseGuards(GlobalAdminGuard)
  listBans() {
    return this.minesweeperService.listBans();
  }

  /** Bans a user from the ranked game; their scores are kept, hidden, until the ban is lifted. */
  @Post('bans')
  @UseGuards(GlobalAdminGuard)
  ban(@Headers('x-user-id') adminId: string, @Body() dto: BanMinesweeperUserDto) {
    return this.minesweeperService.ban(dto.userId, dto.reason, adminId);
  }

  /** Lifts a ban. */
  @Delete('bans/:userId')
  @UseGuards(GlobalAdminGuard)
  unban(@Headers('x-user-id') adminId: string, @Param('userId') userId: string) {
    return this.minesweeperService.unban(userId, adminId);
  }
}
