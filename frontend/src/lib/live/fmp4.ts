/**
 * WHERE A LIVE SEGMENT'S INIT ENDS - the one fact the viewer needs from the fMP4 container.
 *
 * `MediaRecorder` writes the initialisation (`ftyp` + `moov`) at the head of its FIRST chunk only:
 * on Android segment 0 is the init alone, on iOS it is the init followed by the first media
 * fragments (WP-L1, `tools/live-bench/bench.js` on `bench/live-wp-l1`). A viewer that joins later
 * appends the init ONCE, then media fragments only - so it must know where the init stops.
 */

/** Reads a big-endian unsigned 32-bit integer. */
function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** A four-character box type at `o`. */
function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/**
 * The byte offset at which the init (everything up to and including the top-level `moov`) ends,
 * or 0 when the bytes carry no `moov` (a media-only segment) or the box walk does not reach one
 * intact (a truncated or foreign file - the caller then treats the bytes as media).
 */
export function initSegmentEnd(bytes: Uint8Array): number {
  let o = 0;
  while (o + 8 <= bytes.length) {
    let size = u32(bytes, o);
    const type = fourcc(bytes, o + 4);
    if (size === 1) {
      // A 64-bit size follows; a live segment never needs one, but the walk must not misread it.
      if (o + 16 > bytes.length) return 0;
      const hi = u32(bytes, o + 8);
      const lo = u32(bytes, o + 12);
      size = hi * 2 ** 32 + lo;
    } else if (size === 0) {
      // "To the end of the file": nothing can follow it.
      size = bytes.length - o;
    }
    if (size < 8 || o + size > bytes.length) return 0;
    if (type === 'moov') return o + size;
    // Media began before any `moov`: there is no init in these bytes.
    if (type === 'moof' || type === 'mdat') return 0;
    o += size;
  }
  return 0;
}
