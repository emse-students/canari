import { appendLog } from '$lib/utils/sessionLog';

/**
 * THE CALLER'S RINGBACK - what the caller hears while the other phone rings (owner, 2026-10-31).
 *
 * Before it, the caller heard NOTHING between the tap and the answer: `CallService` rang the callee
 * and the screen said "Appel...", and no sound said the call was getting anywhere.
 *
 * WHAT DRIVES IT. `CallService.ringingOut`, a fact written at state transitions only (the invite
 * left; the callee answered, declined or was busy; the caller cancelled; the window closed; the setup
 * failed). `CallOverlay` calls {@link CallRingback.start} and {@link CallRingback.stop} as that fact
 * moves. There is no timer here: the file IS one loop (the phrase and its pause,
 * `soundPalette.RINGBACK_PERIOD_S`), and the element repeats it itself (`loop`).
 *
 * WHAT IT PLAYS. `static/sounds/canari_ringback.wav`, rendered from `soundPalette.RINGBACK_PHRASE` by
 * `tools/notification-sounds/render.mjs` (drift-checked in CI by `notificationSoundsDrift.test.ts`):
 * a soft canary roll and two falling whistles, at -14 dBFS.
 *
 * WHERE IT PLAYS. On the element `CallOverlay` mounts beside the call's voice sink, so it takes the
 * same output: on Android the ongoing-call service already holds the call's communication route
 * (the microphone is open before the invite, so the WebView plays in communication mode); on the
 * iPhone the page routes it by the same `setSinkId` as the voice. It is an OUTPUT only: it is never
 * added to a peer connection, and it stops at the pairing, before any media can flow.
 *
 * WHAT A WEBVIEW MAY REFUSE. `play()` outside a gesture (`NotAllowedError`): the invite leaves seconds
 * after the dial tap. So {@link prime} is called INSIDE that tap (the overlay mounts within it): a
 * muted play-and-pause that unlocks this element for the later `start`.
 */
export const RINGBACK_SRC = '/sounds/canari_ringback.wav';

/** The subset of an audio element this touches, so a test can hand in its own. */
export interface RingbackElement {
  src: string;
  loop: boolean;
  muted: boolean;
  paused: boolean;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}

export class CallRingback {
  /** Whether the call wants the ringback now - what a late prime or a late `play()` answers to. */
  private wanted = false;

  constructor(private readonly el: RingbackElement) {
    el.src = RINGBACK_SRC;
    el.loop = true;
  }

  /**
   * Unlocks the element inside a user gesture: a muted play, paused again at once unless the ringback
   * was asked for meanwhile. Its own refusal is only logged - `start` will say what it meets.
   */
  prime(why: string): void {
    if (this.wanted) return;
    this.el.muted = true;
    this.el
      .play()
      .then(() => {
        if (!this.wanted) this.el.pause();
        this.el.muted = false;
        appendLog(`[Call] ringback primed (${why})`);
      })
      .catch((e: unknown) => {
        this.el.muted = false;
        appendLog(`[Call] ringback prime refused (${why}): ${String(e)}`);
      });
  }

  /** Plays the loop from its start; `why` is the transition that asked. A repeat is a no-op. */
  start(why: string): void {
    if (this.wanted) return;
    this.wanted = true;
    this.el.muted = false;
    this.el.currentTime = 0;
    this.el
      .play()
      .then(() => {
        // Stopped while `play()` was pending: the stop already paused, and a late resolve must not
        // leave the loop running.
        if (!this.wanted) {
          this.el.pause();
          return;
        }
        appendLog(`[Call] ringback playing (${why})`);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'NotAllowedError') {
          appendLog(
            `[Call] WARN ringback refused without a gesture (${why}) - the caller hears nothing`
          );
          return;
        }
        appendLog(`[Call] ringback did not start (${why}): ${String(e)}`);
      });
  }

  /** Stops at once and rewinds; `why` is the transition that ended it. A no-op when not playing. */
  stop(why: string): void {
    if (!this.wanted) return;
    this.wanted = false;
    this.el.pause();
    this.el.currentTime = 0;
    appendLog(`[Call] ringback stopped (${why})`);
  }
}
