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

/**
 * Builds the single report line for a recording that is starting. Pure, so a test pins the exact
 * wording; the caller logs it once per recording at info level.
 */
export function describeVoiceNoteCapture(
  track: Pick<MediaStreamTrack, 'label' | 'getSettings'> | undefined,
  recorder: RecorderFacts
): string {
  const s = track?.getSettings() ?? {};
  const device = classifyInputDevice(track?.label);
  return (
    `capture: echo=${String(s.echoCancellation)} noise=${String(s.noiseSuppression)} ` +
    `agc=${String(s.autoGainControl)} rate=${s.sampleRate ?? '?'}Hz ch=${s.channelCount ?? '?'} ` +
    `device=${device} mime=${recorder.mimeType || '?'} bps=${recorder.audioBitsPerSecond || '?'}`
  );
}
