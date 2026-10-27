/**
 * The groups THIS DEVICE once held the MLS state of, and dropped - what decides which door its
 * recovery may take (`requestReAdd` in `recovery.ts`, 2026-10-27).
 *
 * A device that held a group and lost its state (a fork, a refusal, a demotion) comes back by its
 * own external commit: its owner's account let it in once. A device that never held the group and
 * whose owner already has a device in it is a FURTHER device of a member, and its first entry is a
 * member's Add after a member's tap - never its own commit. The server's row cannot tell the two
 * apart: every demotion clears the admission it carried. This record is written where the state is
 * dropped (`dropGroupState`), so it is the device's own fact and nothing on the server can erase it.
 *
 * Keyed by the DEVICE id: a rotation mints a new id, which never held anything and starts empty.
 * Bounded: a device past {@link MAX_HELD_GROUPS} drops the oldest entries, and a group dropped
 * from the record only costs its device a member's tap on the next recovery, never its access.
 */

import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/** The most groups recorded per device; past it the oldest are dropped. */
export const MAX_HELD_GROUPS = 4096;

function read(deviceId: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(ACCOUNT_KEY.heldGroups(deviceId));
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Falls through to the accusing line: an unreadable record is not an empty one.
  }
  console.error(
    `[MLS] the held-groups record of this device is unreadable - every recovery asks a member`
  );
  return [];
}

/**
 * Records that this device held `groupId` and is dropping it. Idempotent; never throws (a drop is
 * part of a larger repair, and a record it cannot write costs only a member's tap later).
 */
export function recordHeldGroup(deviceId: string, groupId: string): void {
  if (typeof localStorage === 'undefined' || deviceId === '') return;
  try {
    const held = read(deviceId);
    if (held.includes(groupId)) return;
    held.push(groupId);
    const kept = held.length > MAX_HELD_GROUPS ? held.slice(held.length - MAX_HELD_GROUPS) : held;
    if (kept.length < held.length) {
      console.warn(
        `[MLS] held-groups record full (${MAX_HELD_GROUPS}) - the oldest ${held.length - kept.length} dropped`
      );
    }
    localStorage.setItem(ACCOUNT_KEY.heldGroups(deviceId), JSON.stringify(kept));
  } catch (e) {
    console.error(`[MLS] recording a held group FAILED: ${String(e)}`);
  }
}

/** Whether this device once held `groupId` ({@link recordHeldGroup}). */
export function onceHeldGroup(deviceId: string, groupId: string): boolean {
  return read(deviceId).includes(groupId);
}
