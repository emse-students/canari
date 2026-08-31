/**
 * WHAT A BACKGROUNDED TAB IS ALLOWED TO SAY, AND THE ONE PLACE THAT DECIDES IT.
 *
 * Until 2026-08-31 the web had exactly ONE out-of-page unread signal - a `Notification` posted by
 * `useMessaging` - and it needs a permission the browser spends the FIRST message asking for. A
 * user who declines is then in a permanent state with no unread signal at all: the in-page badge
 * has to be looked at to be read, which for a backgrounded tab is not a signal.
 *
 * The title and the favicon need no permission, no service worker and no decision from anyone, and
 * they are what every other chat on the web does. This module is the pure half of them - what the
 * title should SAY given a count. Applying it is `stores/tabIndicator.svelte.ts`.
 */

/**
 * Above this, a count is shown as `99+` rather than in full.
 *
 * Not cosmetic: a browser truncates a tab title to a handful of characters, and a four-digit count
 * spends all of them on a number nobody reads precisely. `99+` says the same thing in three.
 */
export const TAB_COUNT_CAP = 99;

/** Renders `unread` for the tab strip, collapsing anything above {@link TAB_COUNT_CAP} to `99+`. */
export function formatUnreadCount(unread: number): string {
  return unread > TAB_COUNT_CAP ? `${TAB_COUNT_CAP}+` : String(unread);
}

/**
 * The title the tab should carry, from the page's own title and the two things that outrank it.
 *
 * A DERIVED VALUE, NEVER AN ACCUMULATED ONE. Every caller passes the page's UNDECORATED title and
 * gets the whole answer back, so applying it twice cannot produce `(3) (3) Canari`, and a count
 * falling to zero cannot leave a prefix behind. That is the failure mode of the obvious
 * alternative - prepend on arrival, strip on read - and it is why nothing here mutates.
 *
 * @param base   The page's own title, exactly as its route set it.
 * @param unread Total unread messages across every conversation. Non-positive means nothing to say.
 * @param bell   Whether the incoming-call bell should be showing AT THIS INSTANT - the caller owns
 *               the blink and passes its current phase, so this function stays a pure mapping. A
 *               call outranks a count: it is answered in seconds and unread messages are not.
 */
export function formatTabTitle(base: string, unread: number, bell: boolean): string {
  if (bell) return `\u{1F514} ${base}`;
  if (!Number.isFinite(unread) || unread <= 0) return base;
  return `(${formatUnreadCount(unread)}) ${base}`;
}
