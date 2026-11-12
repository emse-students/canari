import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { isAppInForeground } from '$lib/utils/appForeground';
import { isNarrowChatLayout } from '$lib/utils/viewport';
import { windowAttention } from '$lib/utils/windowAttention.svelte';
import { resumeOpeningHolds } from './resumeOpening.svelte';
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
    // app reports `visible` / `hasFocus` exactly as a foregrounded one does. Elsewhere a window left
    // in front answers `visible` and focused with nobody there, so a person's recent gesture is
    // asked too (`windowAttention.svelte.ts`, owner 2026-11-11): an idle window's arrival stays
    // unread and notifies.
    appOnScreen: mobile
      ? isAppInForeground()
      : document.visibilityState === 'visible' && document.hasFocus() && windowAttention.attentive,
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
  // A conversation shown only because the app came back to open another one is not being read
  // (`resumeOpening.svelte.ts`): an arrival in it stays unread, as the receipt effect leaves it.
  if (resumeOpeningHolds(conversationKey)) return false;
  return readerIsReadingConversation(arrivalContextNow(conversationKey, selectedConversationKey));
}

/**
 * `selected` when this device is READING it now ({@link isReadingConversationNow}), otherwise `null`.
 *
 * What a server count must leave alone is the conversation whose count the receipt effect owns - the
 * one being read - and not the bare selection: a salon left selected while the reader is on another
 * page, in a hidden tab or with the app in the background is read by nobody, so nothing but the
 * server's count can correct it. Skipping it on the selection kept the badge of a salon read on
 * another device until the reader came back to it (owner, 2026-11-02).
 */
export function conversationBeingRead(selected: string | null | undefined): string | null {
  if (!selected) return null;
  return isReadingConversationNow(selected, selected) ? selected : null;
}
