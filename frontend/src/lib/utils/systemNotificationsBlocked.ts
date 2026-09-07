import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * Has this session already stated that nothing can be raised? One line, not one per message.
 *
 * Module scope rather than per-composable, because the two callers are different objects and the
 * fact is about the browser, not about either of them.
 */
let announced = false;

/**
 * Can this session raise an OS notification AT ALL, or has the browser closed the door for good?
 *
 * ONE ANSWER, TWO CALLERS, BECAUSE THE CONDITION WAS ABOUT TO BE WRITTEN TWICE. `useNotifications`
 * needs it to stop re-asking a question the browser has already refused, and `useMessaging` needs it
 * to stop announcing that it is about to ask. A copy in each is the shape this codebase keeps paying
 * for: two statements of one fact, and nothing comparing them.
 *
 * WHY `denied` IS DIFFERENT FROM `default`. `default` means "not asked yet", and asking is a real
 * action with a real chance of succeeding. `denied` is TERMINAL: a browser will not re-prompt, and
 * only the user can reverse it in site settings. So it is a fact about the session, not about the
 * message being delivered - which is exactly why deriving it per message was wrong.
 *
 * WHAT IT COST, measured on HEAL-REVOKE-9 (2026-09-07): 12 inbound messages produced 33 `[NOTIF]`
 * lines on a device whose permission was `denied` - three per message, one of them claiming to be
 * "asking" when `requestSystemNotificationPermission` has no `denied` branch and asked nothing.
 *
 * NATIVE IS EXCLUDED ON PURPOSE. Under Tauri the plugin's own permission is the authority and the
 * web value says nothing about it, so a native run must fall through to the plugin path rather than
 * be short-circuited by a browser answer that does not apply to it.
 *
 * @returns `true` only when this is a web runtime whose Notification permission is `denied`
 */
export function systemNotificationsBlocked(): boolean {
  if (typeof window === 'undefined') return false;
  if (isTauriRuntime()) return false;
  if (!('Notification' in window)) return false;
  return Notification.permission === 'denied';
}

/**
 * THE ONE CALL A GUARD MAKES: are notifications blocked, and if so say so - ONCE, for the session.
 *
 * ASKING AND ANNOUNCING ARE ONE GESTURE HERE ON PURPOSE. Splitting them into a pure predicate plus a
 * "remember to log it" companion is the shape that produced the defect this whole seam is about: a
 * precondition applied to a helper's callers is one every caller must remember, and one of them will
 * not. It already happened once in this very fix - the first version returned early in
 * `useMessaging` before `sendSystemNotification` could announce anything, so a device with
 * notifications refused went from 33 lines a run to ZERO, and "no notification" became
 * indistinguishable from "this code never ran". That is precisely the silence the decision line was
 * added to remove, reintroduced while removing its noise.
 *
 * So: one line per session, said by whichever guard gets there first, and none per message.
 *
 * @returns `true` when the caller should give up on notifying - see {@link systemNotificationsBlocked}
 */
export function systemNotificationsBlockedAnnounceOnce(): boolean {
  if (!systemNotificationsBlocked()) return false;
  if (!announced) {
    announced = true;
    console.log(
      '[NOTIF] Nothing will be raised this session - notification permission is "denied", which ' +
        'only the user can change in site settings. Said once; later messages are silent by design.'
    );
  }
  return true;
}

/** @internal Lets a test observe the once-per-session announcement more than once. */
export function resetSystemNotificationsAnnouncementForTests(): void {
  announced = false;
}
