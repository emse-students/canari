import { SvelteMap } from 'svelte/reactivity';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { Log } from '$lib/utils/Log';

/**
 * "NOTIFICATIONS DE NOUVEAUX MAILS" - ONE SWITCH PER ACCOUNT, PER DEVICE, OFF BY DEFAULT
 * (owner, 2026-11-27; docs/wiki/mail-client.md D11, charter principle 3: switched off in one gesture).
 *
 * Per DEVICE because what it costs is the device's: on Android a persistent connection and a
 * notification that stays shown, on an iPhone a background refresh. Kept in `localStorage` under the
 * account (`ACCOUNT_KEY.mailNotifications`), one of the D8 keys - a closed mailbox forgets it too.
 * Reactive: the controller (`mailWatch.svelte.ts`) and the settings row read the same value.
 */

const values = new SvelteMap<string, boolean>();

/** Whether `userId` wants new-mail notifications on this device. */
export function mailNotificationsWanted(userId: string, store: Storage = localStorage): boolean {
  const known = values.get(userId);
  if (known !== undefined) return known;
  let on = false;
  try {
    on = store.getItem(ACCOUNT_KEY.mailNotifications(userId)) === '1';
  } catch (err) {
    Log.w('MAIL-WATCH', `ERROR: the switch could not be read - treated as off (${String(err)})`);
  }
  values.set(userId, on);
  return on;
}

/** Turns `userId`'s switch on or off on this device. */
export function setMailNotificationsWanted(
  userId: string,
  on: boolean,
  store: Storage = localStorage
): void {
  Log.i('MAIL-WATCH', `new-mail notifications switched ${on ? 'on' : 'off'}`);
  if (on) store.setItem(ACCOUNT_KEY.mailNotifications(userId), '1');
  else store.removeItem(ACCOUNT_KEY.mailNotifications(userId));
  values.set(userId, on);
}

/**
 * Forgets what this module read for `userId` - the D8 erasure removed the key underneath it, so the
 * next read is the storage's (off).
 */
export function forgetMailNotificationsSwitch(userId: string): void {
  values.delete(userId);
  persistent.delete(userId);
}

/**
 * "CONNEXION PERMANENTE" - ANDROID ONLY, AND ONLY WHILE `mail_push = cloudflare` (mail lot 5, owner
 * 2026-11-28): the account may ALSO keep lot 4's persistent connection - no server at all, at a
 * battery cost - beside the fast path. Off by default; with `mail_push = none` the persistent
 * connection is what the main switch already turns on, so this one is not read. Per account and per
 * device (`ACCOUNT_KEY.mailPersistentConnection`), one of the D8 keys.
 */
const persistent = new SvelteMap<string, boolean>();

/** Whether `userId` keeps the persistent connection on this device beside the fast path. */
export function mailPersistentWanted(userId: string, store: Storage = localStorage): boolean {
  const known = persistent.get(userId);
  if (known !== undefined) return known;
  let on = false;
  try {
    on = store.getItem(ACCOUNT_KEY.mailPersistentConnection(userId)) === '1';
  } catch (err) {
    Log.w(
      'MAIL-WATCH',
      `ERROR: the persistent switch could not be read - treated as off (${String(err)})`
    );
  }
  persistent.set(userId, on);
  return on;
}

/** Turns `userId`'s persistent connection on or off on this device. */
export function setMailPersistentWanted(
  userId: string,
  on: boolean,
  store: Storage = localStorage
): void {
  Log.i('MAIL-WATCH', `persistent connection switched ${on ? 'on' : 'off'}`);
  if (on) store.setItem(ACCOUNT_KEY.mailPersistentConnection(userId), '1');
  else store.removeItem(ACCOUNT_KEY.mailPersistentConnection(userId));
  persistent.set(userId, on);
}
