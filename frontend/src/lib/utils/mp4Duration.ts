/**
 * THE LENGTH OF A FRAGMENTED MP4, READ FROM ITS OWN SAMPLES, AND WRITTEN WHERE A PLAYER LOOKS FOR IT
 * (owner, 2026-11-10: a conversation video read `0:23 / 0:00` and its progress line never moved;
 * a reader "could no longer seek").
 *
 * THE CAUSE, MEASURED: every video Canari uploads is the fragmented MP4 `prepareVideoForUpload`
 * writes (mediabunny, `fastStart: 'fragmented'`). The muxer writes the `moov` BEFORE the first
 * fragment, when it cannot know how long the clip will be, so its `mvhd` says duration 0 and there
 * is no `mehd` (a 10 s clip muxed by mediabunny 1.x: `mvhd` timescale 57600, duration 0; `mdhd`
 * duration 0; ten `moof`s; an `mfra`). An engine reads the movie's length from those two boxes:
 * Chromium's file demuxer and its MSE parser both, so the `<video>` reports `0`/`Infinity`, the
 * scrubber has nothing to map a fraction onto, and the engine's own `seekable` range is empty -
 * a seek lands nowhere.
 *
 * THE FIX IS THE CONTAINER'S, NOT THE PLAYER'S: the real length is in the file - the sum of the
 * sample durations of each track's fragments (`tfdt` + `trun`), in that track's timescale - and
 * {@link declareMp4Duration} writes it into the `mvhd` duration field IN PLACE (same width, so no
 * offset anywhere in the file moves). The writer does it once before upload; a reader does it to a
 * file uploaded before that (`mediaBlobCache`). No timer, no "seek to a huge time" probe: the
 * bytes say how long they last.
 *
 * A file that is not fragmented (no `moof`), or whose `mvhd` already says at least the samples'
 * length, is left untouched: its header is the answer.
 */
import { Log } from './Log';

/** One box: where its payload starts and ends, and where its header started. */
interface Box {
  type: string;
  /** Offset of the box's first byte (its size field). */
  start: number;
  /** Offset of the first byte of its payload. */
  body: number;
  /** Offset one past its last byte. */
  end: number;
}

/** The boxes directly inside `[from, to)`. A malformed size stops the walk there. */
function childBoxes(view: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7)
    );
    out.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return out;
}

function child(view: DataView, parent: Box, type: string): Box | undefined {
  return childBoxes(view, parent.body, parent.end).find((b) => b.type === type);
}

/** Where `mvhd` keeps its timescale and duration, and how wide the duration is. */
interface MovieHeader {
  timescale: number;
  duration: number;
  /** Offset of the duration field. */
  durationAt: number;
  wide: boolean;
}

function readMovieHeader(view: DataView, mvhd: Box): MovieHeader | null {
  const version = view.getUint8(mvhd.body);
  // version 1: creation (8) + modification (8) + timescale (4) + duration (8), after the 4-byte
  // version/flags; version 0: 4 + 4 + 4 + 4.
  const wide = version === 1;
  const timescaleAt = mvhd.body + 4 + (wide ? 16 : 8);
  const durationAt = timescaleAt + 4;
  if (durationAt + (wide ? 8 : 4) > mvhd.end) return null;
  const timescale = view.getUint32(timescaleAt);
  const duration = wide ? Number(view.getBigUint64(durationAt)) : view.getUint32(durationAt);
  return { timescale, duration, durationAt, wide };
}

/** Each track's timescale (`mdhd`) and default sample duration (`trex`), by track id. */
interface TrackFacts {
  timescale: number;
  defaultDuration: number;
}

function readTracks(view: DataView, moov: Box): Map<number, TrackFacts> {
  const tracks = new Map<number, TrackFacts>();
  for (const trak of childBoxes(view, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const tkhd = child(view, trak, 'tkhd');
    const mdhd = child(view, child(view, trak, 'mdia') ?? trak, 'mdhd');
    if (!tkhd || !mdhd) continue;
    const tkhdWide = view.getUint8(tkhd.body) === 1;
    const trackId = view.getUint32(tkhd.body + 4 + (tkhdWide ? 16 : 8));
    const mdhdWide = view.getUint8(mdhd.body) === 1;
    const timescale = view.getUint32(mdhd.body + 4 + (mdhdWide ? 16 : 8));
    tracks.set(trackId, { timescale, defaultDuration: 0 });
  }
  const mvex = child(view, moov, 'mvex');
  if (mvex) {
    for (const trex of childBoxes(view, mvex.body, mvex.end).filter((b) => b.type === 'trex')) {
      // version/flags (4), track_ID (4), default_sample_description_index (4), default_sample_duration (4)
      const id = view.getUint32(trex.body + 4);
      const facts = tracks.get(id);
      if (facts) facts.defaultDuration = view.getUint32(trex.body + 12);
    }
  }
  return tracks;
}

/**
 * The end time of one `traf`, in its track's timescale: `start` (its `tfdt`, else where the track's
 * previous fragment ended) plus the durations of its samples. The track's FIRST start is kept in
 * `starts`: a track whose decode time does not begin at 0 (an edit, a cut from a longer recording)
 * lasts `end - firstStart`, not `end`.
 */
function trafEnd(
  view: DataView,
  traf: Box,
  tracks: Map<number, TrackFacts>,
  ends: Map<number, number>,
  starts: Map<number, number>
): void {
  const tfhd = child(view, traf, 'tfhd');
  if (!tfhd) return;
  const flags = view.getUint32(tfhd.body) & 0xffffff;
  const trackId = view.getUint32(tfhd.body + 4);
  let at = tfhd.body + 8;
  if (flags & 0x1) at += 8; // base-data-offset
  if (flags & 0x2) at += 4; // sample-description-index
  let defaultDuration = tracks.get(trackId)?.defaultDuration ?? 0;
  if (flags & 0x8) defaultDuration = view.getUint32(at);

  const tfdt = child(view, traf, 'tfdt');
  let time = ends.get(trackId) ?? 0;
  if (tfdt) {
    const wide = view.getUint8(tfdt.body) === 1;
    time = wide ? Number(view.getBigUint64(tfdt.body + 4)) : view.getUint32(tfdt.body + 4);
  }
  if (!starts.has(trackId)) starts.set(trackId, time);
  for (const trun of childBoxes(view, traf.body, traf.end).filter((b) => b.type === 'trun')) {
    const trunFlags = view.getUint32(trun.body) & 0xffffff;
    const count = view.getUint32(trun.body + 4);
    let p = trun.body + 8;
    if (trunFlags & 0x1) p += 4; // data-offset
    if (trunFlags & 0x4) p += 4; // first-sample-flags
    const stride =
      (trunFlags & 0x100 ? 4 : 0) +
      (trunFlags & 0x200 ? 4 : 0) +
      (trunFlags & 0x400 ? 4 : 0) +
      (trunFlags & 0x800 ? 4 : 0);
    if (!(trunFlags & 0x100)) {
      time += count * defaultDuration;
      continue;
    }
    for (let i = 0; i < count && p + 4 <= trun.end; i++, p += stride) {
      time += view.getUint32(p);
    }
  }
  ends.set(trackId, Math.max(ends.get(trackId) ?? 0, time));
}

/** What {@link readMp4Duration} found. */
export interface Mp4DurationReading {
  /** The clip's length from its samples, in seconds, or `null` when it is not a fragmented MP4. */
  samplesSeconds: number | null;
  /** What its `mvhd` declares, in seconds (`0` when undeclared), or `null` without one. */
  declaredSeconds: number | null;
  /**
   * Whether the top-level boxes tile the bytes exactly. A truncated file (a prefix, a damaged size)
   * does not: its fragments say how long the PART lasts, which is not the movie's length.
   */
  complete: boolean;
}

/** The top-level boxes of `bytes`, and whether they end exactly where the bytes do. */
function topLevel(view: DataView, length: number): { boxes: Box[]; complete: boolean } {
  const boxes = childBoxes(view, 0, length);
  const complete = boxes.length > 0 && boxes[boxes.length - 1].end === length;
  return { boxes, complete };
}

/**
 * Writes `want` (in the header's timescale) into the `mvhd` duration field of `view`, when the field
 * says less and can hold it. Returns whether it wrote.
 */
function setMovieDuration(
  view: DataView,
  header: MovieHeader,
  want: number,
  what: string
): boolean {
  if (!Number.isFinite(want) || want <= 0 || header.duration >= want) return false;
  if (header.wide) {
    view.setBigUint64(header.durationAt, BigInt(want));
    return true;
  }
  if (want <= 0xffffffff) {
    view.setUint32(header.durationAt, want);
    return true;
  }
  // A u32 header cannot hold it (over ~20 h at 57600/s): a clip Canari never writes. Said, not hidden.
  console.warn(`[mp4-duration] ${what} does not fit a v0 mvhd`);
  return false;
}

/**
 * Reads how long a fragmented MP4 lasts from its fragments, and what its header declares. Never
 * throws: bytes it cannot walk give `null`s.
 */
export function readMp4Duration(bytes: Uint8Array): Mp4DurationReading {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { boxes: top, complete } = topLevel(view, bytes.byteLength);
    const moov = top.find((b) => b.type === 'moov');
    const mvhd = moov ? child(view, moov, 'mvhd') : undefined;
    const header = mvhd ? readMovieHeader(view, mvhd) : null;
    const declaredSeconds =
      header && header.timescale > 0 ? header.duration / header.timescale : null;
    const moofs = top.filter((b) => b.type === 'moof');
    if (!moov || moofs.length === 0) return { samplesSeconds: null, declaredSeconds, complete };
    const tracks = readTracks(view, moov);
    const ends = new Map<number, number>();
    const starts = new Map<number, number>();
    for (const moof of moofs) {
      for (const traf of childBoxes(view, moof.body, moof.end).filter((b) => b.type === 'traf')) {
        trafEnd(view, traf, tracks, ends, starts);
      }
    }
    let longest = 0;
    for (const [id, end] of ends) {
      const timescale = tracks.get(id)?.timescale ?? 0;
      const length = end - (starts.get(id) ?? 0);
      if (timescale > 0 && length > 0) longest = Math.max(longest, length / timescale);
    }
    return {
      samplesSeconds: Number.isFinite(longest) && longest > 0 ? longest : null,
      declaredSeconds,
      complete,
    };
  } catch (e) {
    Log.d('mp4Duration', `the container could not be walked: ${String(e)}`);
    return { samplesSeconds: null, declaredSeconds: null, complete: false };
  }
}

/** What {@link declareMp4Duration} did, for the caller's log. */
export type Mp4DurationOutcome =
  /** The header already declared the samples' length (or more): nothing written. */
  | { kind: 'declared'; seconds: number }
  /** The header said less (an undeclared 0): the samples' length was written into it. */
  | { kind: 'written'; seconds: number; was: number }
  /** Not a fragmented MP4 with a movie header: nothing to say, nothing written. */
  | { kind: 'not-fragmented' };

/**
 * Writes a fragmented MP4's real length into its `mvhd`, IN PLACE, when the header says less than
 * its samples last. The field keeps its width, so no offset in the file moves (the fragments'
 * `trun` offsets are relative to their `moof`, the `mfra`'s are absolute - both stay true).
 */
export function declareMp4Duration(bytes: Uint8Array): Mp4DurationOutcome {
  const reading = readMp4Duration(bytes);
  // A TRUNCATED file is never written: its fragments measure the part, not the movie.
  if (!reading.complete || reading.samplesSeconds === null || reading.declaredSeconds === null) {
    return { kind: 'not-fragmented' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = movieHeaderOf(view, bytes.byteLength);
  if (!header) return { kind: 'not-fragmented' };
  const want = Math.round(reading.samplesSeconds * header.timescale);
  if (header.duration >= want) return { kind: 'declared', seconds: reading.declaredSeconds };
  if (!setMovieDuration(view, header, want, `${reading.samplesSeconds.toFixed(1)} s`)) {
    return { kind: 'not-fragmented' };
  }
  return { kind: 'written', seconds: reading.samplesSeconds, was: reading.declaredSeconds };
}

/** The `mvhd` of the `moov` among the top-level boxes of `[0, length)`, when it can be read. */
function movieHeaderOf(view: DataView, length: number): MovieHeader | null {
  const moov = childBoxes(view, 0, length).find((b) => b.type === 'moov');
  const mvhd = moov ? child(view, moov, 'mvhd') : undefined;
  const header = mvhd ? readMovieHeader(view, mvhd) : null;
  return header && header.timescale > 0 ? header : null;
}

/**
 * A COPY of a file's HEAD - its first bytes, holding the `moov` - with `seconds` written into its
 * `mvhd` duration when the header says less; `null` when there is nothing to write (no complete
 * `moov` in the head, a header that already says it, a length that is not a positive number).
 *
 * The stream builds the whole file from its segments (`segmentedMediaStream.ts`) and patches only
 * this head, so the rest of the file stays the engine's spilled `Blob`s and is never copied into the
 * JS heap. The length comes from what was played (the source's `duration` after `endOfStream`, or the
 * sender's declared one), not from the fragments, which the head does not hold. Never throws.
 */
export function writeMvhdDuration(
  head: Uint8Array,
  seconds: number
): Uint8Array<ArrayBuffer> | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  try {
    const copy = new Uint8Array(head);
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    const header = movieHeaderOf(view, copy.byteLength);
    if (!header) return null;
    const want = Math.round(seconds * header.timescale);
    return setMovieDuration(view, header, want, `${seconds.toFixed(1)} s`) ? copy : null;
  } catch (e) {
    Log.d('mp4Duration', `the head could not be walked: ${String(e)}`);
    return null;
  }
}

/** Whether a MIME type names an MP4 container - the only one {@link declareMp4Duration} reads. */
export function isMp4Type(mimeType: string): boolean {
  return /^video\/mp4\b/i.test(mimeType.trim());
}

/** What {@link readMp4TailDuration} found in a file's last bytes. */
export type Mp4TailReading =
  /** The movie's length, in seconds, from its last fragments. */
  | { kind: 'seconds'; seconds: number }
  /** The last fragment starts before the tail: bytes from `from` (an absolute offset) are needed. */
  | { kind: 'earlier'; from: number }
  /** The tail cannot say: `why` names what was missing, for the caller's log. */
  | { kind: 'unreadable'; why: string };

/** The `tfra` facts of one track: when its first and last random-access fragments start, and where the last one is. */
interface TrackRandomAccess {
  firstTime: number;
  lastTime: number;
  lastMoof: number;
}

/** Reads every `tfra` of an `mfra` (ISO/IEC 14496-12, 8.8.10). */
function readRandomAccess(view: DataView, mfra: Box): Map<number, TrackRandomAccess> {
  const out = new Map<number, TrackRandomAccess>();
  for (const tfra of childBoxes(view, mfra.body, mfra.end).filter((b) => b.type === 'tfra')) {
    const wide = view.getUint8(tfra.body) === 1;
    const trackId = view.getUint32(tfra.body + 4);
    const sizes = view.getUint32(tfra.body + 8);
    const count = view.getUint32(tfra.body + 12);
    // traf_number, trun_number and sample_number, each (length_size_of_* + 1) bytes wide.
    const tail = ((sizes >> 4) & 3) + 1 + (((sizes >> 2) & 3) + 1) + ((sizes & 3) + 1);
    const stride = (wide ? 16 : 8) + tail;
    if (count === 0 || tfra.body + 16 + count * stride > tfra.end) continue;
    const read = (at: number) => (wide ? Number(view.getBigUint64(at)) : view.getUint32(at));
    const first = tfra.body + 16;
    const last = first + (count - 1) * stride;
    out.set(trackId, {
      firstTime: read(first),
      lastTime: read(last),
      lastMoof: read(last + (wide ? 8 : 4)),
    });
  }
  return out;
}

/**
 * HOW LONG A STREAMED FRAGMENTED MP4 LASTS, FROM ITS HEAD AND ITS TAIL ONLY (owner, 2026-11-11: a
 * CanaReel streamed by segments showed no seek line - its engine read `Infinity`). A file written
 * before its writer declared its length (`prepareVideoForUpload`) says nothing in its `moov`, and a
 * stream does not hold the whole file until its last segment - which a paced stream may never
 * fetch. But the muxer ends every file with an `mfra`: its `tfra` entries say where each track's
 * LAST fragment starts (time and byte offset), the `mfro` closing the file says how long the `mfra`
 * is, and that last fragment's `trun` says how long it lasts. So the length is read from the
 * `moov` (in the head) and the file's last bytes, never from the middle.
 *
 * @param head      The file's first bytes, holding the complete `moov` (the stream's first segment).
 * @param tail      The file's last bytes, ending exactly where the file ends.
 * @param tailStart The absolute offset of `tail`'s first byte in the file.
 * @returns The seconds; or `earlier` with the offset the tail must reach back to; or `unreadable`
 *   naming what was missing. Never throws.
 */
export function readMp4TailDuration(
  head: Uint8Array,
  tail: Uint8Array,
  tailStart: number
): Mp4TailReading {
  try {
    const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
    // The head is cut mid-file: the walk stops at the first box it overruns, after the `moov`.
    const moov = childBoxes(headView, 0, head.byteLength).find((b) => b.type === 'moov');
    if (!moov) return { kind: 'unreadable', why: 'no moov in the head' };
    const tracks = readTracks(headView, moov);

    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const n = tail.byteLength;
    if (n < 16 || String.fromCharCode(...tail.subarray(n - 12, n - 8)) !== 'mfro') {
      return { kind: 'unreadable', why: 'no mfro at the end of the file' };
    }
    const mfraSize = view.getUint32(n - 4);
    const mfraAt = n - mfraSize;
    if (mfraSize < 16 || mfraAt < 0)
      return { kind: 'unreadable', why: 'the mfra overruns the tail' };
    const mfra = childBoxes(view, mfraAt, n)[0];
    if (!mfra || mfra.type !== 'mfra' || mfra.end !== n) {
      return { kind: 'unreadable', why: 'the mfro does not point at an mfra' };
    }
    const access = readRandomAccess(view, mfra);
    if (access.size === 0) return { kind: 'unreadable', why: 'the mfra lists no fragment' };

    // Every top-level box from the earliest LAST fragment to the mfra: fragments without a sync
    // sample are not in the `tfra`, so the walk goes on to the end rather than stop at the listed one.
    const from = Math.min(...[...access.values()].map((a) => a.lastMoof));
    if (from < tailStart) return { kind: 'earlier', from };
    const boxes = childBoxes(view, from - tailStart, mfraAt);
    if (boxes.length === 0 || boxes[boxes.length - 1].end !== mfraAt || boxes[0].type !== 'moof') {
      return { kind: 'unreadable', why: 'the last fragments do not tile up to the mfra' };
    }
    const ends = new Map<number, number>();
    const starts = new Map<number, number>();
    // A traf with no tfdt continues from where the tfra says its fragment starts.
    for (const [id, a] of access) ends.set(id, a.lastTime);
    for (const moof of boxes.filter((b) => b.type === 'moof')) {
      for (const traf of childBoxes(view, moof.body, moof.end).filter((b) => b.type === 'traf')) {
        trafEnd(view, traf, tracks, ends, starts);
      }
    }
    let longest = 0;
    for (const [id, end] of ends) {
      const timescale = tracks.get(id)?.timescale ?? 0;
      const first = access.get(id)?.firstTime ?? 0;
      if (timescale > 0 && end > first) longest = Math.max(longest, (end - first) / timescale);
    }
    return Number.isFinite(longest) && longest > 0
      ? { kind: 'seconds', seconds: longest }
      : { kind: 'unreadable', why: 'the last fragments carry no sample' };
  } catch (e) {
    return { kind: 'unreadable', why: `the tail could not be walked: ${String(e)}` };
  }
}
