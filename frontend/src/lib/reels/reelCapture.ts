/**
 * The capture screen's rules, as pure functions (CanaReels R3, decision C4): which container the
 * recorder writes, what a press on the shutter MEANS, and the states a capture goes through.
 *
 * ONE SHUTTER, TWO GESTURES (user, 2026-10-05, replacing the separate photo button and the tap-toggle):
 * - a TAP takes a photo, on the release;
 * - a LONG PRESS records a video from the moment it is recognised as one, and its release ends it.
 * Whether a press is long is decided WHILE the finger is down - the recording must start under the
 * finger, not at the lift - so the screen arms a timer of {@link SHUTTER_HOLD_THRESHOLD_MS} on the
 * press and sends `hold` when it fires. The threshold classifies a gesture; it never decides whether
 * a recording that has started exists (the release, the cap or a cancel end it).
 */

/**
 * How long a finger must stay down before the press is a video: ~300-400 ms is where phone camera
 * apps put it - shorter turns a shaky thumb's tap into a take, longer feels like lag.
 */
export const SHUTTER_HOLD_THRESHOLD_MS = 350;

/**
 * The recorder's container, in order of preference, per platform - read on the phones 2026-10-01:
 * iOS's WKWebView writes a fragmented H.264/AAC MP4, which is also what its Photos library accepts;
 * Android's WebView writes VP9/Opus WebM by default. Either is brought to ONE fragmented H.264/AAC MP4
 * by `prepareVideoForUpload` before upload (C3), so this choice only has to be a format the engine
 * records well. The first one `isTypeSupported` accepts wins; none means the engine cannot record.
 */
export function reelRecorderMimeCandidates(ios: boolean): readonly string[] {
  return ios
    ? ['video/mp4;codecs=avc1,mp4a', 'video/mp4']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
}

/** The first candidate the engine records, or `null` when it records none of them. */
export function pickReelRecorderMime(
  ios: boolean,
  isTypeSupported: (type: string) => boolean
): string | null {
  return reelRecorderMimeCandidates(ios).find((type) => isTypeSupported(type)) ?? null;
}

/** A finished take: the recorder's bytes, or a video picked from the gallery. */
export interface ReelClip {
  blob: Blob;
  /** Where it came from - a gallery pick is read, never re-recorded. */
  source: 'camera' | 'gallery';
  /**
   * The member removed the sound in the review: the publish drops the audio TRACK from the file
   * (`prepareVideoForUpload`'s `removeAudio`), it is not a playback preference.
   */
  soundRemoved?: boolean;
}

/** Where a capture stands. */
export type CaptureState =
  | { kind: 'ready' }
  /** The finger is down and has not yet stayed down long enough to be a video. */
  | { kind: 'pressing'; pressedAt: number }
  /** A tap was released: the frame is being kept as a photo. */
  | { kind: 'photo' }
  /** Recording, from the moment the press became a hold; the release ends it. */
  | { kind: 'recording'; pressedAt: number }
  /** Stop asked for; the recorder's last chunk has not arrived yet. */
  | { kind: 'finishing' }
  | { kind: 'review'; clip: ReelClip };

export type CaptureEvent =
  | { type: 'press'; at: number }
  /** The press stayed down for {@link SHUTTER_HOLD_THRESHOLD_MS}: it is a video. */
  | { type: 'hold' }
  | { type: 'release'; at: number }
  /** The pointer was cancelled (a system gesture took the touch): nothing was decided by the member. */
  | { type: 'cancel' }
  /** The 90 s cap (C4) - the ring is full. */
  | { type: 'limit' }
  /** The recorder or the photo could not be made: back to the preview. */
  | { type: 'failed' }
  | { type: 'stopped'; clip: ReelClip }
  /** A photo taken, or a video picked from the gallery. */
  | { type: 'picked'; clip: ReelClip }
  | { type: 'discard' };

/**
 * The capture's transitions. Anything not listed leaves the state as it is - a release with no
 * press, a press while the last chunk is still arriving - because those are touches, not decisions.
 */
export function captureReducer(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (state.kind) {
    case 'ready':
      if (event.type === 'press') return { kind: 'pressing', pressedAt: event.at };
      if (event.type === 'picked') return { kind: 'review', clip: event.clip };
      return state;
    case 'pressing':
      if (event.type === 'hold') return { kind: 'recording', pressedAt: state.pressedAt };
      // Released before the threshold fired: a tap.
      if (event.type === 'release') return { kind: 'photo' };
      // A cancelled touch is not a tap: no photo nobody asked for.
      if (event.type === 'cancel' || event.type === 'failed') return { kind: 'ready' };
      return state;
    case 'photo':
      if (event.type === 'picked') return { kind: 'review', clip: event.clip };
      if (event.type === 'failed') return { kind: 'ready' };
      return state;
    case 'recording':
      if (event.type === 'failed') return { kind: 'ready' };
      // The cap, the release and a cancelled touch all END the take and KEEP it: the member filmed.
      if (event.type === 'limit' || event.type === 'release' || event.type === 'cancel') {
        return { kind: 'finishing' };
      }
      return state;
    case 'finishing':
      if (event.type === 'stopped') return { kind: 'review', clip: event.clip };
      if (event.type === 'failed') return { kind: 'ready' };
      return state;
    case 'review':
      if (event.type === 'discard') return { kind: 'ready' };
      return state;
  }
}

/** How full the ring is, 0 to 1, after `elapsedMs` of a take capped at `maxMs`. */
export function ringFraction(elapsedMs: number, maxMs: number): number {
  if (maxMs <= 0) return 0;
  return Math.min(1, Math.max(0, elapsedMs / maxMs));
}

/**
 * Why the reel limits could not be read, which decides what the capture screen says.
 *
 * - `unreachable`: no status, so nobody answered (the network, or the server is down).
 * - `refused`: the server answered with an error status. Canari is reachable; its reels are not.
 *
 * There is NO separate "server without reels" state, because no status names one. A server older
 * than CanaReels routes `GET /api/posts/reel-limits` to `GET /api/posts/:postId`, so it answers
 * `500` (a UUID cast failing in Postgres, measured on the bench 2026-10-01) or `400` once the id is
 * parsed (#1344), and never `404`. A branch keyed on 404 would have named no real server. So both
 * states offer a retry, and only `unreachable` says the server cannot be reached. It used to say
 * that for every failure.
 */
export type LimitsFault = 'unreachable' | 'refused';

/** Reads a {@link LimitsFault} from the error's status. A status is an answer; its absence is not. */
export function classifyLimitsFault(status: number | null): LimitsFault {
  return status === null ? 'unreachable' : 'refused';
}

/** `m:ss` for a duration in ms, as the timer over the shutter shows it. */
export function formatTakeTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
