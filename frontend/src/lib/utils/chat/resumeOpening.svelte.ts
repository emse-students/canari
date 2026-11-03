import { MOBILE_APP_PROTOCOL } from '$lib/mobile/appSiteAssociation';
import { chatTargetOfLink } from '$lib/mobile/chatLinkTarget';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { isAppInForeground, onAppForegroundChange } from '$lib/utils/appForeground';
import { createAppForegroundState } from '$lib/utils/appForegroundState.svelte';
import { Log } from '$lib/utils/Log';
import { describeDeepLink } from '$lib/utils/logSanitize';

/**
 * A RESUME THAT OPENS SOMETHING DOES NOT READ WHAT WAS LEFT OPEN (owner, 2026-11-02).
 *
 * The reader leaves the app on conversation X, a notification for Y arrives, they tap it. The app
 * comes back to the foreground still showing X, and only then does the tap's link reach the page and
 * select Y. The receipt effect ran on the foreground edge, saw X on screen, and marked X read - a
 * conversation nobody looked at, and a "Vu" its sender believed. The two platforms must behave the
 * same, and X must not be marked.
 *
 * DETERMINISTIC, NOT RACED. The shell already knows, at the moment it announces the foreground, that
 * this resume is an open: Android receives the tap's intent in `onNewIntent` BEFORE `onResume`, and
 * iOS's notification delegate takes the tap before the resume completes. So the shell sends the link
 * WITH the foreground edge (`canari:foreground`, `detail.opening`), and the page records, in the same
 * synchronous dispatch and before any effect re-runs, that the conversation on screen is held:
 * {@link noteResumeOpening}. Nothing waits on a clock; the hold ends on an event:
 *
 * - the selection moves (the landing selected the target, or the reader picked something) -
 *   {@link followResumeSelection};
 * - a chat target's landing was published and has ended (displayed and released, abandoned,
 *   superseded) - read from `notifNav` in {@link resumeOpeningHolds} itself;
 * - a link to anything else navigated - {@link noteOpenNavigated};
 * - a tap on a notification the PAGE raised ({@link PAGE_NOTIFICATION_OPENING}): its landing was
 *   published and has ended;
 * - the open was routed NOWHERE (a link nothing claims, a tap with no identity) -
 *   {@link noteOpenRoutedNowhere};
 * - the app left the screen again, or the next resume carried no link.
 *
 * EITHER ORDER, THE SAME ANSWER. The link reaches the page's router - and its landing, navigation or
 * "nowhere" - through a channel of its own, before OR after the edge. So every outcome is a
 * SEQUENCE (`notifNav.landing`, {@link noteOpenNavigated}, {@link noteOpenRoutedNowhere}),
 * snapshotted when the app LEAVES the screen: at the edge, an outcome counted since the leave is read
 * as this open's, and one counted after the edge ends the hold. A flag cleared by an event that came
 * first would hold for ever.
 *
 * KEYS, NOT IDS. A link and `notifNav.pending` carry a GROUP id; the selection is a MAP key, and the
 * two differ for every DM and group. Every comparison resolves the group id through the conversation
 * map first (`resolveConversationKey`, handed in), as the landing itself does.
 *
 * A RELOAD DROPS THE HOLD, AND NOTHING IT COVERED SURVIVES THE RELOAD: the selection lives in memory
 * only (`useConversations`) and a reload starts with none. The one selection carried across a load,
 * `canari_pending_contact`, is written only by an explicit "open this conversation" elsewhere in the
 * app, never by a resume - so after the reload the conversation the hold covered is neither shown
 * nor read.
 *
 * The hold only ever WITHHOLDS a mark, so its failure mode is a read marked later, never a read
 * claimed for a conversation nobody saw ([read-receipt-privacy](../../../../../docs/wiki/read-receipt-privacy.md), door 1).
 */

/**
 * THE OPENING OF A TAP ON A NOTIFICATION THE PAGE RAISED ITSELF (the notification plugin, on iOS).
 *
 * The shell knows it is a tap but not on what: the plugin's notification carries no link, and the
 * page names the conversation when its own `onAction` publishes the landing
 * (`useNotifications.svelte.ts`). So the hold waits for THAT landing instead of comparing with a
 * link. On Android the page's notifications are built natively and tap as an ordinary chat link
 * (`notifyMessageFromWebSocket`), so this marker is iOS's only. The shell sends this exact string.
 */
export const PAGE_NOTIFICATION_OPENING = `${MOBILE_APP_PROTOCOL}//page-notification`;

type Resolve = (id: string) => string | null;

/** What a resume that opens something holds. */
interface ResumeOpening {
  /** The conversation (MAP key) on screen when the app came back: the one that must not be marked. */
  heldKey: string;
  /**
   * `chat`: a chat link, its target known; `landing`: a page notification, whose landing names the
   * target; `page`: a link to anything else.
   */
  kind: 'chat' | 'landing' | 'page';
  /** The GROUP id a `chat` hold opens. */
  target: string | null;
  landingAtOpen: number;
  nowhereAtOpen: number;
  navigatedAtOpen: number;
  resolve: Resolve;
}

let opening = $state<ResumeOpening | null>(null);
/** Opens routed nowhere, and navigations, ever: compared, never reset. */
let nowhereSeq = $state(0);
let navigatedSeq = $state(0);
/**
 * Set once THIS page's notification-tap listener is registered (its `onAction` registration
 * resolved). Positive on purpose: a page that never armed one - no notification posted since a load,
 * a plugin without `onAction`, a registration refused - holds no `landing`, since no landing and no
 * "nowhere" can come from a handler that does not exist. A WebView reload resets it with the module,
 * so a tap on a notification posted before the reload is not waited for.
 */
let pageTapsRoutable = $state(false);
/** The outcome counters when the app last LEFT the screen: what is counted after is the resume's. */
let atLeave = { landing: notifNav.landing, nowhere: 0, navigated: 0 };

/** The landing store, injected so the tests drive it. */
export interface LandingState {
  readonly pending: string | null;
  readonly landing: number;
}

/** The app left the screen: the last open is over, and what is counted from now on is the next one's. */
function noteLeave(): void {
  if (opening) Log.d('[RESUME-OPEN] the app left - the hold ends');
  opening = null;
  atLeave = { landing: notifNav.landing, nowhere: nowhereSeq, navigated: navigatedSeq };
}
/**
 * The last foreground value this module saw. A `false` while already `false` is not a leave: the
 * shells publish the same value again (a page load in the background, a repeated edge), and a second
 * snapshot would move the baseline past an outcome the resume to come must still count.
 */
let lastForeground = isAppInForeground();
// Module-level, so a leave is seen whatever page is mounted when it happens.
onAppForegroundChange((foreground) => {
  const was = lastForeground;
  lastForeground = foreground;
  if (!foreground && was) noteLeave();
});

/**
 * Called on every foreground edge (false -> true), in the dispatch that announces it, with the link
 * that edge carried and the conversation on screen. A resume with no link ends any hold: a plain
 * resume reads what is on screen, as it always did.
 *
 * @param resolve a group id to its map key, over the live conversation map.
 */
export function noteResumeOpening(
  link: string | null,
  selected: string | null | undefined,
  resolve: Resolve,
  nav: LandingState = notifNav
): void {
  opening = null;
  if (!link || !selected) return;
  const landedSinceLeave = nav.landing !== atLeave.landing;
  const nothing = (why: string) =>
    Log.d(`[RESUME-OPEN] resume opens ${describeDeepLink(link)} - nothing held: ${why}`);
  if (nowhereSeq !== atLeave.nowhere) return nothing('the open was already routed nowhere');

  let kind: ResumeOpening['kind'];
  let target: string | null = null;
  if (link === PAGE_NOTIFICATION_OPENING) {
    if (landedSinceLeave) {
      // The page's tap handler published its landing before the edge: that landing names it.
      if (nav.pending === null) return nothing('its landing already ended');
      kind = 'chat';
      target = nav.pending;
    } else if (!pageTapsRoutable) {
      // No listener to name the landing: a hold would wait for nothing. The tap itself is LOST - it
      // opens the app on whatever it showed - and that is said per resume, where it happens.
      console.warn(
        '[RESUME-OPEN] page notification tap lost: no tap listener is armed in this page ' +
          '(none posted since the load, or its registration failed) - nothing held'
      );
      return;
    } else {
      kind = 'landing';
    }
  } else {
    target = chatTargetOfLink(link);
    if (target !== null) {
      kind = 'chat';
      if (landedSinceLeave && nav.pending !== target) return nothing('its landing already ended');
    } else {
      if (navigatedSeq !== atLeave.navigated) return nothing('it already navigated');
      kind = 'page';
    }
  }
  if (target !== null && resolve(target) === selected) {
    return nothing('it opens the conversation already on screen');
  }
  opening = {
    heldKey: selected,
    kind,
    target,
    // A landing published BEFORE the edge is this open's: the baseline is the leave's, so its end
    // (released, abandoned) is a landing count the hold no longer equals. Taken at the edge instead,
    // the count already included it, and an abandon (pending nulled, count unchanged) held for good.
    landingAtOpen: landedSinceLeave ? atLeave.landing : nav.landing,
    nowhereAtOpen: nowhereSeq,
    navigatedAtOpen: navigatedSeq,
    resolve,
  };
  Log.d(
    `[RESUME-OPEN] resume opens ${describeDeepLink(link)}: ${selected.slice(0, 12)} is not read until it lands`
  );
}

/**
 * Whether the read of `key` (a MAP key) is withheld because the resume that showed it is opening
 * something else. Reactive: it reads this module's state, `notifNav`'s and the conversation map
 * (through the resolver), so an effect that asks re-runs when the hold ends.
 */
export function resumeOpeningHolds(key: string, nav: LandingState = notifNav): boolean {
  const o = opening;
  if (!o || key !== o.heldKey) return false;
  if (nowhereSeq !== o.nowhereAtOpen) return false;
  switch (o.kind) {
    case 'page':
      return navigatedSeq === o.navigatedAtOpen;
    case 'landing':
      if (!pageTapsRoutable) return false;
      // Not published yet: held until the page's tap handler publishes it (or says "nowhere").
      if (nav.landing === o.landingAtOpen) return true;
      return nav.pending !== null && o.resolve(nav.pending) !== key;
    case 'chat':
      if (o.target !== null && o.resolve(o.target) === key) return false;
      if (nav.pending === o.target) return true;
      // Not yet published: held.
      if (nav.landing === o.landingAtOpen) return true;
      // Published since: held while ANOTHER conversation's landing is pending (the same rule as a
      // `landing` hold), released once none is - the target's ended, or one for the held key came.
      return nav.pending !== null && o.resolve(nav.pending) !== key;
  }
}

/**
 * Every selection is handed here, in a `pre` effect ahead of the receipt effect: once it is not the
 * held one, the hold is over (the landing selected its target, or the reader chose).
 */
export function followResumeSelection(selected: string | null | undefined): void {
  if (opening && selected !== opening.heldKey) {
    Log.d('[RESUME-OPEN] the selection moved - the hold ends');
    opening = null;
  }
}

/** A navigation completed (`afterNavigate`): a link to a page has been followed. */
export function noteOpenNavigated(): void {
  navigatedSeq += 1;
}

/**
 * An open was routed NOWHERE: a link the router does not claim, a page notification's tap with no
 * identity or one this session did not post. No landing and no navigation will come, so the
 * conversation on screen is what the reader sees. Counted, so it also ends a hold noted AFTER it.
 */
export function noteOpenRoutedNowhere(why: string): void {
  nowhereSeq += 1;
  Log.d(`[RESUME-OPEN] an open routes nowhere (${why})${opening ? ' - the hold ends' : ''}`);
}

/**
 * This page's notification-tap listener is REGISTERED (its `onAction` registration resolved): from
 * now on a resume opening a page notification may wait for the landing that listener publishes.
 */
export function notePageTapsRoutable(): void {
  pageTapsRoutable = true;
  Log.d('[RESUME-OPEN] the page notification tap listener is registered');
}

/**
 * THE RECEIPT EFFECT'S FOREGROUND, AWARE OF WHAT A RESUME OPENS - the ONE wiring `MainChatPage` uses
 * and the tests drive. Created during component (or effect-root) initialisation: it registers the
 * `pre` effect that ends the hold when the selection moves, ahead of the receipt effect.
 *
 * @param selected the conversation on screen (map key).
 * @param resolve a group id to its map key (`resolveConversationKey` over the live map).
 */
export function createResumeReadGate(
  selected: () => string | null | undefined,
  resolve: Resolve
): { readonly current: boolean; holds(key: string): boolean; destroy(): void } {
  const foreground = createAppForegroundState({
    onResume: (link) => noteResumeOpening(link, selected(), resolve),
  });
  $effect.pre(() => followResumeSelection(selected()));
  return {
    get current() {
      return foreground.current;
    },
    holds: (key) => resumeOpeningHolds(key),
    destroy: () => foreground.destroy(),
  };
}
