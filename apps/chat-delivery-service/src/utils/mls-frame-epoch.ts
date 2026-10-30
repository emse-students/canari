import { readLeafNodeHead } from './key-package-leaf';
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
  const bytes = Buffer.from(protoBase64, 'base64');
  return framedWireFormat(bytes) === null ? null : (readFramedHeader(bytes)?.epoch ?? null);
}

/**
 * What a submitted commit's CLEAR header says it is: the group and epoch it was built on, and
 * whether it is an EXTERNAL commit - the one way a device outside the tree commits. Null when it is
 * not the shape of either kind of commit Canari sends.
 *
 * RFC 9420 section 6. A member commit is a `PrivateMessage` (wire format 2): its sender and content
 * type are encrypted. An external commit is always a `PublicMessage` (section 12.4.3.2) whose
 * `FramedContent` continues `group_id<V> || epoch` with `sender_type` = `new_member_commit` (4),
 * `authenticated_data<V>` and `content_type` = commit (3), all in the clear. A `PublicMessage` that
 * is anything else is refused: Canari sends none. Measured on 5 000 production commits, 2026-10-22:
 * every member commit was a `PrivateMessage`, every `PublicMessage` a well-formed external commit,
 * and every header named its own group and the request's base epoch.
 *
 * AN EXTERNAL COMMIT ALSO NAMES ITS NEW LEAF, IN THE CLEAR. Its `Commit` follows the content type -
 * `proposals<V> || optional<UpdatePath>` - and RFC 9420 section 12.4.3.2 makes the path mandatory
 * there, so the joiner's `LeafNode`, and the BasicCredential identity in it, is readable without a
 * key (`leafIdentity`). An external commit with no path, or a non-basic credential, is refused:
 * no conforming client sends one. Its proposals are in the clear too, and the index of every
 * Remove among them is read (`removedLeaves`), because RFC 9420 lets an external commit remove only
 * the joiner's own prior leaf; anything but an inline ExternalInit or Remove is refused.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT: the bytes CLAIM a shape; this server holds no key to check
 * the signature. The commit gate pairs the claim with who may commit, the leaf identity with the
 * authenticated caller, and the group and epoch with the request's own.
 */
export function readCommitFrame(protoBase64: string): CommitFrame | null {
  const bytes = Buffer.from(protoBase64, 'base64');
  const wireFormat = framedWireFormat(bytes);
  if (wireFormat === null) return null;
  const header = readFramedHeader(bytes);
  if (!header) return null;
  if (wireFormat === 2) return { groupId: header.groupId, epoch: header.epoch, external: false };

  let offset = header.next;
  if (bytes.length < offset + 1 || bytes.readUInt8(offset) !== 4) return null;
  const authenticatedData = readMlsOpaque(bytes, offset + 1);
  if (!authenticatedData) return null;
  offset = authenticatedData.next;
  if (bytes.length < offset + 1 || bytes.readUInt8(offset) !== 3) return null;
  // Commit: proposals<V>, then optional<UpdatePath> (presence byte 1), whose first field is the
  // committer's new LeafNode.
  const proposals = readMlsOpaque(bytes, offset + 1);
  if (!proposals) return null;
  const removedLeaves = readExternalCommitRemovals(proposals.bytes);
  if (!removedLeaves) return null;
  if (bytes.length < proposals.next + 1 || bytes.readUInt8(proposals.next) !== 1) return null;
  const leaf = readLeafNodeHead(bytes, proposals.next + 1);
  if (!leaf) return null;
  return {
    groupId: header.groupId,
    epoch: header.epoch,
    external: true,
    leafIdentity: leaf.identity,
    removedLeaves,
  };
}

/** RFC 9420 `ProposalOrRefType.proposal` - an inline proposal. */
const PROPOSAL_INLINE = 1;
/** RFC 9420 `ProposalType.remove`. */
const PROPOSAL_REMOVE = 3;
/** RFC 9420 `ProposalType.external_init`. */
const PROPOSAL_EXTERNAL_INIT = 6;

/**
 * The leaf indices an external commit's Remove proposals name, read from its `proposals<V>`
 * contents - or null for any proposal a Canari external commit never carries.
 *
 * A Canari external commit holds one inline ExternalInit (`kem_output<V>`) and, when the joiner is
 * replacing its own prior leaf, one inline Remove (`removed`, a u32) - OpenMLS's external-commit
 * builder adds nothing else. A pre-shared key, a proposal by reference or any other type is
 * therefore not the shape this estate sends, and it is refused like every other malformed commit.
 */
function readExternalCommitRemovals(proposals: Buffer): number[] | null {
  const removed: number[] = [];
  let offset = 0;
  while (offset < proposals.length) {
    if (proposals.length < offset + 3 || proposals.readUInt8(offset) !== PROPOSAL_INLINE) {
      return null;
    }
    const type = proposals.readUInt16BE(offset + 1);
    offset += 3;
    if (type === PROPOSAL_EXTERNAL_INIT) {
      const kemOutput = readMlsOpaque(proposals, offset);
      if (!kemOutput) return null;
      offset = kemOutput.next;
    } else if (type === PROPOSAL_REMOVE) {
      if (proposals.length < offset + 4) return null;
      removed.push(proposals.readUInt32BE(offset));
      offset += 4;
    } else {
      return null;
    }
  }
  return removed;
}

/**
 * A commit's clear header, as `readCommitFrame` reads it. Only an external commit carries
 * `leafIdentity` and `removedLeaves`: a member commit is a `PrivateMessage`, whose content this
 * server cannot read. `removedLeaves` is the leaf index of every Remove the commit carries - empty
 * for a first join, one index for a joiner replacing its own prior leaf.
 */
export type CommitFrame =
  | { groupId: string; epoch: number; external: false }
  | {
      groupId: string;
      epoch: number;
      external: true;
      leafIdentity: string;
      removedLeaves: number[];
    };

/** The wire format of a framed MLS 1.0 message - `PublicMessage` (1) or `PrivateMessage` (2) - or null. */
function framedWireFormat(bytes: Buffer): 1 | 2 | null {
  // version mls10 = 1; wire_format public_message = 1, private_message = 2.
  if (bytes.length < 5 || bytes.readUInt16BE(0) !== 1) return null;
  const wireFormat = bytes.readUInt16BE(2);
  return wireFormat === 1 || wireFormat === 2 ? wireFormat : null;
}

/**
 * `group_id<V> || epoch` of a framed message (both wire formats begin with them), as the group id's
 * text - the server's group id IS the MLS group id - and the offset after the epoch.
 */
function readFramedHeader(bytes: Buffer): { groupId: string; epoch: number; next: number } | null {
  const groupId = readMlsOpaque(bytes, 4);
  if (!groupId) return null;
  const offset = groupId.next;
  if (bytes.length < offset + 8) return null;
  const epoch = bytes.readBigUInt64BE(offset);
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { groupId: groupId.bytes.toString('utf8'), epoch: Number(epoch), next: offset + 8 };
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
