/**
 * Synthetic fMP4 as `MediaRecorder` writes it, for the live tests: an init (`ftyp`, `moov` with a
 * video track 1 at 90 kHz and an audio track 2 at 48 kHz, `mvex/trex`), and fragments (`moof` with
 * one `traf` per track + `mdat`). Only the fields the reader looks at are meaningful.
 */

const enc = new TextEncoder();

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u64(n: bigint): number[] {
  return [...u32(Number(n >> 32n)), ...u32(Number(n & 0xffffffffn))];
}

/** A box: size, type, payload. */
export function box(type: string, ...payload: (number[] | Uint8Array)[]): Uint8Array {
  const body = payload.flatMap((p) => Array.from(p));
  return new Uint8Array([...u32(8 + body.length), ...enc.encode(type), ...body]);
}

/** A full box: version and flags, then fields. */
function fullBox(type: string, version: number, flags: number, ...fields: number[][]): Uint8Array {
  return box(type, [version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff], ...fields);
}

/** The sample flags of a sync sample, and of a non-sync one (`sample_is_non_sync_sample`). */
export const SYNC = 0x02000000;
export const NON_SYNC = 0x01010000;

function trak(trackId: number, timescale: number, handler: string): Uint8Array {
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(trackId), u32(0), u32(0));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u32(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), Array.from(enc.encode(handler)), u32(0));
  return box('trak', tkhd, box('mdia', mdhd, hdlr));
}

/** `ftyp` + `moov`; `videoDefaultFlags` is the video `trex` default (NON_SYNC as Chromium writes). */
export function initSegment(videoDefaultFlags = NON_SYNC): Uint8Array {
  const ftyp = box('ftyp', Array.from(enc.encode('isom')), u32(0));
  const trex = (id: number, flags: number) =>
    fullBox('trex', 0, 0, u32(id), u32(1), u32(0), u32(0), u32(flags));
  const moov = box(
    'moov',
    trak(1, 90_000, 'vide'),
    trak(2, 48_000, 'soun'),
    box('mvex', trex(1, videoDefaultFlags), trex(2, 0))
  );
  return new Uint8Array([...ftyp, ...moov]);
}

export interface FragmentSpec {
  /** Video decode time, in 90 kHz ticks (written as a 64-bit `tfdt`). */
  videoTime?: bigint;
  /** Audio decode time, in 48 kHz ticks (written as a 32-bit `tfdt`). */
  audioTime?: number;
  /**
   * How the video's first sample is flagged: `first` (trun first-sample-flags), `per-sample`
   * (trun per-sample flags), or `default` (none: the init's `trex`).
   */
  flagsIn?: 'first' | 'per-sample' | 'default';
  keyframe?: boolean;
  /** `mdat` payload size. */
  mediaBytes?: number;
  /**
   * Per-sample video durations (90 kHz ticks), written in a `trun` with sample durations and sizes
   * as Chromium's recorder writes them; overrides `flagsIn`.
   */
  videoDurations?: number[];
  /** Per-sample audio durations (48 kHz ticks), written in the audio `trun`. */
  audioDurations?: number[];
  /** A `tfhd` default sample duration, written in BOTH tracks' `tfhd`. */
  defaultDuration?: number;
  /** Which tracks the fragment carries (both by default). */
  tracks?: 'both' | 'video' | 'audio';
}

/** One `moof` + `mdat`. */
export function fragment(spec: FragmentSpec = {}): Uint8Array<ArrayBuffer> {
  const {
    videoTime = 0n,
    audioTime = 0,
    flagsIn = 'first',
    keyframe = true,
    mediaBytes = 32,
    videoDurations,
    audioDurations,
    defaultDuration,
    tracks = 'both',
  } = spec;
  const flags = keyframe ? SYNC : NON_SYNC;
  const tfhd = (id: number) =>
    defaultDuration === undefined
      ? fullBox('tfhd', 0, 0x20000, u32(id))
      : fullBox('tfhd', 0, 0x20000 | 0x8, u32(id), u32(defaultDuration));
  const videoTrun = videoDurations
    ? fullBox(
        'trun',
        0,
        0x1 | 0x4 | 0x100 | 0x200,
        u32(videoDurations.length),
        u32(0),
        u32(flags),
        ...videoDurations.map((d) => [...u32(d), ...u32(10)])
      )
    : flagsIn === 'first'
      ? fullBox('trun', 0, 0x1 | 0x4, u32(1), u32(0), u32(flags))
      : flagsIn === 'per-sample'
        ? fullBox(
            'trun',
            0,
            0x1 | 0x100 | 0x200 | 0x400,
            u32(1),
            u32(0),
            u32(3000),
            u32(10),
            u32(flags)
          )
        : fullBox('trun', 0, 0x1, u32(1), u32(0));
  const videoTraf = box('traf', tfhd(1), fullBox('tfdt', 1, 0, u64(videoTime)), videoTrun);
  const audioTraf = box(
    'traf',
    tfhd(2),
    fullBox('tfdt', 0, 0, u32(audioTime)),
    audioDurations
      ? fullBox(
          'trun',
          0,
          0x1 | 0x100,
          u32(audioDurations.length),
          u32(0),
          ...audioDurations.map(u32)
        )
      : fullBox('trun', 0, 0x1, u32(1), u32(0))
  );
  const trafs =
    tracks === 'video' ? [videoTraf] : tracks === 'audio' ? [audioTraf] : [videoTraf, audioTraf];
  const moof = box('moof', fullBox('mfhd', 0, 0, u32(1)), ...trafs);
  const mdat = box('mdat', new Uint8Array(mediaBytes));
  return new Uint8Array([...moof, ...mdat]);
}

/** Concatenation, for building chunks. */
export function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(parts.flatMap((p) => Array.from(p)));
}

/** Reads the video (64-bit) and audio (32-bit) `tfdt` back from a fragment built by {@link fragment}. */
export function readTimes(bytes: Uint8Array): { video: bigint; audio: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const times: number[] = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (
      bytes[i] === 0x74 &&
      bytes[i + 1] === 0x66 &&
      bytes[i + 2] === 0x64 &&
      bytes[i + 3] === 0x74
    ) {
      times.push(i - 4);
    }
  }
  const [v, a] = times;
  return { video: view.getBigUint64(v + 12), audio: view.getUint32(a + 12) };
}

/** The per-sample video durations of a fragment built with `videoDurations`, read back. */
export function readVideoDurations(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.length; i++) {
    // The first `trun` is the video's: data-offset, first-sample-flags, then (duration, size) pairs.
    if (
      bytes[i] === 0x74 &&
      bytes[i + 1] === 0x72 &&
      bytes[i + 2] === 0x75 &&
      bytes[i + 3] === 0x6e
    ) {
      const count = view.getUint32(i + 8);
      return Array.from({ length: count }, (_, k) => view.getUint32(i + 20 + k * 8));
    }
  }
  return [];
}

/** Overwrites the `sample_count` of the `n`th `trun` (0: the video's) in place. */
export function setTrunCount(bytes: Uint8Array, n: number, count: number): void {
  let seen = 0;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (
      bytes[i] === 0x74 &&
      bytes[i + 1] === 0x72 &&
      bytes[i + 2] === 0x75 &&
      bytes[i + 3] === 0x6e
    ) {
      if (seen++ === n) {
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(i + 8, count);
        return;
      }
    }
  }
  throw new Error(`no trun ${n}`);
}
