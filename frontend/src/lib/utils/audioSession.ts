import { callSoundPhase, type CallSoundPhase } from '$lib/utils/callSoundGate';
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
 * decision ({@link decideAudioSessionType}) over three facts:
 *
 * | Facts | Type | Why |
 * | --- | --- | --- |
 * | a call placed or answered (`calling`, `incall`), OR a microphone held ({@link captureUserMedia}) | `play-and-record` | the only override under which WebKit lets `getUserMedia` capture audio at all |
 * | an explicitly unmuted media playing (a reel or video the reader unmuted, a voice note played) | `playback` | the reader asked for that sound: it plays with the switch on, as Instagram's does |
 * | anything else - idle, UI tones, a ring coming in | `ambient` | obeys the silent switch and mixes with other apps' audio |
 *
 * THE MICROPHONE IS A FACT OF ITS OWN, AT THE CALL'S RANK. Once the page sets an override, WebKit
 * no longer reaches its own "capturing -> PlayAndRecord" rule, AND `MediaDevices::getUserMedia`
 * REJECTS an audio capture (`InvalidStateError`, "AudioSession category is not compatible with audio
 * capture") under any override but none (`auto`) or PlayAndRecord - read in WebKit's source. So
 * every audio capture goes through {@link captureUserMedia}, which holds the microphone BEFORE
 * asking and releases it when every audio track of that capture has stopped or ended: a voice note,
 * the reel camera, a live, a call. While one is held, an unmuted media starting or stopping does
 * not move the type under the live capture.
 *
 * A reel STARTS MUTED (`videoSound`, muted at every launch), so a reel plays sound in silent mode
 * only after the reader's tap on its speaker. The incoming in-app ring is `ambient` on purpose: the
 * system ring (CallKit) obeys the switch too.
 *
 * The facts arrive as events - the call gate's phase (`callSoundPhase`), the playback arbiter's
 * "an audible media plays" ({@link reportAudibleMedia}), a capture's hold and the stop of its
 * tracks - never polled, never timed. A type equal to the one applied is not set again, so the log
 * carries one line per TRANSITION.
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
  /** Whether a capture holds the microphone ({@link captureUserMedia}). */
  microphoneHeld: boolean;
  /** Whether a registered media plays WITH SOUND right now (`playbackArbiter`). */
  audibleMediaPlaying: boolean;
}

/** The category for `facts` - the table in the module comment. */
export function decideAudioSessionType(facts: AudioSessionFacts): AudioSessionType {
  if (facts.callPhase === 'calling' || facts.callPhase === 'incall' || facts.microphoneHeld) {
    return 'play-and-record';
  }
  if (facts.audibleMediaPlaying) return 'playback';
  return 'ambient';
}

/** WebKit's `navigator.audioSession`, which no DOM typing in this project declares yet. */
interface DomAudioSession {
  type: string;
}

const facts: AudioSessionFacts = {
  callPhase: 'none',
  microphoneHeld: false,
  audibleMediaPlaying: false,
};
/** The captures holding the microphone, by a unique id (`<holder>#<n>`). */
const microphoneHolds = new Set<string>();
let holdCount = 0;
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

/**
 * Whether the page runs on iOS / iPadOS - the only system with a silent switch, so the only one
 * where this module sets anything. Read from the user agent and the touch points (an iPad's
 * WKWebView says "Macintosh"; a Mac reports at most one touch point - the rule `mlsPlatform.ts`
 * follows on the web), not from the app's platform helpers, which tests replace. NOT from
 * `window.webkit.messageHandlers`: WebKitGTK (Linux Tauri) and older macOS have it too, without
 * the Audio Session API.
 */
function isIosWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** Sets the type the facts decide, when it differs from the one applied - on iOS only. */
function apply(reason: string): void {
  const next = decideAudioSessionType(facts);
  if (next === applied) return;
  if (!isIosWebKit()) {
    // No silent switch to obey: the engine keeps its own choice, nothing is set or said.
    applied = next;
    return;
  }
  const session = domAudioSession();
  if (!session) {
    // On iOS its absence means a WebKit before iOS 16.4 (the app supports 16.0), which keeps
    // choosing alone - the silent switch is then NOT honoured. Said once.
    if (!absenceSaid) {
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
 * `playbackArbiter`) and by every capture, so the first tone of a session already plays under
 * `ambient`.
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

/**
 * Holds the microphone for `holder` - the session is `play-and-record` from this call on, so a
 * `getUserMedia` asked next is allowed to capture. Returns the release, idempotent; the last
 * release returns the session to what the other facts decide.
 */
export function holdMicrophone(holder: string): (why: string) => void {
  armAudioSession();
  const id = `${holder}#${++holdCount}`;
  microphoneHolds.add(id);
  facts.microphoneHeld = true;
  Log.i('AUDIO', `microphone held by ${id}`);
  apply(`microphone held by ${id}`);
  return (why) => {
    if (!microphoneHolds.delete(id)) return;
    facts.microphoneHeld = microphoneHolds.size > 0;
    Log.i('AUDIO', `microphone released by ${id} (${why}), ${microphoneHolds.size} still held`);
    apply(`microphone released by ${id}`);
  };
}

/** What each watched audio track does when it stops or ends, called at most once. */
const trackEnds = new WeakMap<object, () => void>();
let stopWatchInstalled = false;

/**
 * THE STOP OF A TRACK IS THE RELEASE. `MediaStreamTrack.stop()` fires no event (only a track the
 * system ends fires `ended`), and the capture sites stop their tracks on many paths. So the
 * prototype's `stop` is wrapped ONCE: it does what it always did, then tells the hold of that track,
 * if it has one. A track nobody holds is untouched.
 */
function installStopWatch(): void {
  if (stopWatchInstalled || typeof MediaStreamTrack === 'undefined') return;
  stopWatchInstalled = true;
  const original = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function stop(this: MediaStreamTrack) {
    original.call(this);
    trackEnds.get(this)?.();
  };
}

/** Calls `onEnd` once, when `track` is stopped by the page or ended by the system. */
function watchTrackEnd(track: MediaStreamTrack, onEnd: () => void): void {
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    trackEnds.delete(track);
    onEnd();
  };
  trackEnds.set(track, end);
  track.addEventListener('ended', end, { once: true });
}

/**
 * THE ONE WAY THE APP OPENS A MICROPHONE: `devices.getUserMedia(constraints)`, with the microphone
 * held for `holder` from before the ask until every audio track of the capture has stopped. A
 * capture without audio is passed through untouched. A refused capture releases at once.
 */
export async function captureUserMedia(
  devices: MediaDevices,
  constraints: MediaStreamConstraints,
  holder: string
): Promise<MediaStream> {
  if (!constraints.audio) return devices.getUserMedia(constraints);
  installStopWatch();
  const release = holdMicrophone(holder);
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia(constraints);
  } catch (e) {
    release('the capture was refused');
    throw e;
  }
  const audio = stream.getAudioTracks();
  if (audio.length === 0) {
    release('the capture holds no audio track');
    return stream;
  }
  let live = audio.length;
  for (const track of audio) {
    watchTrackEnd(track, () => {
      live -= 1;
      if (live === 0) release('its audio tracks stopped');
    });
  }
  return stream;
}

/** Test seam: forgets everything, as a fresh page load would. */
export function resetAudioSessionForTest(): void {
  facts.callPhase = 'none';
  facts.microphoneHeld = false;
  facts.audibleMediaPlaying = false;
  microphoneHolds.clear();
  applied = null;
  armed = false;
  unsubscribeCall?.();
  unsubscribeCall = null;
  absenceSaid = false;
}
