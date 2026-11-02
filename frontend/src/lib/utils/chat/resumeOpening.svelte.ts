import { chatTargetOfLink } from '$lib/mobile/chatLinkTarget';
import { notifNav } from '$lib/stores/notifNav.svelte';
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
 * - a link to anything else navigated - {@link endResumeOpeningOnNavigation};
 * - the app left the screen again, or the next resume carried no link.
 *
 * The hold only ever WITHHOLDS a mark, so its failure mode is a read marked later, never a read
 * claimed for a conversation nobody saw ([read-receipt-privacy](../../../../../docs/wiki/read-receipt-privacy.md), door 1).
 */

/** What a resume that opens something holds. */
interface ResumeOpening {
  /** The conversation that was on screen when the app came back: the one that must not be marked. */
  heldKey: string;
  /** The conversation the link opens, or `null` for a link to anything else (a post, a page). */
  target: string | null;
  /** `notifNav.landing` at the resume: a later one means the link's landing has been published. */
  landingAtOpen: number;
  /** Whether that landing was ALREADY pending at the resume (the link reached the page first). */
  landingAlready: boolean;
}

let opening = $state<ResumeOpening | null>(null);

/** The landing store, injected so the tests drive it. */
export interface LandingState {
  readonly pending: string | null;
  readonly landing: number;
}

/**
 * Called on every foreground edge (false -> true), in the dispatch that announces it, with the link
 * that edge carried and the conversation on screen. A resume with no link ends any hold: a plain
 * resume reads what is on screen, as it always did.
 */
export function noteResumeOpening(
  link: string | null,
  selected: string | null | undefined,
  nav: LandingState = notifNav
): void {
  if (!link || !selected) {
    if (opening) Log.d('[RESUME-OPEN] plain resume - the hold ends');
    opening = null;
    return;
  }
  const target = chatTargetOfLink(link);
  if (target === selected) {
    opening = null;
    Log.d('[RESUME-OPEN] the resume opens the conversation already on screen - nothing held');
    return;
  }
  opening = {
    heldKey: selected,
    target,
    landingAtOpen: nav.landing,
    landingAlready: target !== null && nav.pending === target,
  };
  Log.d(
    `[RESUME-OPEN] resume opens ${describeDeepLink(link)}: ${selected.slice(0, 12)} is not read until it lands`
  );
}

/**
 * Whether the read of `key` is withheld because the resume that showed it is opening something
 * else. Reactive: it reads this module's state and `notifNav`'s, so an effect that asks re-runs when
 * the hold ends.
 */
export function resumeOpeningHolds(key: string, nav: LandingState = notifNav): boolean {
  const o = opening;
  if (!o || key !== o.heldKey) return false;
  if (o.target === null) return true;
  if (nav.pending === o.target) return true;
  // Not pending: either not yet published (hold), or published and since ended (release).
  return nav.landing === o.landingAtOpen && !o.landingAlready;
}

/**
 * `MainChatPage` hands every selection here, in a `pre` effect ahead of the receipt effect: once it
 * is not the held one, the hold is over (the landing selected its target, or the reader chose).
 */
export function followResumeSelection(selected: string | null | undefined): void {
  if (opening && selected !== opening.heldKey) {
    Log.d('[RESUME-OPEN] the selection moved - the hold ends');
    opening = null;
  }
}

/** A navigation completed: a link to anything but a conversation has been followed. */
export function endResumeOpeningOnNavigation(): void {
  if (opening && opening.target === null) {
    Log.d('[RESUME-OPEN] the link navigated - the hold ends');
    opening = null;
  }
}

/** The app left the screen: whatever the last resume opened is over. */
export function endResumeOpening(): void {
  opening = null;
}
