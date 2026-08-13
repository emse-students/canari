import { MoreThan } from 'typeorm';
import type { FindOperator } from 'typeorm';
import { DEVICE_REVOCATION_TTL_MS } from '../retention.constants';

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
