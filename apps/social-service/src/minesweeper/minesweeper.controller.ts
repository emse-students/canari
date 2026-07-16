import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
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

  /** Caller's personal best, if any. */
  @Get('me')
  me(@Headers('x-user-id') userId: string) {
    return this.minesweeperService.me(userId);
  }
}
