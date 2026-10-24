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
 *
 * ANDROID RECORDS H.264 FIRST (Mi 9T, WebView 152, lava-lamp bench 2026-10-09, same 590x1280 canvas
 * stream, 8 s): VP9 is a SOFTWARE encoder and kept 19-20 of 30 frames (17 gaps over 80 ms in the
 * user's own file), where the hardware H.264 encoder kept 30.0 with none. The VP9 recorder stays a
 * candidate for an engine with no H.264 one.
 */
export function reelRecorderMimeCandidates(ios: boolean): readonly string[] {
  return ios
    ? ['video/mp4;codecs=avc1,mp4a', 'video/mp4']
    : [
        'video/webm;codecs=h264,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
      ];
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
  /**
   * A FILMED take's first picture, taken from the preview as the recording starts (the same crop
   * the recorder draws). A composer draws it as the take's thumbnail (`capturePoster.ts`): a
   * recorder's file has no index to seek in, so the WebView decodes no frame of it and drew a grey
   * tile (Mi 9T, v1.2.9-alpha.1). `null` when the still could not be taken (logged).
   */
  poster?: Blob | null;
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
 * What the ring shows: the take's progress while one is being recorded or finished, and EMPTY in every
 * other state. The elapsed clock is only advanced by a running take, so a take that ended in a way
 * that never zeroed it (dismissed by Back, discarded after its review, a failed start) left the ring
 * where it stopped (user, 2026-10-07: the ring did not reset after a cancelled recording). The ring
 * is a function of the capture STATE, so no exit path can forget to reset it.
 */
export function shutterRingFraction(state: CaptureState, elapsedMs: number, maxMs: number): number {
  return state.kind === 'recording' || state.kind === 'finishing'
    ? ringFraction(elapsedMs, maxMs)
    : 0;
}

/**
 * Whether the lens may be flipped now - by its button or by a double tap on the preview. Only in
 * `ready` (the session reopens everything) and `recording` (`flipDuringTake` keeps the microphone).
 * Every other state is a decision or a file in progress that a flip would break: in `pressing` the
 * hold timer may start a take on a lens that is being reopened, in `photo` the frame is being read,
 * in `finishing` the recorder's last chunk is still arriving (a reopen would release its microphone
 * and cut the take's end), and a `review` has no preview at all.
 */
export function lensFlipAllowed(state: CaptureState): boolean {
  return state.kind === 'ready' || state.kind === 'recording';
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

/**
 * WHERE A TAKE IS GOING (user, 2026-10-11, D-camera: the in-app CanaReel camera is the ONLY capture
 * path - no native camera app, no `<input capture>`).
 *
 * - `feed`: the CanaReels tab; the take goes on to the publish step ({@link ReelCapture}).
 * - `post`: the NEW-post composer. ONE CAMERA, ONE BEHAVIOUR (user, 2026-10-19, replacing D-camera's
 *   retention by destination for this case): a FILMED video goes to the same reel publish step as the
 *   tab - a CanaReel, deleted after 30 days, which that step says - with the composer's text as its
 *   caption and a way back ("keep as a post") that hands the file to the composer as before. A photo
 *   comes back to the composer as a FILE, as it always did.
 * - `post-edit`: the post EDITOR. An existing post is never turned into a reel, so a photo OR a video
 *   comes back as a FILE for its ordinary attachment path.
 * - `chat`: a conversation composer; PHOTOS ONLY unless the writer is on (`chatReelWriter.ts`, off
 *   until RC-5 and RC-7 ship). A video filmed in a chat is the reel message
 *   (docs/wiki/frontend/modules/reels-in-chat.md), a photo goes out as an ordinary image message.
 */
export type CaptureDestination = 'feed' | 'post' | 'post-edit' | 'chat';

/** What a destination changes about the capture screen - one table, so no call site re-decides it. */
export interface DestinationRules {
  /** A hold on the shutter does NOT start a video. */
  photoOnly: boolean;
  /** A PHOTO is handed back as a file instead of opening the publish step. */
  photoHandsBack: boolean;
  /** A VIDEO is handed back as a file instead of opening the reel publish step. */
  videoHandsBack: boolean;
  /**
   * The reel publish step was reached from a composer: it says the reel is deleted after its days,
   * starts from the composer's text, and offers to hand the video back as an ordinary post instead.
   */
  fromComposer: boolean;
  /** The gallery shortcut (reel clips only) is drawn. */
  gallery: boolean;
  /**
   * How the microphone is asked. `with-lens`: in the lens's own request (the reel always has sound,
   * so a refused microphone is a refused camera). `separate`: after the lens, on its own, so a refused
   * microphone leaves the photos (`postCameraOpener`). `never`: a photo-only destination.
   */
  microphone: 'with-lens' | 'separate' | 'never';
  /** The review offers to remove the sound (only the reel publish applies it). */
  soundRemoval: boolean;
}

/** {@link DestinationRules} for `destination`. */
export function destinationRules(
  destination: CaptureDestination,
  chatFilms = false
): DestinationRules {
  return {
    photoOnly: destination === 'chat' && !chatFilms,
    microphone:
      destination === 'feed'
        ? 'with-lens'
        : destination === 'post' || destination === 'post-edit' || chatFilms
          ? 'separate'
          : 'never',
    photoHandsBack: destination !== 'feed',
    videoHandsBack: destination === 'post-edit' || destination === 'chat',
    fromComposer: destination === 'post',
    gallery: destination === 'feed',
    soundRemoval: destination === 'feed',
  };
}

/** Whether `media` (the take, or its edit) leaves as a file under `rules`, rather than being published here. */
export function handsBackTake(rules: DestinationRules, media: Blob): boolean {
  return media.type.startsWith('image/') ? rules.photoHandsBack : rules.videoHandsBack;
}

/**
 * The extension of each type a capture can carry - the types the recorder and the photo path
 * PRODUCE, which are not always the ones asked for: the Android WebView asked for
 * `video/webm;codecs=h264,opus` reports its take as `video/x-matroska;codecs=avc1,opus` (Mi 9T,
 * v1.2.9-alpha.1), and the take reached the post composer as `canari-video-*.bin`. H.264 is not a
 * WebM codec, so the engine names the container honestly; the name follows it.
 *
 * The image side is every type a canvas encode here can return: the lens photo is JPEG
 * (`framedCapture.ts`), the editor's flattened photo is WebP (`reelEditor.ts`) - a photo through
 * the editor reached the composer as `.bin` (Mi 9T, v1.2.9-alpha.3) - and an engine that cannot
 * encode WebP hands back PNG instead (`canvasBlob.ts`: read `blob.type`). HEIC is not listed: no
 * canvas encodes it, so only a recorder this code was never read against could produce one.
 */
const CAPTURE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/png': 'png',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/mp4': 'mp4',
};

/**
 * The take as a `File` for a composer's attachment path: the extension follows the blob's own type
 * (`CAPTURE_EXTENSIONS`), because the composers classify by name AND type.
 */
export function captureFileFrom(blob: Blob, now: number = Date.now()): File {
  const type = blob.type.split(';')[0] || 'application/octet-stream';
  let ext = CAPTURE_EXTENSIONS[type];
  if (!ext) {
    // A type the table does not know is a recorder this code was never read against: accused, and
    // named, so the next reading adds it here.
    console.error(`[reel-capture] a take of an unknown type "${blob.type}" - named .bin`);
    ext = 'bin';
  }
  const kind = type.startsWith('image/') ? 'photo' : 'video';
  return new File([blob], `canari-${kind}-${now}.${ext}`, { type: blob.type || type });
}
