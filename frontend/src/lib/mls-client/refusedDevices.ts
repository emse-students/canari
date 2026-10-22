import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { sanitizeForLog } from '$lib/utils/logSanitize';
import type { DeviceTrustRefusedError } from './deviceTrust';

/**
 * The devices THIS device refused to add because their signature key changed under a pinned id -
 * remembered, so no sweep fetches (and spends) another of their one-time KeyPackages to be refused
 * again.
 *
 * A KEY CHANGE UNDER A KEPT ID IS A REFUSAL NO RETRY CAN LIFT. Every KeyPackage of a device carries
 * the same signature key, so the next fetch is refused for the same reason, and the pin it is refused
 * by stays as long as the device is in a tree this device holds. What lifts it is the device's owner:
 * a device that lost its state re-enrols under a NEW id at start-up, and a new id is not in this
 * record. Nothing else is remembered here - an `identity-mismatch` is a package the server chose, and
 * the next fetch may well be the right one.
 *
 * Keyed by this device as well as the account: the pins live in this device's MLS state, and a
 * rotation to a new id starts both over.
 */

/** Past this many entries the oldest are dropped - each one is a refusal, so this is never reached. */
const MAX_REFUSED_DEVICES = 256;

function storageKey(ownUserId: string, ownDeviceId: string): string {
  return ACCOUNT_KEY.refusedDevices(ownUserId, ownDeviceId);
}

/** `userId:deviceId` as the pin reads it: the user half case-insensitive, the device half exact. */
function identityOf(userId: string, deviceId: string): string {
  return `${userId.toLowerCase()}:${deviceId}`;
}

function readRefused(ownUserId: string, ownDeviceId: string): string[] {
  const raw = localStorage.getItem(storageKey(ownUserId, ownDeviceId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // An unreadable record re-fetches - the cost is a KeyPackage, never an Add the pin would allow.
    console.error('[TRUST] the refused-device record is unreadable - read as empty');
    return [];
  }
}

/**
 * Whether `userId:deviceId` was refused for a changed key by this device - the caller then does not
 * fetch a KeyPackage for it at all.
 */
export function isRefusedDevice(
  own: { userId: string; deviceId: string },
  userId: string,
  deviceId: string
): boolean {
  return readRefused(own.userId, own.deviceId).includes(identityOf(userId, deviceId));
}

/**
 * Remembers a refusal when no retry can lift it (`signature-key-changed`); any other reason is left
 * to the next sweep.
 *
 * @returns whether the refusal was recorded.
 */
export function recordRefusedDevice(
  own: { userId: string; deviceId: string },
  error: DeviceTrustRefusedError
): boolean {
  if (error.reason !== 'signature-key-changed') return false;
  const identity = identityOf(error.userId, error.deviceId);
  const refused = readRefused(own.userId, own.deviceId).filter((id) => id !== identity);
  refused.push(identity);
  while (refused.length > MAX_REFUSED_DEVICES) refused.shift();
  localStorage.setItem(storageKey(own.userId, own.deviceId), JSON.stringify(refused));
  console.warn(
    `[TRUST] ${sanitizeForLog(identity)} remembered as refused - no KeyPackage is fetched for it again`
  );
  return true;
}

/** The skips this session already reported, so a sweep says each one once. */
const reportedSkips = new Set<string>();

/**
 * Logs that a remembered device was skipped - at `warn` once per device per session, at `debug`
 * after. The line names the one remedy, so whoever reads it knows which actor can lift it.
 */
export function reportRefusedDeviceSkipped(
  tag: string,
  groupId: string,
  userId: string,
  deviceId: string
): void {
  const identity = identityOf(userId, deviceId);
  const line =
    `${tag} ${sanitizeForLog(identity)} is not added to ${groupId.slice(0, 8)}...: its key changed ` +
    `under a pinned id - its owner resets that device, which then re-enrols under a new id`;
  if (reportedSkips.has(identity)) {
    console.debug(line);
    return;
  }
  reportedSkips.add(identity);
  console.warn(line);
}

/** Test seam: forgets which skips were already reported. */
export function resetReportedRefusedDeviceSkips(): void {
  reportedSkips.clear();
}
