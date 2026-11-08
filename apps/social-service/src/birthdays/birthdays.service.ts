import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PARIS_TODAY_SQL, celebratedOnSql, parseBirthdayDate } from './birthday-date';
import { birthdayDateVisibleToSql, birthdayRingVisibleToSql } from './birthday-sql';
import {
  parseProfileFieldVisibility,
  type ProfileFieldVisibility,
} from './profile-field-visibility';

/** The member's own birthday, as their settings read and write it. */
export interface OwnBirthday {
  month: number;
  day: number;
  visibility: ProfileFieldVisibility;
}

/**
 * Another member's birthday as a viewer may read it: the date only when its visibility admits the
 * viewer, and `today` whatever it says (decision 3: on the day, everybody may wish it). A member who
 * entered nothing and one who hid it read the same - `birthday: null` - so a hidden date is not told
 * apart from an absent one.
 */
export interface ViewedBirthday {
  birthday: { month: number; day: number } | null;
  today: boolean;
}

/** Whose birthday it is today, for the ring every avatar draws: the Paris date, and the ids. */
export interface BirthdaysToday {
  /** `YYYY-MM-DD`, the Paris calendar date the server answered for. */
  date: string;
  userIds: string[];
}

/** The typed refusal code of a write whose body is not an object. */
export const BIRTHDAY_BODY_INVALID = 'BIRTHDAY_BODY_INVALID';

const short = (id: string) => id.slice(0, 8);

/**
 * BIRTHDAYS ON PROFILES (owner, 2026-11-08; docs/wiki/birthdays.md): the member's own date and its
 * visibility, another member's date as the viewer may read it, and whose birthday it is today.
 * Every read applies the rule in SQL, in the statement that reads the date: no date leaves this
 * service unless that statement admitted the viewer.
 */
@Injectable()
export class BirthdaysService {
  private readonly logger = new Logger(BirthdaysService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** The caller's own birthday and its visibility, or `null` when they entered none. */
  async mine(userId: string): Promise<OwnBirthday | null> {
    const [row] = (await this.ds.query(
      `SELECT month, day, visibility FROM profile_birthdays WHERE "userId" = $1`,
      [userId]
    )) as OwnBirthday[];
    this.logger.debug(`[BIRTHDAY] own read user=${short(userId)} set=${row !== undefined}`);
    return row ? { month: row.month, day: row.day, visibility: row.visibility } : null;
  }

  /**
   * Writes the caller's birthday - the date and the visibility, ONE statement, idempotent. A body
   * without a visibility keeps the stored one, or takes the default (`followers`) on a first write.
   */
  async setMine(userId: string, body: unknown): Promise<OwnBirthday> {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({ code: BIRTHDAY_BODY_INVALID, message: 'body required' });
    }
    const raw = body as { month?: unknown; day?: unknown; visibility?: unknown };
    const { month, day } = parseBirthdayDate(raw.month, raw.day);
    const visibility =
      raw.visibility === undefined ? null : parseProfileFieldVisibility(raw.visibility);
    const [row] = (await this.ds.query(
      `INSERT INTO profile_birthdays ("userId", month, day, visibility)
       VALUES ($1, $2, $3, COALESCE($4, 'followers'))
       ON CONFLICT ("userId") DO UPDATE SET month = EXCLUDED.month, day = EXCLUDED.day,
         visibility = COALESCE($4, profile_birthdays.visibility), "updatedAt" = now()
       RETURNING month, day, visibility`,
      [userId, month, day, visibility]
    )) as OwnBirthday[];
    // Never the date itself in a log line: it is the member's personal data.
    this.logger.log(`[BIRTHDAY] set user=${short(userId)} visibility=${row.visibility}`);
    return { month: row.month, day: row.day, visibility: row.visibility };
  }

  /** Removes the caller's birthday: no date, no ring, no notice. Idempotent. */
  async clearMine(userId: string): Promise<void> {
    await this.ds.query(`DELETE FROM profile_birthdays WHERE "userId" = $1`, [userId]);
    this.logger.log(`[BIRTHDAY] cleared user=${short(userId)}`);
  }

  /**
   * `userId`'s birthday as `viewerId` may read it, in ONE statement: the date only when
   * {@link birthdayDateVisibleToSql} admits the viewer, `today` when the ring may be shown to them
   * ({@link birthdayRingVisibleToSql}) and the date is celebrated on today's Paris date.
   */
  async ofUser(viewerId: string, userId: string): Promise<ViewedBirthday> {
    const [row] = (await this.ds.query(
      `SELECT CASE WHEN ${birthdayDateVisibleToSql('b', '$1')} THEN b.month END AS month,
              CASE WHEN ${birthdayDateVisibleToSql('b', '$1')} THEN b.day END AS day,
              (${celebratedOnSql('b.month', 'b.day', PARIS_TODAY_SQL)}
                AND ${birthdayRingVisibleToSql('b."userId"', '$1')}) AS today
         FROM profile_birthdays b WHERE b."userId" = $2`,
      [viewerId, userId]
    )) as Array<{ month: number | null; day: number | null; today: boolean }>;
    const birthday =
      row && row.month !== null && row.day !== null ? { month: row.month, day: row.day } : null;
    const today = row?.today === true;
    this.logger.debug(
      `[BIRTHDAY] read of ${short(userId)} by ${short(viewerId)}: date=${birthday !== null} today=${today}`
    );
    return { birthday, today };
  }

  /**
   * Whose birthday it is on today's Paris date, among the accounts whose ring `viewerId` may see -
   * the whole school's celebrants of the day, a handful of ids. The date is the server's answer, so
   * a client never decides "today" from its own clock.
   */
  async today(viewerId: string): Promise<BirthdaysToday> {
    const rows = (await this.ds.query(
      `SELECT to_char(${PARIS_TODAY_SQL}, 'YYYY-MM-DD') AS date, b."userId" AS "userId"
         FROM (SELECT 1) one
         LEFT JOIN profile_birthdays b
           ON ${celebratedOnSql('b.month', 'b.day', PARIS_TODAY_SQL)}
          AND ${birthdayRingVisibleToSql('b."userId"', '$1')}
        ORDER BY b."userId"`,
      [viewerId]
    )) as Array<{ date: string; userId: string | null }>;
    const userIds = rows.map((r) => r.userId).filter((id): id is string => id !== null);
    this.logger.debug(
      `[BIRTHDAY] today for ${short(viewerId)}: ${userIds.length} celebrant(s) on ${rows[0].date}`
    );
    return { date: rows[0].date, userIds };
  }
}
