import { MoreThan } from 'typeorm';
import type { DataSource, FindOperator } from 'typeorm';
import { DEVICE_REVOCATION_TTL_MS } from '../retention.constants';
import type { RevokedDevice, RevocationReason } from '../entities/revoked-device.entity';
import { RefusalCode, refusalBody } from './refusal-codes';

/**
 * The one place that decides whether a `revoked_device` row still answers "is this device banned".
 *
 * Six call sites ask that question - key-package resolution, device registration, the device list,
 * two invitation paths and `deviceAddressability` - and a rule spread over six sites is six chances
 * to disagree. It is expressed as a `where` fragment rather than a predicate so the bound is applied
 * by the DATABASE: filtering in memory would still load every expired row, and the list endpoints
 * read whole users' worth of them.
 *
 * NOT every read of the table is this question. Re-revoking a device asks "have I already recorded
 * this", which has no age at all - a row is a row - and using the ban window there would insert a
 * duplicate the unique constraint then rejects. Same shape as every other durable-state trap: the
 * row answers only the question it was written to answer.
 */
export function activeRevocationCutoff(now: number = Date.now()): Date {
  return new Date(now - DEVICE_REVOCATION_TTL_MS);
}

/**
 * Adds the ban window to a `revoked_device` lookup.
 *
 * @param criteria - the identity being asked about (`{ userId }`, `{ userId, deviceId }`, ...)
 * @returns the same criteria, restricted to revocations that have not expired
 */
export function activeRevocationWhere<T extends object>(
  criteria: T
): T & { revokedAt: FindOperator<Date> } {
  return { ...criteria, revokedAt: MoreThan(activeRevocationCutoff()) };
}

/**
 * Who banned the id a row names. A NULL - a row written before migration 040 recorded the cause - is
 * read as `'owner'`: of the two readings it is the one that ends the holder's session and wipes it,
 * rather than letting a device its owner may have disowned enrol again.
 */
export function revocationReasonOf(row: Pick<RevokedDevice, 'reason'>): RevocationReason {
  return row.reason === 'retired' ? 'retired' : 'owner';
}

/**
 * Records a ban on `userId`/`deviceId` with its cause, in ONE statement, and answers the cause
 * that was recorded.
 *
 * THE OWNER'S CAUSE WINS AND IS NEVER DOWNGRADED: a row whose ban is still active and was the
 * owner's (or unknown, see {@link revocationReasonOf}) stays the owner's whatever the new call
 * says - otherwise a disowned device could delete its own id as "retired" and enrol again. A lapsed
 * row starts over with the new cause, like its date does. The merge is the `CASE` of the
 * `ON CONFLICT` arm, which reads the EXISTING row under the conflict's row lock, so two deletes
 * racing on one id cannot both read "no owner" and the retired one win - which a read followed by a
 * save allowed.
 *
 * Re-revoking restarts the ban's date, as it always has. `newId` is used only when no row exists.
 */
export async function upsertRevocation(
  db: Pick<DataSource, 'query'>,
  userId: string,
  deviceId: string,
  incoming: RevocationReason,
  newId: string,
  now: number = Date.now()
): Promise<RevocationReason> {
  const rows = (await db.query(
    `INSERT INTO revoked_device (id, "userId", "deviceId", "revokedAt", reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ("userId", "deviceId") DO UPDATE SET
       "revokedAt" = EXCLUDED."revokedAt",
       reason = CASE
         WHEN EXCLUDED.reason = 'owner' THEN 'owner'
         WHEN revoked_device."revokedAt" > $6
              AND (revoked_device.reason IS NULL OR revoked_device.reason <> 'retired') THEN 'owner'
         ELSE EXCLUDED.reason
       END
     RETURNING reason`,
    [newId, userId, deviceId, new Date(now), incoming, activeRevocationCutoff(now)]
  )) as Array<{ reason: string | null }>;
  return rows[0]?.reason === 'retired' ? 'retired' : 'owner';
}

/**
 * The refusal of a device-creating call (`register-device`, the prekey upload) for a banned id,
 * typed by WHO banned it - a client must never learn which by reading prose:
 *
 * - `'retired'`: `DEVICE_REVOKED` + `reason: 'retired'`, the code every client already answers by
 *   enrolling under a fresh id - which is right, the id was abandoned by its own install;
 * - `'owner'`: `DEVICE_REVOKED_BY_OWNER`, which a current client answers by wiping and signing out,
 *   and which a client older than the code does not recognise - so it reads a plain refusal and does
 *   NOT re-enrol, the safe direction for a code it cannot know.
 */
export function revokedDeviceRefusal(
  reason: RevocationReason
): ReturnType<typeof refusalBody> & { reason: RevocationReason } {
  return reason === 'retired'
    ? {
        ...refusalBody(
          RefusalCode.DEVICE_REVOKED,
          'This device id was retired by its own install. Enrol again under a new device id.'
        ),
        reason,
      }
    : {
        ...refusalBody(
          RefusalCode.DEVICE_REVOKED_BY_OWNER,
          'This device was revoked by its owner. Sign out and erase the local state.'
        ),
        reason,
      };
}
