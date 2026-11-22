/**
 * WHAT THE ENGINE REALLY RECORDS FOR A VOICE NOTE, as one line per recording.
 *
 * A voice note used to ask `{ audio: true }`, which leaves echo cancellation, noise suppression and
 * auto gain ON: the engine captured it like a phone call (owner, 2026-11-20: voice messages often
 * sound very bad). It now asks a recording's constraints (`recordingConstraints.ts`), and this line
 * reports what the engine GRANTED - the settings and the recorder's own container and bitrate - so a
 * reading names the cause instead of guessing it
 * ([sounds](../../../../../docs/wiki/frontend/sounds.md#a-voice-note-is-a-recording-not-a-call-owner-2026-11-20)).
 */

/** What kind of input the label says, never the label itself (it can carry a person's name). */
export type InputDeviceClass = 'bluetooth' | 'headset' | 'builtin-or-other' | 'unlabelled';

const BLUETOOTH = /bluetooth|airpods|buds|\bbt\b|hands-?free|hfp/i;
const HEADSET = /headset|headphone|earphone|earbud|wired|usb|\bhead\b/i;

/**
 * Classifies a microphone label. Bluetooth is tested first: a "Bluetooth headset" is the HFP
 * narrowband case, which is the one worth telling apart. An empty label (no permission yet, or an
 * engine that hides it) is its own class.
 */
export function classifyInputDevice(label: string | undefined): InputDeviceClass {
  if (!label) return 'unlabelled';
  if (BLUETOOTH.test(label)) return 'bluetooth';
  if (HEADSET.test(label)) return 'headset';
  return 'builtin-or-other';
}

/** The subset of the recorder this report reads. */
export interface RecorderFacts {
  mimeType: string;
  audioBitsPerSecond: number;
}

/** What the recorder RECEIVES, beside what the microphone granted (`monoRecording.ts`). */
export interface RecordedFacts {
  /** Whether the recorder records the one-channel downmix rather than the microphone's own track. */
  downmixed: boolean;
}

/** The track settings an engine may hold an identifier in: never printed. */
const IDENTIFYING_SETTINGS = new Set(['deviceId', 'groupId']);

/**
 * One setting as the line prints it: its value when the engine reports it; `unsupported` when the
 * engine does not implement that constraint at all (absent from `getSupportedConstraints()` - WebKit
 * has no `noiseSuppression`, `autoGainControl` nor `channelCount`); `unreported` when it implements
 * it and still reported nothing. A bare `undefined` proved nothing on the iPhone (`1.7.3-alpha.4`).
 */
function settingText(
  settings: MediaTrackSettings,
  supported: MediaTrackSupportedConstraints | undefined,
  key: keyof MediaTrackSettings & keyof MediaTrackSupportedConstraints
): string {
  const value = settings[key];
  if (value !== undefined) return String(value);
  return supported && supported[key] !== true ? 'unsupported' : 'unreported';
}

/**
 * Builds the single report line for a recording that is starting. Pure, so a test pins the exact
 * wording; the caller logs it once per recording at info level. `supported` is the engine's
 * `navigator.mediaDevices.getSupportedConstraints()`, undefined when the engine has none. The line
 * ends with every setting the engine DID expose (identifiers left out), so an engine reporting a
 * setting this line does not name still shows it, and `rec=` says what the recorder receives.
 */
export function describeVoiceNoteCapture(
  track: Pick<MediaStreamTrack, 'label' | 'getSettings'> | undefined,
  recorder: RecorderFacts,
  supported?: MediaTrackSupportedConstraints,
  recorded?: RecordedFacts
): string {
  const s: MediaTrackSettings = track?.getSettings() ?? {};
  const device = classifyInputDevice(track?.label);
  const text = (key: Parameters<typeof settingText>[2]) => settingText(s, supported, key);
  const exposed = Object.keys(s)
    .filter((k) => !IDENTIFYING_SETTINGS.has(k))
    .sort();
  const rec = recorded ? (recorded.downmixed ? 'mono-downmix' : 'as-granted') : '?';
  return (
    `capture: echo=${text('echoCancellation')} noise=${text('noiseSuppression')} ` +
    `agc=${text('autoGainControl')} rate=${text('sampleRate')} size=${text('sampleSize')} ` +
    `ch=${text('channelCount')} rec=${rec} device=${device} mime=${recorder.mimeType || '?'} ` +
    `bps=${recorder.audioBitsPerSecond || '?'} exposed=[${exposed.join(',')}]`
  );
}
