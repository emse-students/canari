import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { sanitizeForLog } from '$lib/utils/logSanitize';

/**
 * The device ids this install ABANDONED by rotating its identity, still to be deleted server-side.
 *
 * A rotation (`BaseMlsService.rotateDeviceIdentity`) used to fire one best-effort delete for the old
 * id and forget it: a failure left a device on the account that nothing would ever retire. The id
 * is now RECORDED before the delete is asked, and leaves the record only once the server confirmed
 * it - so each abandoned id is retired exactly once, and a failure is retried at the next published
 * key-package round.
 *
 * AN ALLOWLIST, NOT A SWEEP: the record holds ids this install's own rotations wrote for this
 * account, and an entry equal to the live id is dropped and never deleted.
 */

/** What a retirement needs from the MLS service: who is signed in, the live id, and the delete. */
export interface RetirementTarget {
  userId: string;
  liveDeviceId: string;
  deleteDevice(userId: string, deviceId: string): Promise<{ status: string } | undefined>;
}

/**
 * The ids recorded for `userId`, or `[]` for an absent or unreadable record - an unreadable record
 * retires nothing, the safe direction for a list whose every entry is DELETED server-side.
 */
export function readAbandonedDeviceIds(userId: string): string[] {
  const raw = localStorage.getItem(ACCOUNT_KEY.retiringDeviceIds(userId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    console.error('[MLS] the abandoned-device record is unreadable - nothing retired from it');
    return [];
  }
}

function writeAbandonedDeviceIds(userId: string, ids: string[]): void {
  const key = ACCOUNT_KEY.retiringDeviceIds(userId);
  if (ids.length > 0) localStorage.setItem(key, JSON.stringify(ids));
  else localStorage.removeItem(key);
}

/** Records `deviceId` as abandoned by `userId`'s rotation on this install, BEFORE its delete is asked. */
export function recordAbandonedDevice(userId: string, deviceId: string): void {
  const ids = readAbandonedDeviceIds(userId);
  if (!ids.includes(deviceId)) ids.push(deviceId);
  writeAbandonedDeviceIds(userId, ids);
  console.log(`[MLS] abandoned device ${sanitizeForLog(deviceId)} recorded for retirement`);
}

/** The retirement in flight per account, so two callers never send the same deletes twice. */
const flights = new Map<string, Promise<void>>();

/**
 * Deletes, server-side, every recorded id of `target.userId` and removes each one the server
 * confirmed. Never throws: it is started and not awaited, and what it could not do stays recorded.
 */
export function retireAbandonedDevices(target: RetirementTarget): Promise<void> {
  const running = flights.get(target.userId);
  if (running) return running;
  const flight = (async () => {
    for (const id of readAbandonedDeviceIds(target.userId)) {
      if (id === target.liveDeviceId) {
        console.error(
          `[MLS] the abandoned-device record named the LIVE id ${sanitizeForLog(id)} - dropped, never deleted`
        );
      } else {
        let confirmed = false;
        try {
          const res = await target.deleteDevice(target.userId, id);
          confirmed = !!res && res.status !== 'error';
        } catch (e) {
          console.warn(
            `[MLS] retiring abandoned device ${sanitizeForLog(id)} failed: ${String(e)}`
          );
        }
        if (!confirmed) {
          console.warn(
            `[MLS] abandoned device ${sanitizeForLog(id)} not retired yet - kept, retried at the next published round`
          );
          continue;
        }
        console.log(`[MLS] abandoned device ${sanitizeForLog(id)} retired server-side`);
      }
      writeAbandonedDeviceIds(
        target.userId,
        readAbandonedDeviceIds(target.userId).filter((p) => p !== id)
      );
    }
  })().finally(() => flights.delete(target.userId));
  flights.set(target.userId, flight);
  return flight;
}
