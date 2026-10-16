import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DELETED_ACCOUNT_ID } from './deleted-account';

const logger = new Logger('BookingsAccountDeletion');

/** What one account deletion did to the bookings tables, for the caller's log line. */
export interface BookingsDeletionOutcome {
  personalSpacesDeleted: number;
  comingBookingsCancelled: number;
  comingParticipationsWithdrawn: number;
}

/**
 * The bookings half of an account deletion (`InternalController.deleteUserData`), in ONE
 * transaction - see docs/wiki/bookings-chantier.md, "A deleted account".
 *
 * - A PERSONAL space it owns is deleted, with everything under it (D27): nobody else can manage it.
 *   A space of an association keeps living; its creator id becomes the tombstone.
 * - A COMING live booking it holds is cancelled, by the tombstone, which frees the slot; a coming
 *   participation is withdrawn. A deleted account will not come, and the slot is someone else's.
 * - The answers of every booking it held are purged now rather than N days after the slot (D18):
 *   they are its own data and nothing about the booking needs them any more.
 * - The HISTORY stays frozen (D15): every id it left (holder, booked by, cancelled by, participant,
 *   block author) becomes `DELETED_ACCOUNT_ID`, and the NAME SNAPSHOTS STAY - D15 says a deleted
 *   account leaves the name it had, and D19's one-year maximum age is what bounds them.
 * - A resource linked to it is unlinked (`linkedUserId` NULL): the link grants a view, not history.
 */
export async function deleteBookingsUserData(
  manager: EntityManager,
  userId: string
): Promise<BookingsDeletionOutcome> {
  logger.debug(`[INTERNAL_DELETE] bookings: start user=${userId}`);
  return manager.transaction(async (m) => {
    const count = (result: unknown) => (result as [unknown[], number])[1];
    const run = (sql: string) => m.query(sql, [userId, DELETED_ACCOUNT_ID]);

    const personalSpacesDeleted = count(
      await m.query(`DELETE FROM booking_spaces WHERE "associationId" IS NULL AND "ownerId" = $1`, [
        userId,
      ])
    );
    const comingBookingsCancelled = count(
      await run(
        `UPDATE bookings SET "cancelledAt" = now(), "cancelledById" = $2
          WHERE "holderId" = $1 AND "cancelledAt" IS NULL AND "startsAt" > now()`
      )
    );
    const comingParticipationsWithdrawn = count(
      await m.query(
        `UPDATE booking_participants p SET "withdrawnAt" = now()
           FROM bookings b
          WHERE b.id = p."bookingId" AND p."userId" = $1 AND p."withdrawnAt" IS NULL
            AND b."cancelledAt" IS NULL AND b."startsAt" > now()`,
        [userId]
      )
    );
    await m.query(
      `UPDATE bookings SET answers = NULL, "answersPurgedAt" = now()
        WHERE "holderId" = $1 AND answers IS NOT NULL`,
      [userId]
    );
    await run(`UPDATE booking_spaces SET "ownerId" = $2 WHERE "ownerId" = $1`);
    await run(`UPDATE bookings SET "holderId" = $2 WHERE "holderId" = $1`);
    await run(`UPDATE bookings SET "bookedById" = $2 WHERE "bookedById" = $1`);
    await run(`UPDATE bookings SET "cancelledById" = $2 WHERE "cancelledById" = $1`);
    await run(`UPDATE booking_participants SET "userId" = $2 WHERE "userId" = $1`);
    await run(`UPDATE booking_blocks SET "createdById" = $2 WHERE "createdById" = $1`);
    await m.query(`UPDATE booking_resources SET "linkedUserId" = NULL WHERE "linkedUserId" = $1`, [
      userId,
    ]);

    const outcome = {
      personalSpacesDeleted,
      comingBookingsCancelled,
      comingParticipationsWithdrawn,
    };
    logger.log(`[INTERNAL_DELETE] bookings: done user=${userId} ${JSON.stringify(outcome)}`);
    return outcome;
  });
}
