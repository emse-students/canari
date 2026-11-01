import { writable, type Readable } from 'svelte/store';
import { Log } from '$lib/utils/Log';

/**
 * THE ONE GATE EVERY APP SOUND ASKS: IS A CALL HOLDING THE SOUND? (owner, 2026-10-31: during a
 * call, the app's other sounds are silenced - read on a production call, a message trill during an
 * outgoing ring, a message landing in the open conversation while a call rang, a read trill in the
 * call's own conversation.)
 *
 * ONE FACT, ONE PLACE. Each `CallService` instance states its own call's phase under its own holder
 * id (`CallService` subscribes its `callState` here), and the gate is held while ANY holder is in a
 * call - `calling` (ringing out), `incoming` (ringing in) or `incall` - and released at `ended` or
 * `idle`. A set of holders, never one boolean: an account switch builds the next service before the
 * last one has let go, and the first one's `idle` must not erase the second one's call.
 *
 * What reads it:
 * - `toneOutput.playTone` - every synthesised tone (message, mention, send, read); the call's own
 *   incoming ring passes `purpose: 'call'` and is exempt;
 * - `playbackArbiter` - an audible media (a voice note, a reel, a video, a live) is paused when the
 *   call starts and when it starts during one; a muted one plays on, it makes no sound;
 * - `useNotifications.sendSystemNotification` - a browser notification is posted `silent`.
 *
 * The ringback and the call's voice are the CALL's sounds and never ask.
 */

/** The phases of a call that hold the app's sound. */
const HOLDING: ReadonlySet<string> = new Set(['calling', 'incoming', 'incall']);

const holders = new Map<string, string>();
const held = writable(false);

/**
 * Whether a call holds the app's sound right now. Subscribe to react to its start (the arbiter
 * pauses what plays); read {@link callHoldsAppSound} to decide one sound.
 */
export const callSoundHeld: Readable<boolean> = { subscribe: held.subscribe };

/** Whether a call holds the app's sound right now - the question every player asks before it plays. */
export function callHoldsAppSound(): boolean {
  return holders.size > 0;
}

/** App tones refused while the gate was held, since it was last taken. */
let silencedTones = 0;

/** Counts one app tone refused because a call holds the sound (told on the gate's release line). */
export function noteToneSilenced(): void {
  silencedTones++;
}

/**
 * States the call phase of `holder` (a `CallService` instance). Logs only a CHANGE of the gate, with
 * the phase that caused it, so a reading shows exactly when the app went quiet and when it came back.
 */
export function reportCallSoundPhase(holder: string, phase: string): void {
  const before = holders.size > 0;
  if (HOLDING.has(phase)) holders.set(holder, phase);
  else holders.delete(holder);
  const after = holders.size > 0;
  if (before === after) return;
  // `Log.i`, NOT `Log.d`: the in-app log records no debug, so this line was unreadable on a device
  // (iPhone 12, 2026-10-30). One line per CHANGE of the gate, which is what `Log.i` is for; the
  // tones silenced meanwhile are COUNTED (one line per tone would be one per message) and told here.
  if (after) {
    silencedTones = 0;
    Log.i(
      'AUDIO',
      `a call holds the app's sound (${holder} is ${phase}) - tones, media and notification sounds are silenced`
    );
  } else {
    Log.i(
      'AUDIO',
      `the call released the app's sound (${holder} is ${phase}) - ${silencedTones} tone(s) silenced during the call`
    );
  }
  held.set(after);
}

/** Withdraws `holder` (a replaced `CallService`), as an `idle` would. */
export function retireCallSoundHolder(holder: string): void {
  reportCallSoundPhase(holder, 'retired');
}

/** Test seam: forgets every holder, as a fresh page load would. */
export function resetCallSoundGateForTest(): void {
  holders.clear();
  silencedTones = 0;
  held.set(false);
}
