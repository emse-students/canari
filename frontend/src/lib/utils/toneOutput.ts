import { onAppScreenChange } from '$lib/utils/appForeground';
import { Log } from '$lib/utils/Log';

/**
 * THE APP'S ONE SOUND OUTPUT FOR SYNTHESISED TONES, AND THE RULE IT EXISTS FOR: THE APP HOLDS NO
 * AUDIO OUTPUT WHEN IT IS NOT PLAYING SOMETHING.
 *
 * MEASURED 2026-10-09 on a Pixel 6a running the store app 1.1.2 (`adb shell dumpsys audio`): the
 * Canari process held an AAudio output stream (usage MEDIA, mono 48 kHz) in state `started`
 * PERMANENTLY - in the background too, while Android's cached-app freezer had the process frozen.
 * When a push thawed it, logcat said `AudioTrack: restartIfDisabled(): releaseBuffer() track ...
 * disabled due to previous underrun, restarting`, and the user heard strange looping noises exactly
 * as notifications arrived. `appops set fr.emse.canari PLAY_AUDIO deny` silenced them while the
 * native banners still posted, so the source was the WebView's own output.
 *
 * That output was the notification tones' `AudioContext`: created on the first tone and never
 * suspended or closed. A running context renders silence for ever, so the stream stays `started`
 * whether or not anything is audible; freezing the process starves it, and thawing it replays
 * whatever the buffer held.
 *
 * So the lifetime of the output is now the lifetime of the SOUND, decided by events and never by a
 * clock:
 *
 * - Each tone's oscillators are counted in flight; the `ended` of the last one SUSPENDS the context,
 *   which stops the platform stream (`suspend()` is the Web Audio call that powers the hardware down).
 * - The next tone resumes it.
 * - The app leaving the screen (`visibilitychange` hidden, or `canari:foreground` false on Android,
 *   whose visibility API never changes) CLOSES it outright - a frozen process must hold nothing -
 *   and the next tone builds a new one.
 *
 * ONE CONTEXT FOR THE WHOLE APP, held here rather than per `useNotifications()` instance: there are
 * two instances (the background service and the chat page), and each used to open its own.
 */

/**
 * Schedules one tone on `ctx`, starting at `startAt`, and returns every oscillator it started.
 * The oscillators must be `start`ed AND `stop`ped: their `ended` is what releases the output.
 */
export type ToneScore = (ctx: AudioContext, startAt: number) => OscillatorNode[];

let context: AudioContext | null = null;
let inFlight = 0;
let screenWatchArmed = false;

/** Closes the context outright, dropping anything still scheduled on it. */
function release(reason: string): void {
  const ctx = context;
  if (!ctx) return;
  Log.d('AUDIO', `tone output closed (${reason}), ${inFlight} tone voice(s) dropped`);
  context = null;
  inFlight = 0;
  ctx.close().catch((e: unknown) => console.warn('[AUDIO] closing the tone output failed:', e));
}

/** Registers, once, the release on the app leaving the screen. */
function armScreenWatch(): void {
  if (screenWatchArmed) return;
  screenWatchArmed = true;
  onAppScreenChange((onScreen) => {
    if (!onScreen) release('the app left the screen');
  });
}

/** One oscillator of `ctx` has ended: the last one in flight suspends the output. */
function voiceEnded(ctx: AudioContext, osc: OscillatorNode): void {
  osc.disconnect();
  // A context closed since this voice started: its count is gone with it.
  if (ctx !== context) return;
  inFlight -= 1;
  suspendIfIdle(ctx, 'last tone ended');
}

/** Suspends `ctx` when nothing is in flight on it any more. */
function suspendIfIdle(ctx: AudioContext, reason: string): void {
  if (inFlight > 0) return;
  Log.d('AUDIO', `${reason}, suspending the tone output`);
  ctx
    .suspend()
    .catch((e: unknown) => console.warn('[AUDIO] suspending the tone output failed:', e));
}

/**
 * Plays one tone through the app's shared output, opening (or resuming) it for exactly as long as
 * the tone lasts.
 *
 * The resume is needed twice over: a context built before the page saw a gesture is born
 * `suspended`, and this module suspends it itself between tones. A suspended context accepts every
 * scheduling call and makes no sound. `resume()` may stay pending or reject when no gesture has ever
 * happened, which is the browser's decision and is logged, not reported.
 *
 * @param name What the tone is, for the log line.
 * @param score Builds and schedules the tone's oscillators.
 */
export function playTone(name: string, score: ToneScore): void {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return;
  armScreenWatch();
  if (!context) {
    Log.d('AUDIO', `opening the tone output for ${name}`);
    try {
      context = new AudioContext();
    } catch (e) {
      // The platform refused an output (a hardware limit, a sandboxed WebView): no tone, said once
      // per attempt, and nothing held.
      console.warn(`[AUDIO] no tone output could be opened for ${name}:`, e);
      return;
    }
  }
  const ctx = context;
  if (ctx.state === 'suspended') {
    ctx
      .resume()
      .catch((e: unknown) => Log.d('AUDIO', `the browser kept the tone output suspended: ${e}`));
  }
  let voices: OscillatorNode[];
  try {
    voices = score(ctx, ctx.currentTime + 0.01);
  } catch (e) {
    console.warn(`[AUDIO] the ${name} tone could not be scheduled:`, e);
    suspendIfIdle(ctx, `the ${name} tone failed`);
    return;
  }
  inFlight += voices.length;
  for (const osc of voices) osc.addEventListener('ended', () => voiceEnded(ctx, osc));
  if (voices.length === 0) suspendIfIdle(ctx, `the ${name} tone scheduled nothing`);
}

/** Test seam: forgets the shared context and its count, as a fresh page load would. */
export function resetToneOutputForTest(): void {
  context = null;
  inFlight = 0;
}
