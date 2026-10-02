/**
 * The capture screen's rules, as pure functions (CanaReels R3, decision C4): which container the
 * recorder writes, what a press on the shutter MEANS, and the states a capture goes through.
 *
 * THE SHUTTER IS HOLD-TO-RECORD **AND** TAP-TO-TOGGLE, decided on the phone's terms:
 * - Holding is Instagram's gesture and the one the user named ("hold the shutter to record"): press,
 *   film, let go. It suits a few seconds.
 * - But a reel runs to 90 s, and holding a button for a minute and a half on glass shakes the frame,
 *   tires the thumb and makes the front/back switch unreachable mid-take. So a SHORT press - a tap -
 *   starts a recording that keeps going after the finger lifts, and a second tap ends it.
 * - What separates them is how long the finger stayed down, measured from the press to the release:
 *   a gesture's classification, never a clock deciding a correctness question. A recording that has
 *   started never depends on it - only whether the release also ends it.
 */

/** A press shorter than this is a tap (toggle); a longer one is a hold (records while held). */
export const SHUTTER_HOLD_THRESHOLD_MS = 300;

/** What a released shutter press was. */
export type ShutterPress = 'tap' | 'hold';

/** Classifies a press by how long the finger stayed down. */
export function classifyShutterPress(heldMs: number): ShutterPress {
  return heldMs < SHUTTER_HOLD_THRESHOLD_MS ? 'tap' : 'hold';
}

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
}

/** Where a capture stands. */
export type CaptureState =
  | { kind: 'ready' }
  /**
   * `mode`: `pending` while the finger is down - a hold ends at its release - and `toggle` once a
   * tap has started it, which only the next press ends.
   */
  | { kind: 'recording'; pressedAt: number; mode: 'pending' | 'toggle' }
  /** Stop asked for; the recorder's last chunk has not arrived yet. */
  | { kind: 'finishing' }
  | { kind: 'review'; clip: ReelClip };

export type CaptureEvent =
  | { type: 'press'; at: number }
  | { type: 'release'; at: number }
  /** The 90 s cap (C4) - the ring is full. */
  | { type: 'limit' }
  /** The recorder could not start or failed mid-take: back to the preview. */
  | { type: 'failed' }
  | { type: 'stopped'; clip: ReelClip }
  | { type: 'picked'; clip: ReelClip }
  | { type: 'discard' };

/**
 * The capture's transitions. Anything not listed leaves the state as it is - a release with no
 * recording, a press while the last chunk is still arriving - because those are touches, not
 * decisions.
 */
export function captureReducer(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (state.kind) {
    case 'ready':
      if (event.type === 'press')
        return { kind: 'recording', pressedAt: event.at, mode: 'pending' };
      if (event.type === 'picked') return { kind: 'review', clip: event.clip };
      return state;
    case 'recording':
      if (event.type === 'limit') return { kind: 'finishing' };
      if (event.type === 'failed') return { kind: 'ready' };
      if (event.type === 'release' && state.mode === 'pending') {
        return classifyShutterPress(event.at - state.pressedAt) === 'tap'
          ? { ...state, mode: 'toggle' }
          : { kind: 'finishing' };
      }
      // The second tap of a toggle ends it on the PRESS, which is when the member meant it.
      if (event.type === 'press' && state.mode === 'toggle') return { kind: 'finishing' };
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
