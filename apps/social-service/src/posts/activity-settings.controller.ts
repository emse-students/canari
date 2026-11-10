import { Body, Controller, Get, Headers, Injectable, Logger, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { ActivitySettingsDto } from './dto/post.dto';

/** Reads of the caller's own activity setting per minute: the settings screen asks once per opening. */
export const ACTIVITY_SETTINGS_READS_PER_MINUTE = 60;
/** Writes of it per minute: a person flips a switch, a loop is stopped. */
export const ACTIVITY_SETTINGS_WRITES_PER_MINUTE = 10;

/**
 * "SHARE MY ACTIVITY" (engagement decision 9, WP-9): whether the person's reactions and comments
 * are told to their accepted followers (friends' activity, `friend-activity.ts`). ONE row per person
 * who chose, `user_activity_settings`; no row is ON. Turning it off stops every notice not yet sent
 * - the disclosure statement reads the row at each write - and retracts none already sent.
 */
@Injectable()
export class ActivitySettingsService {
  private readonly logger = new Logger(ActivitySettingsService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** The caller's setting; no row is the default, ON. */
  async read(userId: string): Promise<{ shareActivity: boolean }> {
    const rows: { shareActivity: boolean }[] = await this.db.query(
      `SELECT "shareActivity" FROM user_activity_settings WHERE "userId" = $1`,
      [userId]
    );
    return { shareActivity: rows[0]?.shareActivity ?? true };
  }

  /** Sets it, and answers what is now stored. */
  async write(userId: string, shareActivity: boolean): Promise<{ shareActivity: boolean }> {
    const rows: { shareActivity: boolean }[] = await this.db.query(
      `INSERT INTO user_activity_settings ("userId", "shareActivity", "updatedAt") VALUES ($1, $2, now())
         ON CONFLICT ("userId") DO UPDATE SET "shareActivity" = EXCLUDED."shareActivity", "updatedAt" = now()
       RETURNING "shareActivity"`,
      [userId, shareActivity]
    );
    this.logger.log(`[ACTIVITY] ${userId.slice(0, 8)} shareActivity=${shareActivity}`);
    return { shareActivity: rows[0].shareActivity };
  }
}

/** The caller's own activity setting, under `/api/posts/me/...`: the header names the person, never the URL. */
@Controller('posts')
@UseGuards(NginxAuthGuard)
export class ActivitySettingsController {
  constructor(private readonly settings: ActivitySettingsService) {}

  @Get('me/activity-settings')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: ACTIVITY_SETTINGS_READS_PER_MINUTE, ttl: 60_000 } })
  mine(@Headers('x-user-id') xUserId: string) {
    return this.settings.read(xUserId);
  }

  @Put('me/activity-settings')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: ACTIVITY_SETTINGS_WRITES_PER_MINUTE, ttl: 60_000 } })
  setMine(@Headers('x-user-id') xUserId: string, @Body() body: ActivitySettingsDto) {
    return this.settings.write(xUserId, body.shareActivity);
  }
}
