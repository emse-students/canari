/**
 * ONE RECORDER OF A LIVE: `MediaRecorder` over the camera's stream with the WP-L1 recipe - the fMP4
 * container both engines produced, 2.0 Mb/s asked, a chunk and a keyframe every 2 s
 * (`./constants`). A live has one recorder per camera acquisition; a re-acquired camera gets a new
 * one (`liveBroadcast.svelte.ts`).
 *
 * NO SECOND CONTAINER. The bench fell back to `video/mp4;codecs=avc1` and `video/mp4`; a viewer checks
 * {@link LIVE_RECORDER_MIME} with `isTypeSupported`, so an engine that cannot record exactly that
 * cannot broadcast, and says so before the live starts ({@link liveRecordingSupported}).
 */

import {
  LIVE_KEYFRAME_INTERVAL_MS,
  LIVE_RECORDER_MIME,
  LIVE_REQUESTED_VIDEO_BPS,
  LIVE_SEGMENT_MS,
} from './constants';

/** The audio bitrate asked, as the bench did (AAC-LC). */
export const LIVE_AUDIO_BPS = 64_000;

export type LiveRecorderFault =
  /** This engine does not record {@link LIVE_RECORDER_MIME}. */
  | 'unsupported'
  /** The recorder refused to start on this stream. */
  | 'start';

/** A recorder that could not be had, classified where it failed. */
export class LiveRecorderError extends Error {
  constructor(
    readonly fault: LiveRecorderFault,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'LiveRecorderError';
  }
}

/** What the broadcast holds of a running recorder. */
export interface LiveRecorderHandle {
  /**
   * Stops recording; resolves after the LAST chunk was handed to `onChunk` (the recorder's `stop`
   * event comes after its final `dataavailable`). Idempotent.
   */
  stop(): Promise<void>;
}

/** Starts a recorder; injectable so the broadcast is tested without one. */
export type LiveRecorderStarter = (
  stream: MediaStream,
  onChunk: (chunk: Blob) => void,
  onError: (error: unknown) => void
) => LiveRecorderHandle;

/** Whether this engine can record a live at all - read before the Start button is offered. */
export function liveRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported(LIVE_RECORDER_MIME)
  );
}

/** The first Chromium (Chrome, Edge) whose MediaRecorder records fragmented MP4 with H.264 and AAC. */
export const LIVE_CHROMIUM_MP4_FROM = 126;

/**
 * WHY a browser cannot record a live, in the words the sheet can say plainly. Only an engine that
 * cannot record {@link LIVE_RECORDER_MIME} reaches it, and the cause is read from the user agent
 * because nothing else tells the engines apart:
 * - `firefox`: its MediaRecorder records WebM only, never MP4/H.264 (live.md, "Firefox");
 * - `outdated`: Chrome and Edge record MP4 from {@link LIVE_CHROMIUM_MP4_FROM} on, so an older one
 *   needs updating;
 * - `other`: anything else (a Chromium build without H.264, an old Safari).
 */
export type LiveRecordingGap = 'firefox' | 'outdated' | 'other';

/** Classifies the user agent of a browser that cannot record a live. Pure. */
export function classifyRecordingGap(userAgent: string): LiveRecordingGap {
  if (/\bFirefox\/\d/.test(userAgent)) return 'firefox';
  const chromium = /\bChrome\/(\d+)/.exec(userAgent);
  if (chromium && Number(chromium[1]) < LIVE_CHROMIUM_MP4_FROM) return 'outdated';
  return 'other';
}

/** Null when this engine records a live; otherwise why it cannot. */
export function liveRecordingGap(): LiveRecordingGap | null {
  if (liveRecordingSupported()) return null;
  const gap = classifyRecordingGap(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  console.warn(`[LIVE-REC] this browser cannot record a live (${gap})`);
  return gap;
}

/**
 * Starts recording `stream` in {@link LIVE_SEGMENT_MS} chunks.
 * @throws {LiveRecorderError} `unsupported` or `start`.
 */
export const startLiveRecorder: LiveRecorderStarter = (stream, onChunk, onError) => {
  if (!liveRecordingSupported()) {
    console.warn(`[LIVE-REC] this engine does not record ${LIVE_RECORDER_MIME}`);
    throw new LiveRecorderError('unsupported', 'live: the container is not recordable here');
  }
  let recorder: MediaRecorder;
  try {
    // `videoKeyFrameIntervalDuration` is in Chromium and WebKit but not yet in the DOM typings.
    const options: MediaRecorderOptions & { videoKeyFrameIntervalDuration: number } = {
      mimeType: LIVE_RECORDER_MIME,
      videoBitsPerSecond: LIVE_REQUESTED_VIDEO_BPS,
      audioBitsPerSecond: LIVE_AUDIO_BPS,
      videoKeyFrameIntervalDuration: LIVE_KEYFRAME_INTERVAL_MS,
    };
    recorder = new MediaRecorder(stream, options);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) onChunk(event.data);
    };
    recorder.onerror = (event) => {
      console.error('[LIVE-REC] the recorder failed', event);
      onError(event);
    };
    recorder.start(LIVE_SEGMENT_MS);
  } catch (err) {
    console.error('[LIVE-REC] the recorder refused to start', err);
    throw new LiveRecorderError('start', 'live: the recorder refused to start', { cause: err });
  }
  console.debug(`[LIVE-REC] recording ${recorder.mimeType || LIVE_RECORDER_MIME}`);
  let stopped: Promise<void> | null = null;
  return {
    stop() {
      stopped ??= new Promise<void>((resolve) => {
        if (recorder.state === 'inactive') {
          resolve();
          return;
        }
        recorder.onstop = () => {
          console.debug('[LIVE-REC] stopped, last chunk handed over');
          resolve();
        };
        recorder.stop();
      });
      return stopped;
    },
  };
};
