/**
 * The two pieces of RFC 9420's TLS presentation language this server reads: the variable-length
 * size prefix (section 2.1.2) and the opaque vector it prefixes. ONE implementation for every clear
 * MLS structure the server looks into, so two readers can never disagree on where a field ends.
 */

/** A position after a read, or null when the bytes run out or the prefix is not one the RFC allows. */
export interface TlsCursor {
  value: number;
  next: number;
}

/**
 * Reads a `<V>` size prefix: the top two bits of the first byte give the prefix length (1, 2 or 4
 * bytes); `11` is reserved by the RFC and refused.
 */
export function readMlsVarint(bytes: Buffer, offset: number): TlsCursor | null {
  if (offset >= bytes.length) return null;
  const prefix = bytes[offset] >> 6;
  if (prefix === 0) return { value: bytes[offset] & 0x3f, next: offset + 1 };
  if (prefix === 1) {
    if (bytes.length < offset + 2) return null;
    return { value: bytes.readUInt16BE(offset) & 0x3fff, next: offset + 2 };
  }
  if (prefix === 2) {
    if (bytes.length < offset + 4) return null;
    return { value: bytes.readUInt32BE(offset) & 0x3fffffff, next: offset + 4 };
  }
  return null;
}

/** Reads an `opaque x<V>`: its bytes and the offset after them, or null when truncated. */
export function readMlsOpaque(
  bytes: Buffer,
  offset: number
): { bytes: Buffer; next: number } | null {
  const size = readMlsVarint(bytes, offset);
  if (!size || bytes.length < size.next + size.value) return null;
  return {
    bytes: bytes.subarray(size.next, size.next + size.value),
    next: size.next + size.value,
  };
}
