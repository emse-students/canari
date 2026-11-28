import { isIosTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * THE MAILBOX PASSWORD THE iOS NOTIFICATION EXTENSION READS (mail lot 5,
 * docs/wiki/mail-client-transport.md#as-built---lot-5).
 *
 * The empty mail push wakes the extension, which signs in to Partage itself (URLSession, system TLS)
 * to read the new mail's sender and subject, as Mail does. It has no page and no device key, so it
 * reads `{userId, account, password}` from ONE Keychain item shared through the App Group
 * (`mail_push_secret.rs`, AfterFirstUnlockThisDeviceOnly, never synchronised, never in a backup).
 *
 * WRITTEN only while every condition holds: the user ticked "remember" (D6), the account's
 * notifications are on, and `mail_push = cloudflare`. ERASED by {@link eraseMailPushSecret}, the ONE
 * erase, which every path that forgets the password reaches - `forgetMailPassword` (unticked, signed
 * out, refused, unopenable, every Canari sign-out), the notifications turned off, the switch moved to
 * `none`, D8, and the account's local wipe (`mail_watch_forget`). Without the item the extension shows
 * a generic "Nouveau mail" and says so in its log - a stated degraded display.
 *
 * A no-op everywhere but iOS. Neither function throws: a failure is logged, and the next fact that
 * changes the want writes or erases again.
 */

/** Writes the extension's copy of the password. */
export async function storeMailPushSecret(
  userId: string,
  account: string,
  password: string
): Promise<void> {
  if (!isIosTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('mail_push_secret_store', { userId, account, password });
    Log.i('MAIL-ALERT', "the notification extension's copy of the mailbox password is written");
  } catch (err) {
    Log.w(
      'MAIL-ALERT',
      `ERROR: the extension's copy of the password was not written (${String(err)})`
    );
  }
}

/** Erases the extension's copy of the password, whatever account it was for. Idempotent. */
export async function eraseMailPushSecret(reason: string): Promise<void> {
  if (!isIosTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('mail_push_secret_erase');
    Log.i('MAIL-ALERT', `the extension's copy of the mailbox password is erased (${reason})`);
  } catch (err) {
    Log.w(
      'MAIL-ALERT',
      `ERROR: the extension's copy of the password was not erased (${String(err)})`
    );
  }
}
