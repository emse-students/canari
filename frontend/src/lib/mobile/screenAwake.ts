import { appendLog } from '$lib/utils/sessionLog';
import { isIosTauriRuntime } from '$lib/utils/appVersion';
import { ScreenWakeLock } from '$lib/live/liveDevice';

/**
 * THE SCREEN STAYS ON DURING A VIDEO CALL AND A LIVE, on every platform - the iPhone included.
 *
 * WKWebView refuses the Screen Wake Lock API (`NotAllowedError: Permission was denied`, read on the
 * iPhone 12 on `1.6.7-alpha.3`, every video call), so the iOS app keeps the screen on natively:
 * `canari_ios.mm` registers the `canariIdleTimer` message handler, which keeps a SET OF OWNERS and
 * sets `UIApplication.idleTimerDisabled` while it is not empty. Which path holds the screen is
 * decided by the PLATFORM, at the decision ({@link screenAwakeHolder}) - never by asking the engine
 * and classifying its refusal. Android's WebView and the browsers grant the wake lock and keep it.
 *
 * A set, because a call and a live can overlap: one holder's release must never drop the other's
 * hold. Each owner posts only its own changes, and native decides from the whole set.
 *
 * Nothing outlives the process: `idleTimerDisabled` is a property of the running app, so a kill or
 * a crash gives the screen back to the system. A WebContent kill or a reload mid-call leaves the
 * PROCESS alive, which is why every page load empties the set once
 * ({@link releaseIosIdleTimerOfPreviousPage}). iOS ignores the property while the app is not in the
 * foreground, so a holder released in the background is released before the user sees the screen.
 */

/** Who holds the screen; also the log tag of its lines (`CALL-WAKE`, `LIVE-WAKE`). */
export type ScreenAwakeOwner = 'call' | 'live';

/** What a call or a live holds to keep the screen on: the engine's wake lock, or the iOS idle timer. */
export interface ScreenAwakeHolder {
  /** Asks for the screen to stay on (again after a return to the foreground). Idempotent. */
  hold(): Promise<void>;
  /** Lets the screen sleep again, as far as this owner is concerned. Idempotent. */
  release(): void;
}

const TAGS: Record<ScreenAwakeOwner, string> = { call: 'CALL-WAKE', live: 'LIVE-WAKE' };

/** The message `canari_ios.mm` reads: one owner's change, or the page boot's reset. */
type IdleTimerMessage = { owner: ScreenAwakeOwner; hold: boolean } | { reset: true };

/** What each owner last posted, so a hold repeated on every return to the screen posts nothing. */
const posted = new Map<ScreenAwakeOwner, boolean>();

function idleTimerHandler(): { postMessage: (m: IdleTimerMessage) => void } | undefined {
  return (
    globalThis as unknown as {
      webkit?: {
        messageHandlers?: {
          canariIdleTimer?: { postMessage: (m: IdleTimerMessage) => void };
        };
      };
    }
  ).webkit?.messageHandlers?.canariIdleTimer;
}

/** Tells the iOS shell that `owner` holds the screen on, or no longer does; logs every change. */
export function setIosIdleTimerHeld(owner: ScreenAwakeOwner, held: boolean, why: string): void {
  if (posted.get(owner) === held) return;
  const tag = TAGS[owner];
  const handler = idleTimerHandler();
  if (!handler) {
    // NOT RECORDED: nothing reached native, so the next trigger (a return to the screen, the
    // effect re-running) must post again once the handler exists. Only an ASK that cannot be
    // honoured is a defect; releasing nothing is not.
    if (held) {
      appendLog(
        `[${tag}] ERROR no canariIdleTimer handler yet - the screen may dim until it is registered (${why})`
      );
    }
    return;
  }
  posted.set(owner, held);
  appendLog(`[${tag}] iOS idle timer ${held ? 'held' : 'released'} (${why})`);
  handler.postMessage({ owner, hold: held });
}

/**
 * The screen holder of `owner`, chosen by platform: the iOS app's idle timer, the engine's Screen
 * Wake Lock everywhere else, each logging under the owner's tag.
 */
export function screenAwakeHolder(
  owner: ScreenAwakeOwner,
  ios: boolean = isIosTauriRuntime()
): ScreenAwakeHolder {
  if (!ios) return new ScreenWakeLock(undefined, TAGS[owner]);
  return {
    hold: async () => setIosIdleTimerHeld(owner, true, `the ${owner} holds the screen`),
    release: () => setIosIdleTimerHeld(owner, false, `the ${owner} let the screen go`),
  };
}

/**
 * Called ONCE per page load on iOS - the twin of `releaseIosProximityOfPreviousPage`. A page that
 * has just loaded holds no call and no live, but the idle timer lives in the PROCESS: a reload or a
 * WebContent kill mid-call would leave the screen on for good. Empties the native set whatever this
 * module last sent, since that memory was the previous page's.
 */
export function releaseIosIdleTimerOfPreviousPage(): void {
  posted.clear();
  const handler = idleTimerHandler();
  if (!handler) return;
  appendLog('[SCREEN-AWAKE] iOS idle timer reset (a page loaded - nothing holds the screen)');
  handler.postMessage({ reset: true });
}

/** Test seam: forgets what each owner last posted. */
export function resetIosIdleTimerForTest(): void {
  posted.clear();
}
