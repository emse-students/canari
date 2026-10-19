import { Log } from '$lib/utils/Log';
import type { CallState } from '$lib/services/CallService';

/**
 * WHERE THE CALL IS DRAWN: the whole screen, or a slim bar at the top of the app (Messenger's two
 * shapes, user 2026-10-19: *"soit ca fait toute l'interface, soit ca fait un bandeau en haut"*).
 *
 * One flag shared by the two surfaces that draw a call - `CallOverlay` (full screen, portalled to the
 * body) and `CallBanner` (a row of the root layout's banner column, in flow, so it pushes the page
 * down instead of covering its header). Every new call opens full screen; the system Back, the
 * chevron and the banner's own tap move between the two. It is UI state only: `CallService` neither
 * reads nor writes it.
 */
let minimised = $state(false);
let locked = $state(false);
let audioBlocked = $state(false);

export const callView = {
  /** True while the call is shown as the top bar and the app is usable under it. */
  get minimised(): boolean {
    return minimised;
  },
  /** Shrinks the call to the top bar (chevron, system Back). */
  minimise(): void {
    if (minimised) return;
    Log.d('CallView', 'minimised to the top banner');
    minimised = true;
  },
  /** Brings the call back to the whole screen (a tap on the banner). */
  expand(): void {
    if (!minimised) return;
    Log.d('CallView', 'expanded to full screen');
    minimised = false;
  },
  /**
   * Whether the full screen is drawn now: not minimised, and not held under the PIN lock. The lock
   * (`PinModal`, `--z-modal`) sits BELOW the call's rung, so a full-screen call would paint over the
   * one gate of the app that must stay on top; while it is up the call is the banner, which the
   * gate covers, and it comes back full screen when the gate goes - unless the reader minimised it.
   */
  get showsFullScreen(): boolean {
    return !minimised && !locked;
  },
  /** The PIN lock is on screen (`ChatBackgroundService` writes it). */
  setLocked(next: boolean): void {
    if (next === locked) return;
    Log.d('CallView', next ? 'held under the PIN lock' : 'PIN lock gone');
    locked = next;
  },
  /**
   * The engine refused to start the voice (`play()` rejected: no user gesture on that WebView).
   * Both surfaces say "tap to hear" while it is true; the next tap anywhere retries.
   */
  get audioBlocked(): boolean {
    return audioBlocked;
  },
  setAudioBlocked(next: boolean): void {
    if (next === audioBlocked) return;
    audioBlocked = next;
  },
  /** A call that ended: the next one opens full screen again, with nothing held over. */
  reset(): void {
    if (minimised) Log.d('CallView', 'reset to full screen for the next call');
    minimised = false;
    audioBlocked = false;
  },
};

/**
 * What a call surface says about the call, as a KIND - each surface maps it to its own Paraglide
 * line. One function so the banner and the full screen cannot disagree about the same moment.
 *
 * - `incoming`: ringing here.
 * - `ringing`: we called, the other side has not answered.
 * - `connecting`: answered (or the relay paired us), no media path yet - the callee is `incall`
 *   from the tap, seconds before any sound, so `incall` alone is not "live".
 * - `reconnecting`: the media path was up and dropped; it may come back.
 * - `live`: media flows - the timer runs.
 * - `ended`: the short summary before the surface goes away.
 */
export type CallStatusKind =
  | 'idle'
  | 'incoming'
  | 'ringing'
  | 'connecting'
  | 'reconnecting'
  | 'live'
  | 'ended';

export function callStatusKind(
  state: CallState,
  connectedAt: number | null,
  isReconnecting: boolean
): CallStatusKind {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'incoming':
      return 'incoming';
    case 'calling':
      return 'ringing';
    case 'ended':
      return 'ended';
    case 'incall':
      if (connectedAt === null) return 'connecting';
      return isReconnecting ? 'reconnecting' : 'live';
  }
}
