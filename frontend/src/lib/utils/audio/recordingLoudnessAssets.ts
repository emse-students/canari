import loudnessTapWorkletUrl from '$lib/workers/loudnessTap.worklet?worker&url';
import type { RecordingLoudnessDeps } from './recordingLoudness';

/**
 * The platform half of `tapRecordingLoudness`'s dependencies: the worklet bundled by Vite and the
 * engine's own `AudioContext`. Kept apart so the tap is tested without Vite's queries.
 */
export const recordingLoudnessDeps: RecordingLoudnessDeps = {
  createContext: () => new AudioContext(),
  workletUrl: loudnessTapWorkletUrl,
};
