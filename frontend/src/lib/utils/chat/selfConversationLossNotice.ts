import { Log } from '$lib/utils/Log';

/**
 * Whether "Mes notes" must say that losing this device loses the notes (owner, 2026-11-22, charter
 * principle 2, *l'essentiel ne se perd pas*): `single` while the account has ONE device - the notes
 * are end-to-end encrypted (principle 1), so no server copy can bring them back, and only another
 * device or a `.canari` backup can. `several` once another device holds them too.
 *
 * `unknown` when the device list could not be read: a failure is not an answer, so nothing is said
 * either way and the line says why (the next open reads it again).
 */
export type SelfConversationDeviceCover = 'single' | 'several' | 'unknown';

/**
 * Reads the account's device roster WITHOUT claiming any key package (`listUserDevices`, a peek)
 * and answers {@link SelfConversationDeviceCover}.
 *
 * @param listDevices the peek read of the account's active devices.
 */
export async function readSelfConversationDeviceCover(
  listDevices: () => Promise<readonly { deviceId: string }[]>
): Promise<SelfConversationDeviceCover> {
  Log.d('SelfNotes', 'reading the account device count for the loss notice');
  try {
    const devices = await listDevices();
    const cover: SelfConversationDeviceCover = devices.length <= 1 ? 'single' : 'several';
    Log.d('SelfNotes', `account devices=${devices.length} -> loss notice ${cover === 'single'}`);
    return cover;
  } catch (e) {
    Log.w(
      'SelfNotes',
      `device list unreadable - the loss notice says nothing this time: ${String(e).slice(0, 120)}`
    );
    return 'unknown';
  }
}
