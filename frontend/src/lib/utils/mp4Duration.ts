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
 * previous fragment ended) plus the durations of its samples.
 */
function trafEnd(
  view: DataView,
  traf: Box,
  tracks: Map<number, TrackFacts>,
  ends: Map<number, number>
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
}

/**
 * Reads how long a fragmented MP4 lasts from its fragments, and what its header declares. Never
 * throws: bytes it cannot walk give `null`s.
 */
export function readMp4Duration(bytes: Uint8Array): Mp4DurationReading {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const top = childBoxes(view, 0, bytes.byteLength);
    const moov = top.find((b) => b.type === 'moov');
    const mvhd = moov ? child(view, moov, 'mvhd') : undefined;
    const header = mvhd ? readMovieHeader(view, mvhd) : null;
    const declaredSeconds =
      header && header.timescale > 0 ? header.duration / header.timescale : null;
    const moofs = top.filter((b) => b.type === 'moof');
    if (!moov || moofs.length === 0) return { samplesSeconds: null, declaredSeconds };
    const tracks = readTracks(view, moov);
    const ends = new Map<number, number>();
    for (const moof of moofs) {
      for (const traf of childBoxes(view, moof.body, moof.end).filter((b) => b.type === 'traf')) {
        trafEnd(view, traf, tracks, ends);
      }
    }
    let longest = 0;
    for (const [id, end] of ends) {
      const timescale = tracks.get(id)?.timescale ?? 0;
      if (timescale > 0) longest = Math.max(longest, end / timescale);
    }
    return { samplesSeconds: longest > 0 ? longest : null, declaredSeconds };
  } catch (e) {
    Log.d('mp4Duration', `the container could not be walked: ${String(e)}`);
    return { samplesSeconds: null, declaredSeconds: null };
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
  if (reading.samplesSeconds === null || reading.declaredSeconds === null) {
    return { kind: 'not-fragmented' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = childBoxes(view, 0, bytes.byteLength).find((b) => b.type === 'moov')!;
  const header = readMovieHeader(view, child(view, moov, 'mvhd')!)!;
  const want = Math.round(reading.samplesSeconds * header.timescale);
  if (header.duration >= want) return { kind: 'declared', seconds: reading.declaredSeconds };
  if (header.wide) {
    view.setBigUint64(header.durationAt, BigInt(want));
  } else if (want <= 0xffffffff) {
    view.setUint32(header.durationAt, want);
  } else {
    // A u32 header cannot hold it (over ~20 h at 57600/s): a clip Canari never writes. Said, not hidden.
    console.warn(`[mp4-duration] ${reading.samplesSeconds.toFixed(1)} s does not fit a v0 mvhd`);
    return { kind: 'not-fragmented' };
  }
  return { kind: 'written', seconds: reading.samplesSeconds, was: reading.declaredSeconds };
}

/** Whether a MIME type names an MP4 container - the only one {@link declareMp4Duration} reads. */
export function isMp4Type(mimeType: string): boolean {
  return /^video\/mp4\b/i.test(mimeType.trim());
}
