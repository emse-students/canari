/** Packing PNGs into an ICO container, shared by every generator that writes one. */

/**
 * Packs already-encoded PNGs into an ICO container.
 *
 * The header is 6 bytes, then one 16-byte directory entry per image, then the
 * payloads. A dimension of 256 is written as 0, which is the format's own
 * convention - not a concern at these sizes, but writing the encoding rather
 * than the value keeps the function honest if a 256 is ever added.
 */
export function packIco(images) {
  const HEADER_BYTES = 6;
  const ENTRY_BYTES = 16;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = HEADER_BYTES + ENTRY_BYTES * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(ENTRY_BYTES);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette colours - 0 for truecolour
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}
