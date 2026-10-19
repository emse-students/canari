/**
 * THE ONE fMP4 READER OF THE LIVE, both halves (WP-L5) - pure, no DOM, no clock, no network. The
 * broadcaster turns `MediaRecorder` chunks into segments here ({@link Fmp4Splitter}); the viewer
 * reads here where a segment's init ends ({@link initSegmentEnd}), on the same box-header reader.
 *
 * WHAT THE WP-L1 BENCH MEASURED, and what each fact asks of this module
 * (docs/wiki/frontend/modules/live.md, "WP-L1 - measured"):
 * - A chunk is box-aligned (567/567 Android, 657/657 iOS) - but nothing in the recorder's contract
 *   says so, so a box cut across two chunks is CARRIED to the next one here, never parsed half.
 * - Android's first chunk is the init ALONE (`ftyp,moov`); iOS's is init + the first media. Both
 *   come out of {@link Fmp4Splitter} the same way: one init, then fragments.
 * - 14 % of Android chunks carry TWO 2 s fragments. Each `moof` + `mdat` pair is emitted as its own
 *   fragment, so a segment is always one fragment (about 2 s) whatever the chunk held.
 * - Every fragment started on a keyframe (`videoKeyFrameIntervalDuration` = the timeslice). That
 *   is READ per fragment ({@link LiveFragment.startsOnKeyframe}) and counted by the pipeline, never
 *   assumed: a fragment that does not is still sent (the ingest is gapless) and reported.
 *
 * EVERY LIVE SEGMENT IS SELF-CONTAINED: the generation's init followed by ONE fragment
 * ({@link composeSegment}). The init is ~1.2 kB against a ~600-800 kB fragment (0.2 %), and it buys
 * three things no viewer then has to work out: a join at ANY index, the iOS / Android difference in
 * segment 0 gone, and a camera RE-ACQUIRED after a background (a new recorder, a new init) that needs
 * no signal - the next segment carries the init it decodes with.
 *
 * A NEW RECORDER RESTARTS ITS MEDIA TIME AT ZERO, so a re-acquired camera's fragments are shifted by
 * the time since the live started ({@link rebaseFragment}): the timeline a viewer appends stays
 * monotonic, and the background is a GAP in it that the player seeks over, never a jump back.
 */

/** A malformed recorder output or segment: a box this reader cannot frame. Classified here, never by message. */
export class Fmp4ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Fmp4ParseError';
  }
}

/** The init segment of one recorder, and what its fragments are read against. */
export interface Fmp4Init {
  /** `ftyp` + `moov` (and anything the recorder wrote before the first `moof`), verbatim. */
  bytes: Uint8Array;
  /** Media timescale (`mdhd`) per track id - the unit of a fragment's `tfdt`. */
  timescales: ReadonlyMap<number, number>;
  /** The video track's id, or null when the init declares none. */
  videoTrackId: number | null;
  /** `trex` default sample flags per track id, used when a fragment states none. */
  defaultSampleFlags: ReadonlyMap<number, number>;
}

/** One `moof` + `mdat` (and any box written between them), verbatim. */
export interface LiveFragment {
  bytes: Uint8Array;
  /**
   * Whether the video's first sample is a sync sample: true / false when read, null when the
   * fragment carries no video or its flags are not stated anywhere.
   */
  startsOnKeyframe: boolean | null;
}

/** What one {@link Fmp4Splitter.push} completed. */
export interface Fmp4SplitResult {
  /** The init, on the push that completed it (once per splitter), else null. */
  init: Fmp4Init | null;
  /** Every fragment completed by this push, in stream order. */
  fragments: LiveFragment[];
}

interface Box {
  type: string;
  start: number;
  size: number;
}

const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

const fourcc = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Concatenates byte arrays into one fresh `ArrayBuffer`-backed array. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Reads the header of the box at `at`, or null when fewer bytes than its header are present.
 * @throws {Fmp4ParseError} on a size this reader cannot frame (under 8, 0 = "to the end", over 2^53).
 */
function readBoxHeader(b: Uint8Array, at: number, end: number): Box | null {
  if (end - at < 8) return null;
  let size = u32(b, at);
  const type = fourcc(b, at + 4);
  if (size === 1) {
    if (end - at < 16) return null;
    const high = u32(b, at + 8);
    if (high >= 0x200000) throw new Fmp4ParseError(`box ${type}: a 64-bit size past 2^53`);
    size = high * 0x1_0000_0000 + u32(b, at + 12);
  } else if (size === 0) {
    // "Extends to the end of the file": a live stream has no end, so it cannot be framed.
    throw new Fmp4ParseError(`box ${type}: size 0 (to the end of the file) in a live stream`);
  }
  if (size < 8) throw new Fmp4ParseError(`box ${type}: size ${size} under its own header`);
  return { type, start: at, size };
}

/** The complete child boxes of `[start, end)`; a truncated child is a parse error. */
function children(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at < end) {
    const box = readBoxHeader(b, at, end);
    if (!box || box.start + box.size > end) {
      throw new Fmp4ParseError(`a child box overruns its parent at ${at}`);
    }
    out.push(box);
    at += box.size;
  }
  return out;
}

/** Reads the track ids, timescales, video track and `trex` defaults of a complete `moov`. */
function readInit(bytes: Uint8Array, moov: Box): Fmp4Init {
  const timescales = new Map<number, number>();
  const defaultSampleFlags = new Map<number, number>();
  let videoTrackId: number | null = null;
  for (const box of children(bytes, moov.start + 8, moov.start + moov.size)) {
    if (box.type === 'trak') {
      const kids = children(bytes, box.start + 8, box.start + box.size);
      const tkhd = kids.find((k) => k.type === 'tkhd');
      const mdia = kids.find((k) => k.type === 'mdia');
      if (!tkhd || !mdia) continue;
      const tkhdVersion = bytes[tkhd.start + 8];
      const trackId = u32(bytes, tkhd.start + 12 + (tkhdVersion === 1 ? 16 : 8));
      const mdiaKids = children(bytes, mdia.start + 8, mdia.start + mdia.size);
      const mdhd = mdiaKids.find((k) => k.type === 'mdhd');
      if (mdhd) {
        const v = bytes[mdhd.start + 8];
        timescales.set(trackId, u32(bytes, mdhd.start + (v === 1 ? 28 : 20)));
      }
      const hdlr = mdiaKids.find((k) => k.type === 'hdlr');
      if (hdlr && fourcc(bytes, hdlr.start + 16) === 'vide') videoTrackId = trackId;
    } else if (box.type === 'mvex') {
      for (const trex of children(bytes, box.start + 8, box.start + box.size)) {
        if (trex.type !== 'trex') continue;
        defaultSampleFlags.set(u32(bytes, trex.start + 12), u32(bytes, trex.start + 28));
      }
    }
  }
  return { bytes, timescales, videoTrackId, defaultSampleFlags };
}

/** The sample flags of the video's FIRST sample in `moof`, or null when none is stated. */
function firstVideoSampleFlags(b: Uint8Array, moof: Box, init: Fmp4Init): number | null {
  for (const traf of children(b, moof.start + 8, moof.start + moof.size)) {
    if (traf.type !== 'traf') continue;
    const kids = children(b, traf.start + 8, traf.start + traf.size);
    const tfhd = kids.find((k) => k.type === 'tfhd');
    const trun = kids.find((k) => k.type === 'trun');
    if (!tfhd || !trun) continue;
    const trackId = u32(b, tfhd.start + 12);
    if (init.videoTrackId === null || trackId !== init.videoTrackId) continue;
    const tfhdFlags = u32(b, tfhd.start + 8) & 0xffffff;
    let p = tfhd.start + 16;
    if (tfhdFlags & 0x1) p += 8; // base-data-offset
    if (tfhdFlags & 0x2) p += 4; // sample-description-index
    if (tfhdFlags & 0x8) p += 4; // default-sample-duration
    if (tfhdFlags & 0x10) p += 4; // default-sample-size
    let flags: number | null =
      tfhdFlags & 0x20 ? u32(b, p) : (init.defaultSampleFlags.get(trackId) ?? null);
    const trunFlags = u32(b, trun.start + 8) & 0xffffff;
    let q = trun.start + 16; // after the sample count
    if (trunFlags & 0x1) q += 4; // data-offset
    if (trunFlags & 0x4) {
      flags = u32(b, q); // first-sample-flags
    } else if (trunFlags & 0x400) {
      if (trunFlags & 0x100) q += 4; // sample-duration
      if (trunFlags & 0x200) q += 4; // sample-size
      flags = u32(b, q);
    }
    return flags;
  }
  return null;
}

/**
 * SPLITS A RECORDER'S CHUNKS INTO ONE INIT AND ITS FRAGMENTS - one splitter per recorder, since each
 * recorder writes its own init. Bytes of a box not yet complete are carried to the next push.
 */
export class Fmp4Splitter {
  #carry: Uint8Array = new Uint8Array(0);
  #initParts: Uint8Array[] = [];
  #init: Fmp4Init | null = null;
  /** Boxes of the fragment being assembled (a `moof` and what follows it, before its `mdat`). */
  #fragment: Uint8Array[] = [];
  /** The open fragment's `moof`, relative to its own bytes (for the keyframe read). */
  #moof: Uint8Array | null = null;

  /**
   * Bytes taken but not yet part of anything emitted: a box cut short, an open fragment, an init
   * still missing its `moov`. Non-zero when a recorder stops means its tail is lost - which the
   * pipeline LOGS rather than drops silently.
   */
  get pendingBytes(): number {
    const sum = (parts: Uint8Array[]) => parts.reduce((n, p) => n + p.byteLength, 0);
    return this.#carry.byteLength + sum(this.#fragment) + sum(this.#initParts);
  }

  /** The init once read, else null. */
  get init(): Fmp4Init | null {
    return this.#init;
  }

  /**
   * Takes the next chunk and returns what it completed.
   * @throws {Fmp4ParseError} on a box this reader cannot frame, or media before an init.
   */
  push(chunk: Uint8Array): Fmp4SplitResult {
    const bytes = this.#carry.byteLength ? concatBytes([this.#carry, chunk]) : chunk;
    let initDone: Fmp4Init | null = null;
    const fragments: LiveFragment[] = [];
    let at = 0;
    for (;;) {
      const box = readBoxHeader(bytes, at, bytes.byteLength);
      if (!box || box.start + box.size > bytes.byteLength) break;
      const view = bytes.subarray(box.start, box.start + box.size);
      at += box.size;
      if (this.#init === null) {
        if (box.type === 'moof' || box.type === 'mdat') {
          throw new Fmp4ParseError(`a ${box.type} before the init`);
        }
        this.#initParts.push(view);
        if (box.type === 'moov') {
          const initBytes = concatBytes(this.#initParts);
          this.#initParts = [];
          const moov = readBoxHeader(initBytes, initBytes.byteLength - box.size, initBytes.length);
          this.#init = readInit(initBytes, moov!);
          initDone = this.#init;
        }
        continue;
      }
      if (box.type === 'moof') {
        if (this.#moof) throw new Fmp4ParseError('a moof inside an open fragment');
        this.#moof = view;
        this.#fragment.push(view);
      } else if (box.type === 'mdat') {
        if (!this.#moof) throw new Fmp4ParseError('an mdat with no moof before it');
        this.#fragment.push(view);
        const moofBox: Box = { type: 'moof', start: 0, size: this.#moof.byteLength };
        const flags = firstVideoSampleFlags(this.#moof, moofBox, this.#init);
        fragments.push({
          bytes: concatBytes(this.#fragment),
          // `sample_is_non_sync_sample` is bit 16 of the sample flags.
          startsOnKeyframe: flags === null ? null : (flags & 0x10000) === 0,
        });
        this.#fragment = [];
        this.#moof = null;
      } else {
        // `styp`, `free`, `prft`, `emsg`...: kept with the fragment they lead or sit in.
        this.#fragment.push(view);
      }
    }
    // What is left is a box not yet complete: copied, since `bytes` may be the caller's chunk.
    this.#carry = bytes.slice(at);
    return { init: initDone, fragments };
  }
}

/** One self-contained segment: the generation's init, then one fragment. */
export function composeSegment(init: Fmp4Init, fragment: LiveFragment): Uint8Array<ArrayBuffer> {
  return concatBytes([init.bytes, fragment.bytes]);
}

/**
 * The viewer's read of a {@link composeSegment} output: the byte offset at which its init
 * (everything up to and including the top-level `moov`) ends, or 0 when the bytes carry no complete
 * `moov` before their media (a media-only fragment, or a box cut short - the caller then treats the
 * bytes as media). The viewer appends an init only when it differs from the last one.
 * @throws {Fmp4ParseError} on a box this reader cannot frame.
 */
export function initSegmentEnd(bytes: Uint8Array): number {
  let at = 0;
  for (;;) {
    const box = readBoxHeader(bytes, at, bytes.byteLength);
    if (!box || box.start + box.size > bytes.byteLength) return 0;
    if (box.type === 'moov') return box.start + box.size;
    // Media began before any `moov`: there is no init in these bytes.
    if (box.type === 'moof' || box.type === 'mdat') return 0;
    at += box.size;
  }
}

/**
 * Shifts every `tfdt` (the decode time of a track's first sample) of a fragment by `offsetMs`,
 * converted per track with the init's timescales, in a COPY of the fragment.
 *
 * Used for every recorder after the first, whose media time starts again at zero: offset by the
 * time since the live began, its fragments land AFTER what viewers already hold.
 *
 * @throws {Fmp4ParseError} when a 32-bit `tfdt` would overflow (past ~13 h at 90 kHz).
 */
export function rebaseFragment(
  fragment: LiveFragment,
  init: Fmp4Init,
  offsetMs: number
): LiveFragment {
  if (offsetMs === 0) return fragment;
  const b = fragment.bytes.slice();
  for (const top of children(b, 0, b.byteLength)) {
    if (top.type !== 'moof') continue;
    for (const traf of children(b, top.start + 8, top.start + top.size)) {
      if (traf.type !== 'traf') continue;
      const kids = children(b, traf.start + 8, traf.start + traf.size);
      const tfhd = kids.find((k) => k.type === 'tfhd');
      const tfdt = kids.find((k) => k.type === 'tfdt');
      if (!tfhd || !tfdt) continue;
      const trackId = u32(b, tfhd.start + 12);
      const timescale = init.timescales.get(trackId);
      if (!timescale) throw new Fmp4ParseError(`track ${trackId} has no timescale in the init`);
      const shift = BigInt(Math.round((offsetMs * timescale) / 1000));
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (b[tfdt.start + 8] === 1) {
        view.setBigUint64(tfdt.start + 12, view.getBigUint64(tfdt.start + 12) + shift);
      } else {
        const next = BigInt(view.getUint32(tfdt.start + 12)) + shift;
        if (next > 0xffffffffn) {
          throw new Fmp4ParseError(`track ${trackId}: a 32-bit tfdt would overflow`);
        }
        view.setUint32(tfdt.start + 12, Number(next));
      }
    }
  }
  return { bytes: b, startsOnKeyframe: fragment.startsOnKeyframe };
}
