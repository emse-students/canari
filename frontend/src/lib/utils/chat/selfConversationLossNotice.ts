import { SELF_CONVERSATION_VERSION } from '$lib/mls-client/mlsDeliveryApi';
import { Log } from '$lib/utils/Log';

/**
 * Whether "Mes notes" must say that losing this device loses the notes (owner, 2026-11-22, charter
 * principle 2, *l'essentiel ne se perd pas*): `single` while ONE device holds them - the notes are
 * end-to-end encrypted (principle 1), so no server copy can bring them back, and only another
 * device or a `.canari` backup can. `several` once another device holds them too.
 *
 * `unknown` when either read failed: a failure is not an answer, so nothing is said either way and
 * the line says why (the next open reads it again).
 */
export type SelfConversationDeviceCover = 'single' | 'several' | 'unknown';

/**
 * The two reads the cover is decided on: the account's active devices, WITHOUT claiming any key
 * package (`listUserDevices`, a peek), and the devices SEATED in the notes group (`getGroupMembers`).
 */
export interface SelfConversationCoverReads {
  listDevices: () => Promise<readonly { deviceId: string; selfConversationVersion: number }[]>;
  listSeatedDevices: () => Promise<readonly { deviceId: string }[]>;
}

/**
 * Answers {@link SelfConversationDeviceCover} from the devices that HOLD the notes: active, of a
 * build that knows "Mes notes" (`selfConversationVersion >= SELF_CONVERSATION_VERSION` - an older
 * build is never given the group, so it is no copy), and seated in the group. A second device
 * that merely exists is not a copy: counting it would silence the notice while one device holds
 * everything.
 */
export async function readSelfConversationDeviceCover(
  reads: SelfConversationCoverReads
): Promise<SelfConversationDeviceCover> {
  Log.d('SelfNotes', 'reading the devices holding the notes for the loss notice');
  try {
    const [devices, seated] = await Promise.all([reads.listDevices(), reads.listSeatedDevices()]);
    const seatedIds = new Set(seated.map((d) => d.deviceId));
    const holders = devices.filter(
      (d) => d.selfConversationVersion >= SELF_CONVERSATION_VERSION && seatedIds.has(d.deviceId)
    );
    const cover: SelfConversationDeviceCover = holders.length <= 1 ? 'single' : 'several';
    Log.d(
      'SelfNotes',
      `account devices=${devices.length} seated=${seatedIds.size} holders=${holders.length} -> loss notice ${cover === 'single'}`
    );
    return cover;
  } catch (e) {
    Log.w(
      'SelfNotes',
      `device list or seats unreadable - the loss notice says nothing this time: ${String(e).slice(0, 120)}`
    );
    return 'unknown';
  }
}
