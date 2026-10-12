import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { isAppInForeground } from '$lib/utils/appForeground';
import { isNarrowChatLayout } from '$lib/utils/viewport';
import {
  readerCanSeeArrival,
  readerIsReadingConversation,
  type ArrivalContext,
} from './arrivalVisibility';

/**
 * The runtime facts `arrivalVisibility.ts` reasons over, gathered in ONE place.
 *
 * The rules there are pure so a table can assert them; this is the only code that touches the
 * window, and every consumer - the live arrival path, the batch path, the sibling-tab mirror - asks
 * through here, so "is the reader looking at this" cannot be answered two ways. It used to be: the
 * tone and the notification asked the rule, while the unread count and the read signal asked only
 * `selectedContact === key`, which stays true after the reader has left the screen
 * ([chat](../../../../../docs/wiki/frontend/modules/chat.md#a-selection-is-not-a-screen-2026-10-10)).
 */
export function arrivalContextNow(
  conversationKey: string,
  selectedConversationKey: string | null | undefined
): ArrivalContext {
  const mobile = isMobileTauriRuntime();
  return {
    conversationKey,
    selectedConversationKey,
    pathname: window.location.pathname,
    // `isAppInForeground` on a phone, for the reason `appForeground.ts` gives: a backgrounded Tauri
    // app reports `visible` / `hasFocus` exactly as a foregrounded one does.
    appOnScreen: mobile
      ? isAppInForeground()
      : document.visibilityState === 'visible' && document.hasFocus(),
    narrowLayout: isNarrowChatLayout(),
  };
}

/** Whether the reader can see a message land in `conversationKey`, tone and notification alike. */
export function canSeeArrivalNow(
  conversationKey: string,
  selectedConversationKey: string | null | undefined
): boolean {
  if (typeof document === 'undefined') return false;
  return readerCanSeeArrival(arrivalContextNow(conversationKey, selectedConversationKey));
}

/**
 * Whether the reader is READING `conversationKey` this instant: selected, on a route that draws a
 * conversation, with the app in front of them. This - and not the bare selection - is what makes an
 * arrival "read on arrival": no unread count, and the read signal to this account's other devices.
 */
export function isReadingConversationNow(
  conversationKey: string,
  selectedConversationKey: string | null | undefined
): boolean {
  if (typeof document === 'undefined') return false;
  return readerIsReadingConversation(arrivalContextNow(conversationKey, selectedConversationKey));
}
