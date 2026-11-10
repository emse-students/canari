import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { NOTIFICATIONS_TARGET } from '../push/push-target';
import { acceptedFollowSql } from '../follows/follow-status';
import {
  BIRTHDAY_CHANGE_WINDOW_DAYS,
  BIRTHDAY_TIME_ZONE,
  PARIS_HOUR_SQL,
  PARIS_TODAY_SQL,
  celebratedOnSql,
  dateInEffectSql,
  noticeOpenSql,
} from './birthday-date';
import { birthdayDateVisibleToSql } from './birthday-sql';
import { categoryOffSql } from '../push/notification-category';
import { BIRTHDAY_NOTIFICATION } from './birthday-notification';

const TAG = '[BIRTHDAY_NOTICE]';

/** The Paris hour from which a day's birthdays are announced: the morning (decision 4). */
export const BIRTHDAY_NOTICE_FROM_HOUR = 8;

const short = (id: string) => id.slice(0, 8);

/** The Paris date and hour one tick works with, read ONCE from the database's clock. */
export interface BirthdayClock {
  /** `YYYY-MM-DD`. */
  today: string;
  hour: number;
}

/** What one tick did, for its line and for the tests. */
export interface BirthdayNoticeTick {
  today: string;
  /** Celebrants of the day not yet claimed when the tick read them. */
  due: number;
  /** Celebrants this tick claimed (announced to zero or more followers). */
  claimed: number;
  /** Followers told, over every claim. */
  told: number;
  /** Celebrants whose claim failed - retried by the next tick, the claim never committed. */
  failed: number;
  /** `birthday_changes` rows past their 30-day window, deleted by this tick. */
  purged: number;
}

/**
 * THE MORNING NOTICE "C'est l'anniversaire de X" (decision 4, owner 2026-11-08): on the day, the
 * member's ACCEPTED followers who may read the date are told - in the bell, and by a push in the
 * `birthdays` category, which each reader may switch off in the notification settings.
 *
 * WHEN: every hour at :13, from {@link BIRTHDAY_NOTICE_FROM_HOUR} Paris time to the end of the day,
 * on the DATABASE's clock. The first tick of the morning announces the day; the later ones find
 * nothing left, or catch up what a restart or a failed claim left over. A day that ends with the
 * service down announces nothing late: the notice says "today".
 *
 * IDEMPOTENT FROM STATE, NEVER FROM A CLOCK: a celebrant is announced by CLAIMING - a conditional
 * `UPDATE profile_birthdays SET "lastAnnouncedOn" = today` that only a row never announced, or last
 * announced `BIRTHDAY_NOTICE_EVERY_DAYS` days or more before, passes - in the SAME transaction
 * that writes the followers' bell rows: both commit or neither does. A second tick or replica waits
 * on the row lock, re-reads the row, and fails the condition; a failure commits nothing and the next
 * tick tries again. The 300 days also make a MOVED date announce nothing twice in a year, and a date
 * set today is not announced today (`dateInEffectSql`). The push follows the commit, best-effort
 * like every push, through the same mapping, bell and fan-out as every notice.
 *
 * Each tick also deletes the `birthday_changes` rows whose 30-day window has closed: the only thing
 * that row is for (`BirthdaysService.setMine`), so it is kept no longer.
 *
 * ONE JOB PER CELEBRANT, EACH CAUGHT AND LOGGED: one celebrant that fails never stops the others.
 */
@Injectable()
export class BirthdayNotifier {
  private readonly logger = new Logger(BirthdayNotifier.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notifications: PostNotificationsService
  ) {}

  /** Hourly at :13 - off the minutes the other hourly jobs of this service use. */
  @Cron('13 * * * *')
  async tick(): Promise<void> {
    try {
      await this.announceDue();
    } catch (e) {
      this.logger.error(`${TAG} the tick failed - nothing was claimed by it: ${String(e)}`);
    }
  }

  /** Today's Paris date and hour, on the database's clock. */
  async clock(): Promise<BirthdayClock> {
    const [row] = (await this.ds.query(
      `SELECT to_char(${PARIS_TODAY_SQL}, 'YYYY-MM-DD') AS today, ${PARIS_HOUR_SQL} AS hour`
    )) as BirthdayClock[];
    return row;
  }

  /**
   * One tick: before the morning, nothing; from it, every celebrant of `clock.today` not claimed
   * yet is claimed and announced. `clock` is read from the database unless a test hands one in.
   */
  async announceDue(clock?: BirthdayClock): Promise<BirthdayNoticeTick> {
    const { today, hour } = clock ?? (await this.clock());
    const tick: BirthdayNoticeTick = { today, due: 0, claimed: 0, told: 0, failed: 0, purged: 0 };
    tick.purged = await this.purgeChanges(today);
    if (hour < BIRTHDAY_NOTICE_FROM_HOUR) {
      this.logger.debug(`${TAG} ${today} ${hour}h: before the morning, nothing to do`);
      return tick;
    }
    const due = (await this.ds.query(
      `SELECT b."userId" AS "userId" FROM profile_birthdays b
        WHERE ${celebratedOnSql('b.month', 'b.day', '$1::date')}
          AND ${dateInEffectSql('b', '$1::date')}
          AND ${noticeOpenSql('b', '$1::date')}
        ORDER BY b."userId"`,
      [today]
    )) as Array<{ userId: string }>;
    tick.due = due.length;
    for (const { userId } of due) {
      try {
        const told = await this.announceOne(userId, today);
        if (told !== null) {
          tick.claimed += 1;
          tick.told += told;
        }
      } catch (e) {
        tick.failed += 1;
        this.logger.warn(
          `${TAG} ${today} celebrant=${short(userId)} not announced, retried next tick: ${String(e)}`
        );
      }
    }
    // One line per tick that had work, even when every claim was lost to another replica: the
    // count of the day is how a reader of the log knows the notice ran.
    if (tick.due > 0) {
      const line = `${TAG} ${today} due=${tick.due} claimed=${tick.claimed} told=${tick.told} failed=${tick.failed}`;
      if (tick.failed > 0) this.logger.warn(line);
      else this.logger.log(line);
    }
    return tick;
  }

  /**
   * Empties what `birthday_changes` no longer needs by `today` (Paris) - a `changedAt` whose 30-day
   * window closed, a `noticeOpensOn` reached - and deletes the rows left empty. Answers how many rows
   * were deleted. Caught here, so a failed purge never stops the notices; the next tick retries it.
   */
  private async purgeChanges(today: string): Promise<number> {
    try {
      // Two statements, one transaction: a statement may not delete a row its own CTE updated.
      const purged = await this.ds.transaction(async (m) => {
        await m.query(
          `UPDATE birthday_changes SET
             "changedAt" = CASE WHEN ("changedAt" AT TIME ZONE '${BIRTHDAY_TIME_ZONE}')::date
               + ${BIRTHDAY_CHANGE_WINDOW_DAYS} <= $1::date THEN NULL ELSE "changedAt" END,
             "noticeOpensOn" = CASE WHEN "noticeOpensOn" <= $1::date THEN NULL
               ELSE "noticeOpensOn" END
            WHERE ("changedAt" AT TIME ZONE '${BIRTHDAY_TIME_ZONE}')::date
               + ${BIRTHDAY_CHANGE_WINDOW_DAYS} <= $1::date
               OR "noticeOpensOn" <= $1::date`,
          [today]
        );
        const [, deleted] = (await m.query(
          `DELETE FROM birthday_changes WHERE "changedAt" IS NULL AND "noticeOpensOn" IS NULL`
        )) as [unknown[], number];
        return deleted;
      });
      if (purged > 0)
        this.logger.log(
          `${TAG} ${today} emptied ${purged} birthday_changes row(s) no longer needed`
        );
      return purged;
    } catch (e) {
      this.logger.error(
        `${TAG} ${today} the change-window purge failed, retried next tick: ${String(e)}`
      );
      return 0;
    }
  }

  /**
   * Claims `userId`'s notice for `today` and writes the bell rows of the followers who may read the
   * date, in ONE transaction, then pushes them. Answers how many were told, or `null` when the claim
   * was already taken (another tick or replica announced it).
   */
  private async announceOne(userId: string, today: string): Promise<number | null> {
    const actorName = await this.notifications.resolveActorName(userId);
    const recipients = await this.ds.transaction(async (m) => {
      // The claim re-checks everything the due list read, on the row it locks: a date moved or
      // cleared since, or a claim another tick committed, fails it.
      const [claimed] = (await m.query(
        `UPDATE profile_birthdays b SET "lastAnnouncedOn" = $2::date
          WHERE b."userId" = $1
            AND ${celebratedOnSql('b.month', 'b.day', '$2::date')}
            AND ${dateInEffectSql('b', '$2::date')}
            AND ${noticeOpenSql('b', '$2::date')}
          RETURNING b."userId"`,
        [userId, today]
      )) as [unknown[], number];
      if (claimed.length === 0) return null;
      // The member's accepted followers whom the date's visibility admits - `nobody` reaches no one,
      // `school` and `followers` reach every accepted follower with no block and on the same side
      // of the review cohort. Read in the claim's transaction: what is told is what was claimed.
      // A follower who switched Anniversaires off gets no bell row ("Nos principes", 2026-11-10).
      const rows = (await m.query(
        `SELECT f."followerUserId" AS id FROM user_follows f
           JOIN profile_birthdays b ON b."userId" = f."followedUserId"
          WHERE f."followedUserId" = $1 AND ${acceptedFollowSql('f')}
            AND ${birthdayDateVisibleToSql('b', 'f."followerUserId"')}
            AND NOT ${categoryOffSql('f."followerUserId"', `'birthdays'`)}
          ORDER BY f."followerUserId"`,
        [userId]
      )) as Array<{ id: string }>;
      const ids = rows.map((r) => r.id).filter((id) => id !== userId);
      if (ids.length > 0) {
        // A birthday names no post: the member's id stands in the required column, as a follow
        // notice does, and the row opens the member's profile (`notificationHref`).
        await m.save(
          PostNotification,
          ids.map((recipientId) =>
            m.create(PostNotification, {
              recipientId,
              type: BIRTHDAY_NOTIFICATION,
              postId: userId,
              actorId: userId,
              actorName,
              text: '',
            })
          )
        );
      }
      return ids;
    });
    if (recipients === null) {
      this.logger.debug(`${TAG} ${today} celebrant=${short(userId)} already announced`);
      return null;
    }
    if (recipients.length > 0) {
      // After the commit, so a failure here is NOT retried: the claim and the bell rows stand, and
      // a second push would be the duplicate the claim exists to prevent. Said at error, with the
      // count, because the only trace of a lost push is this line.
      await this.notifications
        .pushNotice({
          recipientIds: recipients,
          type: BIRTHDAY_NOTIFICATION,
          actorId: userId,
          actorName,
          text: '',
          pushData: { target: NOTIFICATIONS_TARGET },
        })
        .catch((e: unknown) => {
          this.logger.error(
            `${TAG} ${today} celebrant=${short(userId)} bell rows written, push NOT sent to ` +
              `${recipients.length} follower(s): ${String(e)}`
          );
        });
    }
    this.logger.log(
      `${TAG} ${today} celebrant=${short(userId)} announced to ${recipients.length} follower(s)`
    );
    return recipients.length;
  }
}
