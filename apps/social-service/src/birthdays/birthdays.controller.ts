import { Body, Controller, Delete, Get, Headers, Param, Put, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import {
  BirthdaysService,
  type BirthdaysToday,
  type OwnBirthdayState,
  type ViewedBirthday,
} from './birthdays.service';

/**
 * BIRTHDAYS ON PROFILES (owner, 2026-11-08; docs/wiki/birthdays.md). Under `/api/posts/...`, beside
 * the follow routes the visibility rule reads; each path has a literal segment no post route uses.
 *
 * - `GET|PUT|DELETE me/birthday`: the caller's own date and visibility (the header, never an id).
 * - `GET users/:userId/birthday`: another member's, as the caller may read it.
 * - `GET birthdays/today`: whose ring to draw today.
 */
@Controller('posts')
@UseGuards(NginxAuthGuard)
export class BirthdaysController {
  constructor(private readonly birthdays: BirthdaysService) {}

  /** `{ birthday: { month, day, visibility } | null, changeOpensOn: 'YYYY-MM-DD' | null }`. */
  @Get('me/birthday')
  mine(@Headers('x-user-id') userId: string): Promise<OwnBirthdayState> {
    return this.birthdays.state(userId);
  }

  /**
   * `{ month, day, visibility? }` - 400 `BIRTHDAY_DATE_INVALID` for a date no calendar has, 400
   * `PROFILE_FIELD_VISIBILITY_INVALID` for a visibility outside the three, 409
   * `BIRTHDAY_CHANGE_TOO_SOON` (with `opensOn`) for a new date within 30 days of the last one.
   * Answers the state it leaves. Idempotent.
   */
  @Put('me/birthday')
  set(@Headers('x-user-id') userId: string, @Body() body: unknown): Promise<OwnBirthdayState> {
    return this.birthdays.setMine(userId, body);
  }

  /** Removes the caller's birthday; always accepted, idempotent. Answers the state it leaves. */
  @Delete('me/birthday')
  clear(@Headers('x-user-id') userId: string): Promise<OwnBirthdayState> {
    return this.birthdays.clearMine(userId);
  }

  /** `{ birthday: { month, day } | null, today }` as the caller may read it. */
  @Get('users/:userId/birthday')
  ofUser(
    @Headers('x-user-id') viewerId: string,
    @Param('userId') userId: string
  ): Promise<ViewedBirthday> {
    return this.birthdays.ofUser(viewerId, userId);
  }

  /** `{ date, userIds }`: today's Paris date and the members whose ring the caller may see. */
  @Get('birthdays/today')
  today(@Headers('x-user-id') viewerId: string): Promise<BirthdaysToday> {
    return this.birthdays.today(viewerId);
  }
}
