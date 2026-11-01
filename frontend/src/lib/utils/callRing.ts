import type { AndroidCallHost } from '$lib/mobile/androidCallService';
import { onAppScreenChange } from '$lib/utils/appForeground';
import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { appendLog } from '$lib/utils/sessionLog';
import { playTone } from '$lib/utils/toneOutput';

/**
 * THE RING OF A CALL ARRIVING WHILE THE APP IS OPEN - Canari's own ring, "C1" (owner, 2026-11-01).
 *
 * WHAT IT PLAYS. The loop `soundPalette.RING_PHRASE` renders to (`tools/notification-sounds/
 * render.mjs`): two canaries, one 5 s loop, the same file the Android channel and CallKit ring with.
 *
 * WHERE, decided by the platform, never by a failure:
 * - ANDROID: natively, `window.canariCall.ringStart` (`CallRingPlayer.kt`) - the RINGTONE stream at
 *   the ringer volume, the ringer mode honoured (silent / vibrate), a vibration that repeats. A
 *   WebView's own sound is MEDIA: silent with the media volume down, loud in silent mode (the owner's
 *   first production call, 2026-10-30). A build without the bridge says so at ERROR level and rings
 *   on the tone output instead - the build and the page disagree, and the log names it.
 * - EVERYWHERE ELSE (web, desktop, the iPhone's open app): the shared tone output (`toneOutput`), the
 *   file decoded once and looped by its `AudioBufferSourceNode` - the loop is the node's own, no
 *   timer paces it - as a `call` tone, exempt from the gate that silences the app during a call.
 *
 * WHEN. {@link startCallRing} / {@link stopCallRing} follow the incoming state (the caller is
 * `ChatBackgroundService`). The app leaving the screen releases the output (the tone output closes,
 * Android stops its player in `onStop`) and the OS notification takes over; its return, while the
 * call still rings, starts the ring again. Both are events, so the ring never outlives its call nor
 * its screen.
 */

/** The rendered loop, served from `static/sounds/`. */
export const RING_SRC = '/sounds/canari_ring.wav';

/**
 * The in-app ring's level on the tone output. The file peaks at -1 dBFS - a ring must carry across
 * a room on the RINGTONE stream - but the tone output is the MEDIA stream, at whatever the reader
 * left it for a video; -9 dB keeps it a ring without a jump over the app's other sounds.
 */
export const RING_IN_APP_GAIN = 0.35;

/** The window as this module reads it, so a test hands in its own. */
export type CallRingHost = AndroidCallHost;

interface Ringing {
  callId: string;
  appSounds: boolean;
}

let ringing: Ringing | null = null;
/** Stops what the tone output plays for the current ring; null when nothing plays there. */
let stopTone: (() => void) | null = null;
let decoded: Promise<AudioBuffer> | null = null;
let screenWatchArmed = false;
/** Whether this page started a vibration for the current ring - only then is one cancelled. */
let vibrating = false;
let host: CallRingHost | null = null;

/**
 * Decodes the ring once per page. An `OfflineAudioContext` decodes into memory and opens no device,
 * so the output is still opened only for the time the ring plays. A failure is forgotten, so the next
 * ring asks again.
 */
function ringBuffer(): Promise<AudioBuffer> {
  if (!decoded) {
    decoded = fetch(RING_SRC)
      .then((r) => {
        if (!r.ok) throw new Error(`${RING_SRC} answered ${r.status}`);
        return r.arrayBuffer();
      })
      .then((bytes) => new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes));
    decoded.catch(() => {
      decoded = null;
    });
  }
  return decoded;
}

/** Plays the loop on the tone output for `ring`, once decoded - unless the ring moved on. */
function playOnToneOutput(ring: Ringing): void {
  if (!ring.appSounds) {
    appendLog(
      `[Call] in-app ring of ${ring.callId.slice(0, 8)}: the app's sounds are off - silent`
    );
    return;
  }
  ringBuffer()
    .then((buffer) => {
      if (ringing !== ring || stopTone) return;
      const started = playTone(
        'incoming-call ring',
        (ctx, startAt) => {
          const source = ctx.createBufferSource();
          const gain = ctx.createGain();
          source.buffer = buffer;
          source.loop = true;
          gain.gain.value = RING_IN_APP_GAIN;
          source.connect(gain);
          gain.connect(ctx.destination);
          source.start(startAt);
          return [source];
        },
        'call'
      );
      if (started.length === 0) return;
      appendLog(`[Call] in-app ring of ${ring.callId.slice(0, 8)} plays on the tone output`);
      stopTone = () => {
        for (const s of started) {
          try {
            s.stop();
          } catch (e) {
            // A source of a context closed meanwhile: it is already silent.
            appendLog(`[Call] in-app ring: stopping a source that no longer plays (${String(e)})`);
          }
        }
      };
    })
    .catch((e: unknown) =>
      console.warn(`[Call] the in-app ring could not be loaded (${RING_SRC}):`, e)
    );
}

/** Starts the output of `ring`: the native player on Android, the tone output elsewhere. */
function sound(ring: Ringing, why: string): void {
  const bridge = host?.canariCall;
  if (bridge) {
    appendLog(`[Call] in-app ring of ${ring.callId.slice(0, 8)} on the native ringtone (${why})`);
    bridge.ringStart(ring.callId, ring.appSounds);
    return;
  }
  if (isAndroidTauriRuntime()) {
    appendLog(
      '[Call] ERROR this Android build has no canariCall bridge - the in-app ring plays on the media volume'
    );
  }
  playOnToneOutput(ring);
  // A browser that vibrates (Chrome on Android): one pattern per ring start, as before the native ring.
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      vibrating = navigator.vibrate([400, 200, 400, 200, 400]);
    } catch (e) {
      appendLog(`[Call] in-app ring: the vibration was refused (${String(e)})`);
    }
  }
}

/** Silences the output of the current ring, if any. */
function silence(reason: string): void {
  const ring = ringing;
  if (!ring) return;
  host?.canariCall?.ringStop(ring.callId, reason);
  stopTone?.();
  stopTone = null;
  // Only a vibration this page started: `vibrate(0)` without a gesture is a console ERROR in Chrome,
  // which a cancel of nothing would print on every cold start.
  if (vibrating) {
    vibrating = false;
    try {
      navigator.vibrate(0);
    } catch (e) {
      appendLog(`[Call] in-app ring: cancelling the vibration failed (${String(e)})`);
    }
  }
}

/** Registers, once, the restart of a ring still up when the app comes back on screen. */
function armScreenWatch(): void {
  if (screenWatchArmed) return;
  screenWatchArmed = true;
  onAppScreenChange((onScreen) => {
    if (!ringing) return;
    if (!onScreen) {
      // The tone output is closed by `toneOutput` itself, the native player by `onStop`: forget the
      // handle, the OS notification rings off screen.
      stopTone = null;
      return;
    }
    sound(ringing, 'the app is back on screen');
  });
}

/**
 * Rings the incoming call `callId` until {@link stopCallRing}. A ring already up for the same call is
 * left alone; one of another call is stopped first.
 *
 * @param appSounds the app's own "sounds" setting: off, the tone is silent (Android still vibrates).
 */
export function startCallRing(
  callId: string,
  appSounds: boolean,
  win: CallRingHost = window as unknown as CallRingHost
): void {
  if (typeof window === 'undefined') return;
  if (ringing?.callId === callId) return;
  if (ringing) stopCallRing('another call rings');
  host = win;
  armScreenWatch();
  ringing = { callId, appSounds };
  sound(ringing, 'the call rings in');
}

/** Stops the ring - answered, declined, ended. A no-op when nothing rings. */
export function stopCallRing(reason: string): void {
  if (!ringing) return;
  appendLog(`[Call] in-app ring of ${ringing.callId.slice(0, 8)} stops (${reason})`);
  silence(reason);
  ringing = null;
}

/** Test seam: forgets every ring, as a fresh page load would. */
export function resetCallRingForTest(): void {
  ringing = null;
  stopTone = null;
  decoded = null;
  host = null;
  vibrating = false;
}
