import * as crypto from 'crypto';
import type { DataSource } from 'typeorm';
import type { RevocationReason } from '../entities/revoked-device.entity';
import type { MessagingService } from '../services/messaging.service';
import { upsertRevocation } from './revocation';

/** What one revocation removed and recorded - the counts every caller logs. */
export interface DeviceRevocation {
  /** The footprint {@link MessagingService.purgeDeviceFootprint} deleted. */
  purge: Awaited<ReturnType<MessagingService['purgeDeviceFootprint']>>;
  /** The cause the ban row holds now: an owner's active ban is never downgraded to `retired`. */
  recordedReason: RevocationReason;
  /** Whether a connected device was told through `device_revoked`. */
  signalled: boolean;
}

/**
 * REVOKES ONE DEVICE THE WAY THE PRODUCT DOES - the one sequence behind `DELETE
 * /api/mls/devices/:userId/:deviceId` and the retired-device reaper, so the two cannot drift:
 *
 * 1. purge the device's whole footprint (seats, Redis routing set, key packages, one-time key
 *    packages, push tokens, queue), recording the key groups it held - its rows were the binding
 *    the revoked-leaves question reads;
 * 2. ban the id in `revoked_device` with its cause, merged in ONE statement ({@link upsertRevocation})
 *    so nothing re-adds it - this row is the durable state every later decision reads;
 * 3. tell the device now if it is connected.
 *
 * Ending the device's sessions is NOT here: only an owner's revocation does that, and the route
 * keeps it, after this, because its failure answers 503 to a person. A `retired` revocation ends
 * none.
 */
export async function revokeDevice(
  messaging: Pick<MessagingService, 'purgeDeviceFootprint' | 'notifyDeviceRevoked'>,
  db: Pick<DataSource, 'query'>,
  userId: string,
  deviceId: string,
  reason: RevocationReason
): Promise<DeviceRevocation> {
  const purge = await messaging.purgeDeviceFootprint(userId, deviceId, {
    recordKeyGroupsHeld: true,
  });
  const recordedReason = await upsertRevocation(db, userId, deviceId, reason, crypto.randomUUID());
  const signalled = await messaging.notifyDeviceRevoked(userId, deviceId);
  return { purge, recordedReason, signalled };
}
