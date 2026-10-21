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
}

/** One `moof` + `mdat`. */
export function fragment(spec: FragmentSpec = {}): Uint8Array {
  const {
    videoTime = 0n,
    audioTime = 0,
    flagsIn = 'first',
    keyframe = true,
    mediaBytes = 32,
  } = spec;
  const flags = keyframe ? SYNC : NON_SYNC;
  const videoTrun =
    flagsIn === 'first'
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
  const videoTraf = box(
    'traf',
    fullBox('tfhd', 0, 0x20000, u32(1)),
    fullBox('tfdt', 1, 0, u64(videoTime)),
    videoTrun
  );
  const audioTraf = box(
    'traf',
    fullBox('tfhd', 0, 0x20000, u32(2)),
    fullBox('tfdt', 0, 0, u32(audioTime)),
    fullBox('trun', 0, 0x1, u32(1), u32(0))
  );
  const moof = box('moof', fullBox('mfhd', 0, 0, u32(1)), videoTraf, audioTraf);
  const mdat = box('mdat', new Uint8Array(mediaBytes));
  return new Uint8Array([...moof, ...mdat]);
}

/** Concatenation, for building chunks. */
export function join(...parts: Uint8Array[]): Uint8Array {
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
