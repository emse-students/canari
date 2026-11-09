import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  BIRTHDAY_CHANGE_WINDOW_DAYS,
  BIRTHDAY_NOTICE_EVERY_DAYS,
  BIRTHDAY_TIME_ZONE,
  PARIS_TODAY_SQL,
  celebratedTodaySql,
  parseBirthdayDate,
} from './birthday-date';
import { birthdayDateVisibleToSql, birthdayRingVisibleToSql } from './birthday-sql';
import {
  parseProfileFieldVisibility,
  type ProfileFieldVisibility,
} from './profile-field-visibility';

/** A day and a month. */
interface BirthdayDate {
  month: number;
  day: number;
}

/** The member's own birthday, as their settings read and write it. */
export interface OwnBirthday {
  month: number;
  day: number;
  visibility: ProfileFieldVisibility;
}

/** The member's own state, as the settings read it: the date, and when a new date is accepted. */
export interface OwnBirthdayState {
  birthday: OwnBirthday | null;
  /** `YYYY-MM-DD`: the first Paris date a NEW date is accepted, or `null` when one is now. */
  changeOpensOn: string | null;
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

/**
 * The typed refusal (409) of a NEW date within {@link BIRTHDAY_CHANGE_WINDOW_DAYS} days of the
 * last one - a clear then a set counting as a change. The body carries `opensOn`, the first Paris
 * date a new one is accepted. The settings already show it from `changeOpensOn`, so the refusal is
 * only what a race between two devices meets.
 */
export const BIRTHDAY_CHANGE_TOO_SOON = 'BIRTHDAY_CHANGE_TOO_SOON';

/** SQL: the Paris date of a `birthday_changes` row `c`'s last set. */
const CHANGED_ON_SQL = `(c."changedAt" AT TIME ZONE '${BIRTHDAY_TIME_ZONE}')::date`;

/** SQL: the first Paris date a new date is accepted, from a `birthday_changes` row `c`. */
const CHANGE_OPENS_ON_SQL = `(${CHANGED_ON_SQL} + ${BIRTHDAY_CHANGE_WINDOW_DAYS})`;

/**
 * SQL, `$1` the member: the first Paris date a new date is accepted, when a new one is refused
 * today. A date set TODAY keeps the window open for corrections the same day (a typo, or a clear
 * then a set): it buys nothing, since a date set today counts from tomorrow, and the window still
 * runs from the first set of the day.
 */
const CHANGE_OPENS_ON_QUERY = `SELECT to_char(${CHANGE_OPENS_ON_SQL}, 'YYYY-MM-DD') AS "opensOn"
   FROM birthday_changes c
  WHERE c."userId" = $1 AND c."changedAt" IS NOT NULL
    AND ${CHANGED_ON_SQL} < ${PARIS_TODAY_SQL}
    AND ${CHANGE_OPENS_ON_SQL} > ${PARIS_TODAY_SQL}`;

/** SQL, `$1` the member: the transaction-scoped lock every write of their birthday takes. */
const MEMBER_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('profile_birthdays:' || $1, 0))`;

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
   * The caller's date and when a NEW date is accepted (`null`: now). The window is read from
   * `birthday_changes`, which says when a date was last set and never which.
   */
  async state(userId: string): Promise<OwnBirthdayState> {
    const birthday = await this.mine(userId);
    const [row] = (await this.ds.query(CHANGE_OPENS_ON_QUERY, [userId])) as Array<{
      opensOn: string;
    }>;
    return { birthday, changeOpensOn: row?.opensOn ?? null };
  }

  /**
   * Writes the caller's birthday - the date and the visibility - and answers the state it leaves.
   * A body without a visibility keeps the stored one, or takes the default (`followers`) on a first
   * write. A visibility edit is always accepted; a NEW date (a first one, a move, or a set after a
   * clear) is refused `409 BIRTHDAY_CHANGE_TOO_SOON` within {@link BIRTHDAY_CHANGE_WINDOW_DAYS}
   * days of the last one - a correction the same Paris day as that one excepted, which keeps the
   * window - and takes effect from the next Paris day (`dateSetAt`). Serialised per member by a
   * transaction-scoped advisory lock, so two devices cannot both pass the window.
   */
  async setMine(userId: string, body: unknown): Promise<OwnBirthdayState> {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({ code: BIRTHDAY_BODY_INVALID, message: 'body required' });
    }
    const raw = body as { month?: unknown; day?: unknown; visibility?: unknown };
    const { month, day } = parseBirthdayDate(raw.month, raw.day);
    const visibility =
      raw.visibility === undefined ? null : parseProfileFieldVisibility(raw.visibility);
    const isNewDate = await this.ds.transaction(async (m) => {
      await m.query(MEMBER_LOCK_SQL, [userId]);
      const [stored] = (await m.query(
        `SELECT month, day FROM profile_birthdays WHERE "userId" = $1`,
        [userId]
      )) as BirthdayDate[];
      const newDate = !stored || stored.month !== month || stored.day !== day;
      if (newDate) {
        const [recent] = (await m.query(CHANGE_OPENS_ON_QUERY, [userId])) as Array<{
          opensOn: string;
        }>;
        if (recent) {
          this.logger.log(
            `[BIRTHDAY] new date refused user=${short(userId)}: one was set within ` +
              `${BIRTHDAY_CHANGE_WINDOW_DAYS} days, opens ${recent.opensOn}`
          );
          throw new ConflictException({
            code: BIRTHDAY_CHANGE_TOO_SOON,
            opensOn: recent.opensOn,
            message: `a new date is accepted from ${recent.opensOn}`,
          });
        }
        // A correction the same Paris day keeps the day's first `changedAt`: the window is not
        // restarted. `noticeOpensOn`, if a clear kept one, is left as it is.
        await m.query(
          `INSERT INTO birthday_changes AS c ("userId", "changedAt") VALUES ($1, now())
           ON CONFLICT ("userId") DO UPDATE SET "changedAt" = CASE
             WHEN c."changedAt" IS NOT NULL AND ${CHANGED_ON_SQL} = ${PARIS_TODAY_SQL}
             THEN c."changedAt" ELSE now() END`,
          [userId]
        );
      }
      // `dateSetAt` moves only with the date; `lastAnnouncedOn` never moves here, so a moved date
      // still waits out the 300 days since the last notice.
      await m.query(
        `INSERT INTO profile_birthdays ("userId", month, day, visibility, "dateSetAt")
         VALUES ($1, $2, $3, COALESCE($4, 'followers'), now())
         ON CONFLICT ("userId") DO UPDATE SET month = EXCLUDED.month, day = EXCLUDED.day,
           visibility = COALESCE($4, profile_birthdays.visibility),
           "dateSetAt" = CASE WHEN $5::boolean THEN now() ELSE profile_birthdays."dateSetAt" END,
           "updatedAt" = now()`,
        [userId, month, day, visibility, newDate]
      );
      return newDate;
    });
    // Never the date itself in a log line: it is the member's personal data.
    this.logger.log(`[BIRTHDAY] set user=${short(userId)} newDate=${isNewDate}`);
    return this.state(userId);
  }

  /**
   * Removes the caller's birthday - the date and its visibility go with the row: no date, no ring,
   * no notice. Always accepted, idempotent. What stays, in `birthday_changes`, never names the date:
   * when one was last set (a set right after still counts as a change), and, when the date was
   * announced less than 300 days ago, `noticeOpensOn = lastAnnouncedOn + 300` - no new date is
   * announced or ringed before it, so a clear then a set buys no notice the 300 days refuse. The
   * notifier's hourly job empties each once it passes (lead decision, L23 amended).
   */
  async clearMine(userId: string): Promise<OwnBirthdayState> {
    const kept = await this.ds.transaction(async (m) => {
      await m.query(MEMBER_LOCK_SQL, [userId]);
      const rows = (await m.query(
        `WITH gone AS (
           DELETE FROM profile_birthdays WHERE "userId" = $1 RETURNING "lastAnnouncedOn"
         )
         INSERT INTO birthday_changes AS c ("userId", "noticeOpensOn")
         SELECT $1, g."lastAnnouncedOn" + ${BIRTHDAY_NOTICE_EVERY_DAYS} FROM gone g
          WHERE g."lastAnnouncedOn" + ${BIRTHDAY_NOTICE_EVERY_DAYS} > ${PARIS_TODAY_SQL}
         ON CONFLICT ("userId") DO UPDATE
           SET "noticeOpensOn" = GREATEST(c."noticeOpensOn", EXCLUDED."noticeOpensOn")
         RETURNING c."userId"`,
        [userId]
      )) as unknown[];
      return rows.length > 0;
    });
    this.logger.log(`[BIRTHDAY] cleared user=${short(userId)} noticeGateKept=${kept}`);
    return this.state(userId);
  }

  /**
   * `userId`'s birthday as `viewerId` may read it, in ONE statement: the date only when
   * {@link birthdayDateVisibleToSql} admits the viewer, `today` when the ring may be shown to them
   * ({@link birthdayRingVisibleToSql}) and the date is celebrated today ({@link celebratedTodaySql}:
   * its day, set before today, and today's notice sent or still possible).
   */
  async ofUser(viewerId: string, userId: string): Promise<ViewedBirthday> {
    const [row] = (await this.ds.query(
      `SELECT CASE WHEN ${birthdayDateVisibleToSql('b', '$1')} THEN b.month END AS month,
              CASE WHEN ${birthdayDateVisibleToSql('b', '$1')} THEN b.day END AS day,
              (${celebratedTodaySql('b', PARIS_TODAY_SQL)}
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
   * the whole school's celebrants of the day, a handful of ids; a date set today is not among them.
   * The date is the server's answer, so a client never decides "today" from its own clock.
   */
  async today(viewerId: string): Promise<BirthdaysToday> {
    const rows = (await this.ds.query(
      `SELECT to_char(${PARIS_TODAY_SQL}, 'YYYY-MM-DD') AS date, b."userId" AS "userId"
         FROM (SELECT 1) one
         LEFT JOIN profile_birthdays b
           ON ${celebratedTodaySql('b', PARIS_TODAY_SQL)}
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
