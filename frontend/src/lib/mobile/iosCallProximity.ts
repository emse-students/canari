import type { CallStatusKind } from '$lib/stores/callView.svelte';
import { appendLog } from '$lib/utils/sessionLog';

/**
 * THE SCREEN GOES DARK AGAINST THE CHEEK ON THE iPHONE, as it does in a phone call.
 *
 * iOS turns the screen off near the face only while `UIDevice.proximityMonitoringEnabled` is set, and
 * a WebView never sets it. `canari_ios.mm` registers the `canariProximity` message handler, which sets
 * it from what this module posts. Android's peer is native (`CallForegroundService` holds a
 * `PROXIMITY_SCREEN_OFF_WAKE_LOCK` from the output its service applied), so this is iOS only.
 *
 * Absent outside the iOS app, where posting is a no-op by design, not a fallback.
 */

/**
 * Whether the call wants the screen dark against the cheek: while it holds the microphone in a state
 * the phone may be at the ear (from the caller's ring to the end), and not on the page's loudspeaker -
 * there the phone is looked at, and a hand over the sensor would hide the call. This is the PAGE'S
 * half: native arms the sensor only while the audio route's output is the built-in receiver too
 * (`CanariProximityHandler`), so AirPods or a speaker the page did not choose keep the screen lit.
 */
export function callHoldsProximity(
  kind: CallStatusKind,
  micHeld: boolean,
  speaker: boolean
): boolean {
  if (!micHeld || speaker) return false;
  return kind === 'ringing' || kind === 'connecting' || kind === 'live' || kind === 'reconnecting';
}

/** The last value posted, so an effect re-running with the same answer posts and logs nothing. */
let posted: boolean | null = null;

/** Tells the iOS shell to enable or disable proximity monitoring; logs every change with its cause. */
export function setIosProximityMonitoring(enabled: boolean, why: string): void {
  if (posted === enabled) return;
  const handler = (
    globalThis as unknown as {
      webkit?: { messageHandlers?: { canariProximity?: { postMessage: (m: boolean) => void } } };
    }
  ).webkit?.messageHandlers?.canariProximity;
  if (!handler) {
    // Only an ASK that cannot be honoured is a defect; releasing nothing is not.
    if (enabled) {
      appendLog(
        `[Call] ERROR no canariProximity handler in this iOS build - the screen stays on (${why})`
      );
    }
    posted = enabled;
    return;
  }
  posted = enabled;
  appendLog(`[Call] proximity screen-off ${enabled ? 'on' : 'off'} (${why})`);
  handler.postMessage(enabled);
}

/**
 * Called ONCE per page load on iOS - the twin of Android's `releaseCallServiceOfPreviousPage`. A page
 * that has just loaded holds no call, but the sensor lives in the PROCESS: a reload or a WebContent
 * kill mid-call on the receiver would leave it armed, darkening the screen at every hand over it.
 * Posted whatever this module last sent, since that memory was the previous page's.
 */
export function releaseIosProximityOfPreviousPage(): void {
  posted = null;
  setIosProximityMonitoring(false, 'a page loaded - no call holds the sensor');
}

/** Test seam: forgets the last posted value. */
export function resetIosProximityForTest(): void {
  posted = null;
}
