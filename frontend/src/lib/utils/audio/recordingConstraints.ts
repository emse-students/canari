import type { CallSoundPhase } from '$lib/utils/callSoundGate';
import { buildCallAudioConstraints } from '$lib/utils/callAudio';

/**
 * WHAT A MICROPHONE THAT RECORDS ASKS FOR, as opposed to one that CALLS (owner, 2026-11-20: voice
 * messages often sound very bad, "captured as a phone call").
 *
 * WHERE THE CALL CONFIGURATION CAME FROM. No Canari code sets a call mode for a recording - native
 * code sets `MODE_IN_COMMUNICATION` only in `CallForegroundService.kt`, and nothing calls
 * `AVAudioSession setCategory`. The ENGINE derives it from the capture's constraints, and
 * `{ audio: true }` leaves echo cancellation, noise suppression and auto gain ON:
 *
 * - Android (Chromium's `AudioManagerAndroid`): echo cancellation ON asks the platform canceller
 *   (`AudioParameters::ECHO_CANCELLER`). The input is then opened with the VOICE_COMMUNICATION preset
 *   (`aaudio_stream_wrapper.cc`; `opensles_input.cc` likewise), and the FIRST input stream with an
 *   effect sets `MODE_IN_COMMUNICATION` until the LAST input stream closes
 *   (`MakeAudioInputStream` / `ReleaseInputStream`). With every effect off the preset is GENERIC
 *   (CAMCORDER on OpenSL) and the mode is left alone.
 * - iOS (WebKit's `CoreAudioCaptureUnit`): echo cancellation ON selects the Voice-Processing I/O
 *   unit (a telephone's chain, which also ducks other audio); OFF selects RemoteIO. The session
 *   CATEGORY is `play-and-record` and WebKit forces its MODE to VideoChat for that category
 *   (`MediaSessionManagerCocoa::updateSessionState`) whatever the page says: that part is WebKit's
 *   and is not changed here.
 *
 * THE UNIT IS SHARED, AND A LIVE CALL OWNS IT. On iOS every capture of the page feeds from ONE
 * capture unit, and a source asking another echo setting RECONFIGURES it
 * (`CoreAudioCaptureSource::initializeToStartProducingData`): a voice note with processing off,
 * recorded during a call, would switch the CALL's echo canceller off. On Android a second input
 * stream reselects the communication device. So while a call holds the microphone (`calling`,
 * `incall`), a voice note asks EXACTLY the call's constraints and joins its configuration; when the
 * note ends, the call's capture is still open, so Chromium keeps the mode (it restores only after
 * the LAST input stream) and the audio session keeps `play-and-record` (`audioSession.ts`, the call
 * phase is a fact of its own).
 */

/**
 * The microphone a RECORDING is made with (a voice note, a reel, a live): NO voice-call processing.
 * Echo cancellation, noise suppression and automatic gain are a telephone's chain - they gate music
 * and ambience, pump the level and, with the gain, pushed the user's reel to -10 LUFS with its peak
 * over 0 dBFS (2026-10-09). Measured on the Mi 9T against one loud source, 6 s: gain control alone
 * read 6 dB hotter than none (peak -10.9 against -17.1 dBFS). A recording takes the room as it is, as
 * a camera or a voice-memo app does.
 */
export const RECORDING_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  // ONE channel: without voice processing a phone mic can answer two channels with the second one
  // empty, and the recorder then writes a stereo file that plays out of one side only. A mono track
  // plays on both sides everywhere (utils/audioLayout.ts reads back what the engine granted).
  channelCount: { ideal: 1 },
};

/** Which configuration a voice note is captured under. */
type VoiceNoteCaptureMode = 'recording' | 'call';

/** The choice, and the constraints that carry it. */
export interface VoiceNoteCapture {
  mode: VoiceNoteCaptureMode;
  audio: MediaTrackConstraints;
}

/**
 * The capture a voice note asks for, from the call gate's phase: the call's own constraints while a
 * call holds the microphone (placed or answered), the recording ones otherwise - a ring coming in
 * holds no microphone yet, so it does not count. Pure; the caller logs the choice.
 */
export function voiceNoteCapture(callPhase: CallSoundPhase): VoiceNoteCapture {
  if (callPhase === 'calling' || callPhase === 'incall') {
    return { mode: 'call', audio: buildCallAudioConstraints() };
  }
  return { mode: 'recording', audio: RECORDING_AUDIO_CONSTRAINTS };
}
