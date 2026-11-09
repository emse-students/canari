import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * Every `[userId, deviceId]` this device recorded (`mls_device_id_<userId>`): the accounts that ever
 * signed in here and kept a device identity.
 */
export function recordedDeviceIds(): Array<[string, string]> {
  const DEVICE_ID_PREFIX = ACCOUNT_KEY.deviceId('');
  const pairs: Array<[string, string]> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith(DEVICE_ID_PREFIX)) continue;
      const userId = key.slice(DEVICE_ID_PREFIX.length);
      const deviceId = localStorage.getItem(key);
      if (userId && deviceId) pairs.push([userId, deviceId]);
    }
  } catch (e) {
    console.warn('[RESET] could not read the recorded device ids back:', e);
  }
  return pairs;
}

/**
 * Whether an account other than `userId` lives on this native install - THE ONE TEST both the
 * revoked device's wipe scope (`revokedWipeScope`) and the one-account wipe's seed-mirror step
 * (`wipeDeletedAccountLocalData`) ask.
 *
 * Present when the device recorded another account's device identity, or when the native side holds
 * another account's MLS state - parked, set aside, of unproven owner, or in the slot
 * (`mls_other_accounts_present`). An answer the native side cannot give is read as "present",
 * accused at ERROR: every caller then erases less, never another account's data.
 *
 * @param tag the caller's log tag, so its lines read as its own
 */
export async function otherAccountOnInstall(userId: string, tag: string): Promise<boolean> {
  const others = recordedDeviceIds().filter(([id]) => id !== userId);
  if (others.length > 0) {
    console.log(`${tag} ${others.length} other account(s) recorded on this install`);
    return true;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    if (await invoke<boolean>('mls_other_accounts_present', { userId })) {
      console.log(`${tag} another account's MLS state is on this install`);
      return true;
    }
  } catch (e) {
    console.error(
      `${tag} whether another account lives on this install could not be read - taken as present:`,
      e
    );
    return true;
  }
  return false;
}
