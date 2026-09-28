/**
 * The epoch an MLS frame was sealed at, read from its CLEAR header - the one fact about a
 * ciphertext this server can know without a key.
 *
 * RFC 9420 section 6: an `MLSMessage` is `version (u16) || wire_format (u16) || body`, and both
 * framed bodies this server relays - `PublicMessage` (commits) and `PrivateMessage` (application
 * frames) - begin with `group_id<V> || epoch (u64)`, unencrypted, so a delivery service can route
 * them. `<V>` is the RFC's variable-length prefix (section 2.1.2): the top two bits of the first
 * byte give the prefix length (1, 2 or 4 bytes).
 *
 * WHY THE SERVER NEEDS IT (user, 2026-09-28). A device added while its phone was dead is `pending`
 * until its own join reports it, and it is queued every frame sealed at or after the epoch its
 * Welcome admits it at (`DeviceGroupMembership.admittedAtEpoch`). A member lagging one commit
 * behind can still seal at the older epoch, which the newcomer can never open - and the frame's own
 * header is what separates the two, so it is read rather than assumed.
 *
 * Checked against production-shaped rows on the local estate on 2026-09-27: every application
 * frame read the group's `activeEpoch`, every commit its base epoch (one below).
 *
 * @returns the epoch, or null for anything that is not a framed MLS 1.0 message (a Welcome, a
 *   GroupInfo, a KeyPackage, or bytes that do not parse). Null is an answer - "not a frame this
 *   rule speaks about" - and the caller routes on it rather than guessing.
 */
export function mlsFrameEpoch(protoBase64: string): number | null {
  const bytes = Buffer.from(protoBase64, 'base64');
  // version mls10 = 1; wire_format public_message = 1, private_message = 2.
  if (bytes.length < 5 || bytes.readUInt16BE(0) !== 1) return null;
  const wireFormat = bytes.readUInt16BE(2);
  if (wireFormat !== 1 && wireFormat !== 2) return null;

  let offset = 4;
  const prefix = bytes[offset] >> 6;
  let groupIdLength: number;
  if (prefix === 0) {
    groupIdLength = bytes[offset] & 0x3f;
    offset += 1;
  } else if (prefix === 1) {
    if (bytes.length < offset + 2) return null;
    groupIdLength = bytes.readUInt16BE(offset) & 0x3fff;
    offset += 2;
  } else if (prefix === 2) {
    if (bytes.length < offset + 4) return null;
    groupIdLength = bytes.readUInt32BE(offset) & 0x3fffffff;
    offset += 4;
  } else {
    return null;
  }
  offset += groupIdLength;
  if (bytes.length < offset + 8) return null;
  const epoch = bytes.readBigUInt64BE(offset);
  return epoch > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(epoch);
}
