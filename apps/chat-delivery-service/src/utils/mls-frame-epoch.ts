import { readMlsOpaque } from './mls-tls';

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
  return readFramedHeader(protoBase64)?.epoch ?? null;
}

/**
 * Whether a commit's clear header names a `new_member_commit` sender - an EXTERNAL commit, the one
 * way a device that is not in the tree commits.
 *
 * RFC 9420 section 6: a `PublicMessage`'s `FramedContent` continues `group_id<V> || epoch` with the
 * `Sender`, whose first byte is its `sender_type` (member 1, external 2, new_member_proposal 3,
 * new_member_commit 4), unencrypted. A `PrivateMessage` encrypts its sender, and an external commit
 * is always a `PublicMessage` (section 12.4.3.2), so any other frame answers false.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT: the bytes CLAIM an external commit; this server holds no key
 * to check the signature. The commit gate therefore pairs the claim with who may join externally at
 * all - the same predicate that serves the external-join base (`getGroupInfo`).
 */
export function isExternalCommitFrame(protoBase64: string): boolean {
  const header = readFramedHeader(protoBase64);
  return header?.wireFormat === 1 && header.senderType === 4;
}

/**
 * The clear header of a framed MLS 1.0 message: wire format, epoch, and the `sender_type` byte when
 * the frame is a `PublicMessage` that carries one. Null for anything else or anything truncated.
 */
function readFramedHeader(
  protoBase64: string
): { wireFormat: number; epoch: number; senderType: number | null } | null {
  const bytes = Buffer.from(protoBase64, 'base64');
  // version mls10 = 1; wire_format public_message = 1, private_message = 2.
  if (bytes.length < 5 || bytes.readUInt16BE(0) !== 1) return null;
  const wireFormat = bytes.readUInt16BE(2);
  if (wireFormat !== 1 && wireFormat !== 2) return null;

  const groupId = readMlsOpaque(bytes, 4);
  if (!groupId) return null;
  const offset = groupId.next;
  if (bytes.length < offset + 8) return null;
  const epoch = bytes.readBigUInt64BE(offset);
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const senderType =
    wireFormat === 1 && bytes.length > offset + 8 ? bytes.readUInt8(offset + 8) : null;
  return { wireFormat, epoch: Number(epoch), senderType };
}

/**
 * How many PAST epochs of message secrets every Canari client keeps: `max_past_epochs(2)` in
 * `frontend/mls-core` (`group.rs`, `welcome.rs`). OpenMLS stores the current epoch plus this many
 * before it, so a member at epoch E opens frames sealed at E, E-1 and E-2, and nothing older.
 */
export const MLS_MAX_PAST_EPOCHS = 2;

/**
 * Whether a frame sealed at `frameEpoch` is already outside the past-epoch window of a member at
 * the group's `activeEpoch` - unreadable to every member that is up to date, the moment it is sent.
 *
 * WHY THE SERVER ASKS (backlog, 2026-10-12 console export): seed requests sealed at epochs 135-138
 * reached a key group at 141, no current member could open them, and each loss drove a re-ask. The
 * sender cannot know it is behind while the commits are still in flight to it; the server holds
 * both numbers at send time, so it is where the lagging sender is named.
 */
export function isBeyondPastEpochWindow(frameEpoch: number, activeEpoch: number): boolean {
  return frameEpoch < activeEpoch - MLS_MAX_PAST_EPOCHS;
}
