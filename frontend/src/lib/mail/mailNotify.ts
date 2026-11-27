import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { postAndroidMailNotice } from '$lib/mobile/androidMailWatch';
import { mailAppLink } from '$lib/mobile/deepLinkRoutes';
import { m } from '$lib/paraglide/messages';
import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { internalPath } from '$lib/utils/internalPath';
import { Log } from '$lib/utils/Log';
import { stableNotifId } from '$lib/utils/stableNotifId';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';
import { itemNumber } from './mailWatchCursor';
import type { NewMail } from './mailWatcher';

/**
 * ONE NOTIFICATION PER NEW MAIL, ON EVERY PLATFORM (docs/wiki/mail-client-transport.md#as-built---lot-4).
 *
 * What it shows is the sender and the subject - never the body - in Paraglide words. WHAT THE LOCK
 * SCREEN SHOWS IS THE READER'S OWN SYSTEM SETTING, exactly as for a chat message: Canari has no
 * in-app "hide the content" switch, and a chat notification follows the OS's "hide sensitive
 * content" (Android) and "Show Previews" (iOS). A mail notice does the same, and on Android it also
 * carries a PUBLIC version ("Nouveau mail", no sender, no subject) for the OS to show in its place.
 *
 * - Android: the native builder (`MailWatchBridge.kt`), whose tap is the app link
 *   `fr.emse.canari://mail/<conversation>` - the plugin's tap opens the app onto nothing (see
 *   `useNotifications.svelte.ts`), so it is not a second path here.
 * - iOS and the desktop: the notification plugin, as for a chat message. Its tap opens the app; it
 *   cannot carry the conversation (the same limit the chat banners of these platforms have).
 * - The web: the browser's `Notification`, whose click opens the conversation.
 */

/** What one notification says and where its tap leads. */
export interface MailNotice {
  itemId: number;
  /** The sender's name, else its address, else "Expéditeur inconnu". */
  title: string;
  /** The subject, else "(sans objet)". */
  body: string;
  /** The lock screen's text when the reader hides sensitive content. */
  publicTitle: string;
  /** The app route a tap opens. */
  route: string;
  /** The app link a tap opens on Android. */
  link: string;
}

/** The notice of `mail`, or `null` for an item id outside this mailbox's numbering (never shown). */
export function mailNotice(mail: NewMail): MailNotice | null {
  const itemId = itemNumber(mail.id);
  if (itemId === null) return null;
  const sender = mail.from?.name?.trim() || mail.from?.address?.trim() || m.mail_sender_unknown();
  const subject = mail.subject.trim() || m.mail_no_subject();
  return {
    itemId,
    title: sender,
    body: subject,
    publicTitle: m.mail_notif_public_title(),
    route: mail.conversationId ? `/mail/${encodeURIComponent(mail.conversationId)}` : '/mail',
    link: mailAppLink(mail.conversationId),
  };
}

/**
 * Whether this device lets Canari notify, ASKING when it has not been asked yet - called from the
 * gesture that turns the switch on, never from the watcher.
 */
export async function askMailNotificationPermission(): Promise<boolean> {
  try {
    if (isTauriRuntime()) {
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === 'granted';
    }
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    return (await Notification.requestPermission()) === 'granted';
  } catch (err) {
    Log.w('MAIL-WATCH', `ERROR: the notification permission could not be read (${String(err)})`);
    return false;
  }
}

/** Posts one notification per new mail. Never throws: each failure is logged on its own. */
export async function postMailNotices(fresh: readonly NewMail[]): Promise<void> {
  const notices = fresh.map(mailNotice).filter((n): n is MailNotice => n !== null);
  Log.i('MAIL-WATCH', `${notices.length} new mail notification(s) to post`);
  for (const notice of notices) {
    try {
      await postOne(notice);
    } catch (err) {
      Log.w('MAIL-WATCH', `ERROR: item ${notice.itemId} was not notified (${String(err)})`);
    }
  }
}

async function postOne(notice: MailNotice): Promise<void> {
  if (isAndroidTauriRuntime()) {
    postAndroidMailNotice({
      itemId: notice.itemId,
      title: notice.title,
      body: notice.body,
      publicTitle: notice.publicTitle,
      link: notice.link,
    });
    return;
  }
  // The web, a desktop and an iPhone: the app's ONE banner builder raises it (`useNotifications`).
  const { globalNotifs } = await import('$lib/stores/globalChatSingleton.svelte');
  const raised = await globalNotifs.sendMailNotification({
    notifId: stableNotifId(`mail:${notice.itemId}`),
    tag: `canari-mail-${notice.itemId}`,
    title: notice.title,
    body: notice.body,
    open: () => openMailRoute(notice),
  });
  if (!raised)
    Log.i('MAIL-WATCH', `item ${notice.itemId} not notified - notifications are not allowed`);
}

/** Opens the thread a tapped new-mail notification names, in the Mail tab (every platform's tap). */
function openMailRoute(notice: MailNotice): void {
  Log.d('MAIL-WATCH', `item ${notice.itemId} tapped - opening its conversation`);
  void goto(resolve(internalPath(notice.route)));
}
