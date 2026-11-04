import { callSoundPhase, type CallSoundPhase } from '$lib/utils/callSoundGate';
import { isIosTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * THE ONE OWNER OF THE PAGE'S AUDIO SESSION CATEGORY (iPhone report, 2026-11-04: *"with the phone
 * in silent mode, sending a message still plays the send sound - every other app is silent"*).
 *
 * MEASURED CAUSE. Nothing in Canari set a category - no Objective-C, Swift, Rust or plugin calls
 * `AVAudioSession setCategory` - so WebKit chose it alone (`MediaSessionManagerCocoa::
 * updateSessionState`): PlayAndRecord while the microphone is captured, MediaPlayback as soon as
 * ANY `<audio>`/`<video>` session is audible OR HAS PLAYED AUDIBLY SINCE THE LAST INTERRUPTION
 * (`hasPlayedAudiblySinceLastInterruption`), and AmbientSound - the category that obeys the silent
 * switch - only for Web Audio alone. One voice note heard, one reel unmuted, one ringback, and the
 * session stayed MediaPlayback while that element lived; the tones (`toneOutput.ts`, Web Audio)
 * then rode it and ignored the switch. After a call, PlayAndRecord even sticks while Web Audio plays.
 *
 * THE RULE (owner, 2026-11-04). The page states the category itself through WebKit's Audio Session
 * API (`navigator.audioSession.type`, a category OVERRIDE that WebKit applies before every rule
 * above; `DOMAudioSessionEnabled`, mature, on by default in WKWebView since iOS 16.4), from ONE
 * decision ({@link decideAudioSessionType}) over two facts:
 *
 * | Facts | Type | Why |
 * | --- | --- | --- |
 * | a call the user placed or answered (`calling`, `incall`) | `play-and-record` | the microphone is open; the category WebKit already chose for it (mode VideoChat) |
 * | an explicitly unmuted media playing (a reel or video the reader unmuted, a voice note played) | `playback` | the reader asked for that sound: it plays with the switch on, as Instagram's does |
 * | anything else - idle, UI tones, a ring coming in | `ambient` | obeys the silent switch and mixes with other apps' audio |
 *
 * A reel STARTS MUTED (`videoSound`, muted at every launch), so a reel plays sound in silent mode
 * only after the reader's tap on its speaker. The incoming in-app ring is `ambient` on purpose: the
 * system ring obeys the switch too, and that is what WebKit already chose for it (Web Audio alone).
 *
 * The facts arrive as events - the call gate's phase (`callSoundPhase`) and the playback arbiter's
 * "an audible media plays" ({@link reportAudibleMedia}) - never polled, never timed. A type equal to
 * the one applied is not set again, so the log carries one line per TRANSITION.
 *
 * Android has no such API and needs none for this: its WebView plays Web Audio on the MEDIA stream,
 * so the tones' gate there is the ringer mode (`androidRinger.ts`).
 */

/** The values of WebKit's `AudioSessionType` this module sets. */
export type AudioSessionType = 'ambient' | 'playback' | 'play-and-record';

/** What the category is decided from. */
export interface AudioSessionFacts {
  /** The strongest call phase (`callSoundGate`). */
  callPhase: CallSoundPhase;
  /** Whether a registered media plays WITH SOUND right now (`playbackArbiter`). */
  audibleMediaPlaying: boolean;
}

/** The category for `facts` - the table in the module comment. */
export function decideAudioSessionType(facts: AudioSessionFacts): AudioSessionType {
  if (facts.callPhase === 'calling' || facts.callPhase === 'incall') return 'play-and-record';
  if (facts.audibleMediaPlaying) return 'playback';
  return 'ambient';
}

/** WebKit's `navigator.audioSession`, which no DOM typing in this project declares yet. */
interface DomAudioSession {
  type: string;
}

const facts: AudioSessionFacts = { callPhase: 'none', audibleMediaPlaying: false };
let applied: AudioSessionType | null = null;
let armed = false;
let unsubscribeCall: (() => void) | null = null;
let absenceSaid = false;

/** The page's audio session object, when the engine has one. */
function domAudioSession(): DomAudioSession | null {
  if (typeof navigator === 'undefined') return null;
  const session = (navigator as Navigator & { audioSession?: DomAudioSession }).audioSession;
  return session ?? null;
}

/** Sets the type the facts decide, when it differs from the one applied. */
function apply(reason: string): void {
  const next = decideAudioSessionType(facts);
  if (next === applied) return;
  const session = domAudioSession();
  if (!session) {
    // Only an iPhone needs it; there its absence means an iOS before 16.4 (the app supports 16.0),
    // whose WebKit keeps choosing alone - the silent switch is then NOT honoured. Said once.
    if (isIosTauriRuntime() && !absenceSaid) {
      absenceSaid = true;
      console.warn(
        '[AUDIO] navigator.audioSession is absent - WebKit picks the category alone and the UI tones may ignore the silent switch'
      );
    }
    applied = next;
    return;
  }
  try {
    session.type = next;
  } catch (e) {
    // `InvalidStateError`: a document without a page - nothing is applied, said at error level.
    console.error(`[AUDIO] the audio session refused "${next}" (${reason}):`, e);
    return;
  }
  Log.i('AUDIO', `audio session ${applied ?? 'unset'} -> ${next} (${reason})`);
  applied = next;
}

/**
 * Takes ownership of the category, once: applies `ambient` at once and follows the call gate from
 * then on. Called by every sound source before it makes a sound (`toneOutput.playTone`,
 * `playbackArbiter`), so the first tone of a session already plays under `ambient`.
 */
export function armAudioSession(): void {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  unsubscribeCall = callSoundPhase.subscribe((phase) => {
    facts.callPhase = phase;
    apply(`call phase ${phase}`);
  });
}

/** The playback arbiter's report: whether a registered media plays WITH SOUND now. */
export function reportAudibleMedia(playing: boolean): void {
  if (facts.audibleMediaPlaying === playing) return;
  facts.audibleMediaPlaying = playing;
  armAudioSession();
  apply(playing ? 'an unmuted media plays' : 'no unmuted media plays');
}

/** Test seam: forgets everything, as a fresh page load would. */
export function resetAudioSessionForTest(): void {
  facts.callPhase = 'none';
  facts.audibleMediaPlaying = false;
  applied = null;
  armed = false;
  unsubscribeCall?.();
  unsubscribeCall = null;
  absenceSaid = false;
}
