/**
 * CAN THE READER SEE THIS MESSAGE LAND? THE ONE QUESTION BEHIND BOTH SIGNALS.
 *
 * A message arriving raises at most two things: an in-app tone, and an OS notification. Until
 * 2026-09-07 those were decided by two unrelated conditions, and the gap between them was audible:
 *
 *   - the tone fired for EVERY inbound message, whatever was on screen;
 *   - the notification fired only when the app was NOT in front of the reader.
 *
 * So on a phone sitting inside conversation A, a message from B produced a sound and nothing else.
 * `unreadCount` did go up - but that badge lives in the conversation list, and below Tailwind `md`
 * the list is not on screen at all: the layout gives the whole width to the open conversation
 * (`Sidebar.svelte` renders it `hidden md:flex`). A sound with nothing to look at is a ghost, and
 * the user reported it as one.
 *
 * THE RULE IS THAT THE SIGNAL FOLLOWS WHAT IS ACTUALLY ON SCREEN. If the reader can watch the
 * message arrive, a tone is the right signal and a notification would be noise. If the reader
 * cannot, a notification is owed and the tone alone would be the ghost. The two are therefore
 * MUTUALLY EXCLUSIVE consequences of one predicate rather than two independent decisions, which is
 * the whole reason this lives in its own file: there is exactly one place to get it wrong.
 *
 * Exactly one audible signal either way - the tone when visible, the channel's own sound when not.
 *
 * PURE ON PURPOSE. Every input is passed in, so the table above can be asserted directly rather
 * than staged through a layout, a runtime and a router. `arrivalVisibility.test.ts` walks the whole
 * matrix; nothing here touches `window`.
 */
export type ArrivalContext = {
  /** The conversation the message landed in, normalised the way `selectedConversationKey` is. */
  conversationKey: string;
  /** The conversation currently open, or `null`/`''` when the reader is on the list. */
  selectedConversationKey: string | null | undefined;
  /** `location.pathname` - the chat list only exists on the chat route. */
  pathname: string;
  /**
   * Whether the app itself is in front of the reader: the Android activity resumed, or a browser tab
   * both visible and focused. NOT the document's opinion on mobile, which reports a backgrounded
   * Tauri app as `visible`/`hasFocus` byte for byte - see `appForeground.ts`.
   */
  appOnScreen: boolean;
  /** Whether the conversation list and a conversation cannot share the screen - see `viewport.ts`. */
  narrowLayout: boolean;
};

/** True when the reader is looking at the place this message just appeared. */
export function readerCanSeeArrival(ctx: ArrivalContext): boolean {
  // Nothing on screen can be seen if the app is not.
  if (!ctx.appOnScreen) return false;

  // The conversation itself being open is the one case that holds at every width.
  const selected = ctx.selectedConversationKey ?? '';
  if (selected !== '' && selected === ctx.conversationKey) return true;

  // Everything else depends on the list being rendered, and the list only exists on the chat route.
  if (!isChatRoute(ctx.pathname)) return false;

  // A wide layout keeps the list beside the conversation, so a row lighting up is visible whichever
  // conversation is open. A narrow one shows the list only when no conversation has taken over.
  return !ctx.narrowLayout || selected === '';
}

/**
 * Whether this path renders the conversation list.
 *
 * `/chat` and anything under it, and nothing else. Written as a predicate rather than inlined
 * because "the list is on screen" is a claim about the ROUTE, and a second call site guessing at it
 * with a different `startsWith` is how the two signals drifted apart in the first place.
 */
export function isChatRoute(pathname: string): boolean {
  return pathname === '/chat' || pathname.startsWith('/chat/');
}
