import type { DataSource } from 'typeorm';

/** What a `register-device` call writes into a device's one static `key_package` row. */
export interface DeviceKeyPackageWrite {
  userId: string;
  deviceId: string;
  keyPackage: string;
  /** The package's own MLS lifetime end; `null` is written too, since it belongs to the payload. */
  notAfter: Date | null;
  /** `undefined` keeps what an existing row holds (the client did not say). */
  deviceName?: string;
  deviceOs?: string;
  deviceAppVersion?: string;
}

/**
 * Writes a device's static KeyPackage row in ONE statement, and answers whether it was created.
 *
 * THE READ-THEN-INSERT IT REPLACES RACED ITSELF. Production 2026-11-07 (`1.6.6`): two
 * `register-device` requests for one device started in the same millisecond, both read "no row",
 * both inserted, and the second insert hit `UNIQUE ("userId", "deviceId")` and answered 500. The
 * `ON CONFLICT` arm takes the existing row under the conflict's row lock, so two registrations of
 * one device serialise in the database: both succeed, one row remains, and the later one's package
 * is the one kept - exactly what two sequential calls left behind.
 *
 * THE SEMANTICS ARE THE ONES THE TWO BRANCHES HAD, column by column:
 * - `keyPackage` and `notAfter` are always overwritten, `notAfter` even with `null`: the date is a
 *   property of the package, and the previous package's date would refuse one that works;
 * - `deviceName`, `deviceOs` and `deviceAppVersion` are overwritten only when this call carries
 *   them (`COALESCE`): an absent field keeps what the row holds;
 * - `createdAt` is reset to now on every registration, deliberately: the device list's cutoff and
 *   `lastResortDeadline` read it as the enrolment's date (see `KeyPackage.notAfter`);
 * - `id` is `newId` only when the row is created; an existing row keeps its own.
 *
 * `inserted` comes from `xmax = 0`, which holds only for a row this statement created: an updated
 * row version carries the updating transaction's id there.
 */
export async function upsertDeviceKeyPackage(
  db: Pick<DataSource, 'query'>,
  write: DeviceKeyPackageWrite,
  newId: string,
  now: Date = new Date()
): Promise<{ inserted: boolean }> {
  const rows = (await db.query(
    `INSERT INTO key_package
       (id, "userId", "deviceId", "keyPackage", "notAfter", "deviceName", "deviceOs",
        "deviceAppVersion", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ("userId", "deviceId") DO UPDATE SET
       "keyPackage" = EXCLUDED."keyPackage",
       "notAfter" = EXCLUDED."notAfter",
       "deviceName" = COALESCE(EXCLUDED."deviceName", key_package."deviceName"),
       "deviceOs" = COALESCE(EXCLUDED."deviceOs", key_package."deviceOs"),
       "deviceAppVersion" = COALESCE(EXCLUDED."deviceAppVersion", key_package."deviceAppVersion"),
       "createdAt" = EXCLUDED."createdAt"
     RETURNING (xmax = 0) AS inserted`,
    [
      newId,
      write.userId,
      write.deviceId,
      write.keyPackage,
      write.notAfter,
      write.deviceName ?? null,
      write.deviceOs ?? null,
      write.deviceAppVersion ?? null,
      now,
    ]
  )) as Array<{ inserted: boolean }>;
  return { inserted: rows[0]?.inserted === true };
}
