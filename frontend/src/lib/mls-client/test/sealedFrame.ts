/**
 * A frame shaped as an MLS `PrivateMessage` on the wire (RFC 9420 section 6), for tests whose fake
 * platform seals: version mls10, wire format 2, `group_id<V>`, the `uint64` epoch - the header
 * `sealedFrameEpoch` reads - then `tail` standing in for the ciphertext. A test that needs to know
 * which generation a frame spent puts it in `tail`.
 */
export function sealedFrame(epoch: number, groupId = 'g', tail: Uint8Array = new Uint8Array()) {
  const id = new TextEncoder().encode(groupId);
  if (id.length > 63) throw new Error('sealedFrame: a test group id fits a one-byte prefix');
  const out = new Uint8Array(4 + 1 + id.length + 8 + tail.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 1);
  view.setUint16(2, 2);
  out[4] = id.length;
  out.set(id, 5);
  view.setBigUint64(5 + id.length, BigInt(epoch));
  out.set(tail, 5 + id.length + 8);
  return out;
}
