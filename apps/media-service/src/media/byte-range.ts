/**
 * The ONE parser of an HTTP `Range` request header for this service (RFC 9110 section 14).
 *
 * WHY RANGES AT ALL (CanaReels R2): a segmented blob (`frontend/src/lib/mediaSegmented.ts`) is read
 * one ~1 MB segment at a time, so a video can play while the rest is still here. Without ranges the
 * client could only take the whole object, and nothing could play before its last byte.
 *
 * Only what that reader sends is served as a part: ONE range, `bytes=a-b`, `bytes=a-` or the suffix
 * `bytes=-n`. A multi-range request is answered with the whole object, which RFC 9110 permits ("a
 * server MAY ignore the Range header field") and which spares this service a `multipart/byteranges`
 * body nobody here would read. A header that is not a byte range at all is ignored the same way.
 */

/** What a `Range` header asks of an object of known size. */
export type ByteRangeRequest =
  /** No usable range: serve the whole object with `200`. */
  | { kind: 'whole' }
  /** Serve `[start, end]` (inclusive, as `Content-Range` writes it) with `206`. */
  | { kind: 'partial'; start: number; end: number }
  /** The range starts at or past the end: `416` with `Content-Range: bytes * /size`. */
  | { kind: 'unsatisfiable' };

/**
 * Reads a `Range` header against an object of `size` bytes.
 *
 * An end past the object is CLAMPED to its last byte, as RFC 9110 requires - which is what lets a
 * reader ask for "the header and a full first segment" without knowing how long the file is.
 *
 * @param header The raw header value, or undefined when there is none.
 * @param size   The object's length in bytes.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRangeRequest {
  if (!header) return { kind: 'whole' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Not a single byte range (another unit, a list of ranges, garbage): ignored, not refused.
  if (!match) return { kind: 'whole' };
  const [, first, last] = match;
  if (first === '' && last === '') return { kind: 'whole' };

  if (first === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(last);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    if (size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(first);
  const end = last === '' ? size - 1 : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'whole' };
  // `bytes=5-2` is syntactically invalid; RFC 9110 says to ignore it.
  if (last !== '' && end < start) return { kind: 'whole' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}
