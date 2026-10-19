/**
 * THE ONE fMP4 BOX READER OF THE LIVE - a pure reader, no DOM, no clock, no network.
 *
 * EVERY LIVE SEGMENT IS SELF-CONTAINED: the recorder's init (`ftyp` + `moov`) followed by ONE
 * fragment (`moof` + `mdat`), the broadcaster's shape. The viewer reads here where that init ends
 * ({@link initSegmentEnd}), so it appends an init only when it differs from the last one (a camera
 * re-acquired mid-live writes a new one) and the fragment after it.
 */

/** A malformed segment: a box this reader cannot frame. Classified here, never by message. */
export class Fmp4ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Fmp4ParseError';
  }
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

/**
 * The byte offset at which a segment's init (everything up to and including the top-level `moov`)
 * ends, or 0 when the bytes carry no complete `moov` before their media (a media-only fragment, or
 * a box cut short - the caller then treats the bytes as media).
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
