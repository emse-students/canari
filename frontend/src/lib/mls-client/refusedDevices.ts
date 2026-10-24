import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { sanitizeForLog } from '$lib/utils/logSanitize';
import type { DeviceTrustRefusedError } from './deviceTrust';
import type { IMlsService } from './IMlsService';
import { canonicalUserId } from './leafIdentity';

/**
 * The devices THIS device refused to add because their signature key changed under a pinned id -
 * remembered, so no sweep fetches (and spends) another of their one-time KeyPackages to be refused
 * again.
 *
 * A KEY CHANGE UNDER A KEPT ID IS A REFUSAL NO RETRY CAN LIFT - when the device really changed key:
 * every package it has carries the new key, and the pin stays. What lifts it then is the device's
 * owner: a device that lost its state re-enrols under a NEW id at start-up, and a new id is not in
 * this record. But ONE FORGED PACKAGE served for the device produces the very same refusal, so an
 * entry is also lifted by a fact that disproves the change:
 * - the device was shown holding its PINNED key by a commit merged since the refusal (its leaf
 *   re-entering a tree under that key, or a commit it signed) - the pin's `reaffirmations` count
 *   moved past the one recorded with the entry;
 * - its pin is gone (pruned): nothing is left to refuse it by.
 *
 * Nothing else is remembered here - an `identity-mismatch` is a package the server chose, and the
 * next fetch may well be the right one. Keyed by this device as well as the account: the pins live
 * in this device's MLS state, and a rotation to a new id drops the old id's record
 * ({@link forgetRefusedDevicesOf}).
 */

/** Past this many entries the oldest are dropped - each one is a refusal, so this is never reached. */
const MAX_REFUSED_DEVICES = 256;

/** The own device a record belongs to. */
interface OwnDevice {
  userId: string;
  deviceId: string;
}

/** One remembered refusal: the device, and its pin's reaffirmation count at the refusal. */
interface RefusedEntry {
  identity: string;
  reaffirmations: number;
}

/** `userId:deviceId` as the pin reads it: the one canonical identity (`canonicalUserId`). */
function identityOf(userId: string, deviceId: string): string {
  return `${canonicalUserId(userId)}:${deviceId}`;
}

function readRefused(own: OwnDevice): RefusedEntry[] {
  const raw = localStorage.getItem(ACCOUNT_KEY.refusedDevices(own.userId, own.deviceId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is RefusedEntry =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as RefusedEntry).identity === 'string' &&
        typeof (v as RefusedEntry).reaffirmations === 'number'
    );
  } catch {
    // An unreadable record re-fetches - the cost is a KeyPackage, never an Add the pin would allow.
    console.error('[TRUST] the refused-device record is unreadable - read as empty');
    return [];
  }
}

function writeRefused(own: OwnDevice, entries: RefusedEntry[]): void {
  const key = ACCOUNT_KEY.refusedDevices(own.userId, own.deviceId);
  if (entries.length > 0) localStorage.setItem(key, JSON.stringify(entries));
  else localStorage.removeItem(key);
}

/**
 * Every device this device remembers as refused, as `userId:deviceId` (canonical, `canonicalUserId`),
 * oldest first - what the owner's in-app notice of a refused device of their own is built from
 * (`deviceNotices.svelte.ts`). An entry {@link isRefusedDevice} lifted is no longer listed.
 */
export function listRefusedDevices(own: OwnDevice): string[] {
  return readRefused(own).map((e) => e.identity);
}

/** Who is told when a refusal is recorded; one listener, the new-device notices. */
let refusalListener: ((identity: string) => void) | null = null;

/**
 * Registers the one listener told of every refusal {@link recordRefusedDevice} records (`null`
 * removes it). A listener that throws is logged and costs only its own notice.
 */
export function setRefusedDeviceListener(listener: ((identity: string) => void) | null): void {
  refusalListener = listener;
}

/**
 * Whether `userId:deviceId` stays refused for a changed key by this device - the caller then does
 * not fetch a KeyPackage for it at all. An entry a later fact disproves (see the module doc) is
 * LIFTED here, with a line saying why, and the device is fetched again.
 */
export async function isRefusedDevice(
  own: OwnDevice,
  userId: string,
  deviceId: string,
  mls: Pick<IMlsService, 'pinnedSignatureKeys'>
): Promise<boolean> {
  const identity = identityOf(userId, deviceId);
  const entries = readRefused(own);
  const entry = entries.find((e) => e.identity === identity);
  if (!entry) return false;
  const pin = await mls.pinnedSignatureKeys(userId, deviceId);
  if (pin !== null && pin.reaffirmations <= entry.reaffirmations) return true;
  writeRefused(
    own,
    entries.filter((e) => e.identity !== identity)
  );
  console.info(
    pin === null
      ? `[TRUST] ${sanitizeForLog(identity)} no longer refused - its pin was pruned`
      : `[TRUST] ${sanitizeForLog(identity)} no longer refused - a merged commit showed it holding its pinned key since`
  );
  return false;
}

/**
 * Remembers a refusal when no retry is expected to lift it (`signature-key-changed`), with the pin's
 * reaffirmation count at that moment; any other reason is left to the next sweep. The listener
 * ({@link setRefusedDeviceListener}) is told of the refusal.
 *
 * @returns whether the refusal was recorded.
 */
export async function recordRefusedDevice(
  own: OwnDevice,
  error: DeviceTrustRefusedError,
  mls: Pick<IMlsService, 'pinnedSignatureKeys'>
): Promise<boolean> {
  if (error.reason !== 'signature-key-changed') return false;
  const pin = await mls.pinnedSignatureKeys(error.userId, error.deviceId);
  if (pin === null) {
    // No pin, nothing to have refused by: the refusal cannot be repeated, so it is not remembered.
    console.warn(
      `[TRUST] ${sanitizeForLog(error.userId)}:${sanitizeForLog(error.deviceId)} refused but has no pin - not remembered`
    );
    return false;
  }
  const identity = identityOf(error.userId, error.deviceId);
  const entries = readRefused(own).filter((e) => e.identity !== identity);
  entries.push({ identity, reaffirmations: pin.reaffirmations });
  while (entries.length > MAX_REFUSED_DEVICES) entries.shift();
  writeRefused(own, entries);
  console.warn(
    `[TRUST] ${sanitizeForLog(identity)} remembered as refused - no KeyPackage is fetched for it ` +
      `until it is shown holding its pinned key or its pin goes`
  );
  if (refusalListener) {
    try {
      refusalListener(identity);
    } catch (e) {
      console.error('[TRUST] the refused-device listener failed - no notice for this refusal:', e);
    }
  }
  return true;
}

/** Drops the whole record an OWN device id kept - called when this install rotates away from it. */
export function forgetRefusedDevicesOf(own: OwnDevice): void {
  localStorage.removeItem(ACCOUNT_KEY.refusedDevices(own.userId, own.deviceId));
}

/** The skips this session already reported, so a sweep says each one once. */
const reportedSkips = new Set<string>();

/**
 * Logs that a remembered device was skipped - at `warn` once per device per session, at `debug`
 * after. The line names the remedy, so whoever reads it knows which actor can lift it.
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
