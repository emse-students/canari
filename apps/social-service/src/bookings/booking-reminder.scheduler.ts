import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DELETED_ACCOUNT } from '../internal/account-erasure';
import {
  BookingNotificationsService,
  reminderAssociation,
  reminderLine,
} from './booking-notifications.service';
import { Booking } from './entities/booking.entity';

/** How many reminders one claim takes; a run loops until nothing is due. */
const BATCH = 200;

const TAG = '[BOOKING_REMINDER]';

/** One claimed reminder: who, which booking, and what the line says. */
interface ClaimedReminder {
  recipientId: string;
  bookingId: string;
  startsAt: Date | string;
  spaceName: string;
  resourceName: string;
  discoverability: string;
  timeZone: string;
  /** The owning association, when the space has one (null for a personal space). */
  associationId: string | null;
  associationName: string | null;
  associationLogoUrl: string | null;
}

/** What one run did, for the test and the log line. */
export interface BookingReminderReport {
  claimed: number;
  sent: number;
  failed: number;
}

/**
 * Who is owed a reminder, as one predicate per table over DURABLE columns (WP-N, D53, Q-R1, Q-R6):
 * a person with a delay ("reminderMinutes" not NULL), not yet reminded ("reminderSentAt" NULL), on
 * a live booking (not cancelled; a participant not withdrawn) whose slot has NOT started and whose
 * reminder instant ("startsAt" minus the delay) has come - and was still to come when the delay
 * was chosen ("reminderSetAt" before it): a booking made inside its delay gets none (Q-R6), and so
 * does a delay lengthened past the instant. The tombstone of an erased account is never reminded.
 */
const DUE_HOLDERS = `
  SELECT b.id AS "bookingId", b."holderId" AS "recipientId", b."startsAt",
         s.name AS "spaceName", r.name AS "resourceName", s.discoverability, s."timeZone",
         s."associationId", a.name AS "associationName", a."logoUrl" AS "associationLogoUrl"
    FROM bookings b
    JOIN booking_resources r ON r.id = b."resourceId"
    JOIN booking_spaces s ON s.id = r."spaceId"
    LEFT JOIN associations a ON a.id = s."associationId"
   WHERE b."reminderSentAt" IS NULL AND b."reminderMinutes" IS NOT NULL AND b."cancelledAt" IS NULL
     AND b."startsAt" > $1::timestamptz
     AND b."startsAt" - make_interval(mins => b."reminderMinutes") <= $1::timestamptz
     AND b."reminderSetAt" < b."startsAt" - make_interval(mins => b."reminderMinutes")
     AND b."holderId" <> $2
   ORDER BY b."startsAt" ASC
   LIMIT $3
   FOR UPDATE OF b SKIP LOCKED`;

const DUE_PARTICIPANTS = `
  SELECT p.id AS "rowId", b.id AS "bookingId", p."userId" AS "recipientId", b."startsAt",
         s.name AS "spaceName", r.name AS "resourceName", s.discoverability, s."timeZone",
         s."associationId", a.name AS "associationName", a."logoUrl" AS "associationLogoUrl"
    FROM booking_participants p
    JOIN bookings b ON b.id = p."bookingId"
    JOIN booking_resources r ON r.id = b."resourceId"
    JOIN booking_spaces s ON s.id = r."spaceId"
    LEFT JOIN associations a ON a.id = s."associationId"
   WHERE p."reminderSentAt" IS NULL AND p."reminderMinutes" IS NOT NULL AND p."withdrawnAt" IS NULL
     AND b."cancelledAt" IS NULL
     AND b."startsAt" > $1::timestamptz
     AND b."startsAt" - make_interval(mins => p."reminderMinutes") <= $1::timestamptz
     AND p."reminderSetAt" < b."startsAt" - make_interval(mins => p."reminderMinutes")
     AND p."userId" <> $2
   ORDER BY b."startsAt" ASC
   LIMIT $3
   FOR UPDATE OF p SKIP LOCKED`;

/**
 * THE BOOKINGS REMINDER (WP-N, D53): every minute, each person owed a reminder is sent ONE.
 *
 * THE CLAIM IS THE ROW, NOT A CLOCK: each batch is selected `FOR UPDATE SKIP LOCKED` and stamped
 * `reminderSentAt` in the same transaction, which commits BEFORE anything is sent. Two replicas, or
 * a run that overlaps the previous one, cannot both claim a row; a second run finds nothing (the
 * reference test runs it twice and counts one notice). The cost, deliberately the forms reminder's
 * (`forms-reminder.scheduler.ts`): a crash between the commit and the send loses that reminder -
 * at most once, never twice.
 *
 * Off with the bookings notices' switch (`BOOKING_NOTIFICATIONS_ENABLED`): nothing is claimed,
 * so turning it on later does not send a backlog of reminders whose instant has passed - only the
 * slots not yet started, inside their delay, are still due.
 */
@Injectable()
export class BookingReminderScheduler {
  private readonly logger = new Logger(BookingReminderScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    private readonly notices: BookingNotificationsService
  ) {}

  /** Every minute: the finest delay is five minutes, and a minute late is inside it. */
  @Cron('* * * * *')
  async remindDue(): Promise<void> {
    if (!this.notices.enabled) return;
    if (this.running) {
      this.logger.warn(`${TAG} the previous run is still going - this tick is skipped`);
      return;
    }
    this.running = true;
    try {
      await this.remindOnce();
    } catch (e) {
      this.logger.warn(`${TAG} run failed before it could finish - retried next minute`, e);
    } finally {
      this.running = false;
    }
  }

  /**
   * One run, separated so a test can call it without a scheduler or the switch.
   *
   * @param at The instant to judge at; omitted, the database's `NOW()`.
   */
  async remindOnce(at?: Date): Promise<BookingReminderReport> {
    const now = at ?? (await this.databaseNow());
    const report: BookingReminderReport = { claimed: 0, sent: 0, failed: 0 };
    for (const table of ['bookings', 'booking_participants'] as const) {
      for (;;) {
        const batch = await this.claim(table, now);
        report.claimed += batch.length;
        for (const row of batch) {
          // Each in its own `try`: one recipient that fails does not silence the batch.
          try {
            const line = reminderLine(row, new Date(row.startsAt), row.timeZone);
            await this.notices.remind(
              row.recipientId,
              row.bookingId,
              line,
              reminderAssociation(row)
            );
            report.sent += 1;
          } catch (e) {
            report.failed += 1;
            this.logger.error(
              `${TAG} booking=${row.bookingId.slice(0, 8)} to=${row.recipientId.slice(0, 8)} claimed and NOT sent: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
        if (batch.length < BATCH) break;
      }
    }
    if (report.claimed > 0) {
      this.logger.log(
        `${TAG} claimed=${report.claimed} sent=${report.sent} failed=${report.failed}`
      );
    }
    return report;
  }

  /** Selects and stamps one batch of `table` in one transaction, committed before any send. */
  private async claim(
    table: 'bookings' | 'booking_participants',
    now: Date
  ): Promise<ClaimedReminder[]> {
    return this.bookings.manager.transaction(async (tx) => {
      const due = (await tx.query(table === 'bookings' ? DUE_HOLDERS : DUE_PARTICIPANTS, [
        now,
        DELETED_ACCOUNT,
        BATCH,
      ])) as (ClaimedReminder & { rowId?: string })[];
      if (due.length === 0) return [];
      const ids = due.map((r) => (table === 'bookings' ? r.bookingId : r.rowId));
      await tx.query(
        `UPDATE ${table} SET "reminderSentAt" = $2::timestamptz
          WHERE id = ANY($1::uuid[]) AND "reminderSentAt" IS NULL`,
        [ids, now]
      );
      return due;
    });
  }

  /** PostgreSQL's clock - the one the predicates are written against. */
  private async databaseNow(): Promise<Date> {
    const [{ now }] = (await this.bookings.query(`SELECT NOW() AS now`)) as Array<{
      now: Date | string;
    }>;
    return new Date(now);
  }
}
