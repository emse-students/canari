/**
 * Builds the CLEAR header RFC 9420 gives a framed MLS message -
 * `version || wire_format || group_id<V> || epoch || rest` - as base64, the shape the send path
 * receives in `proto`. Wire format 1 is a `PublicMessage` (a commit), 2 a `PrivateMessage` (an
 * application frame), 3 a Welcome. `prefixBytes` picks the variable-length prefix of `group_id`;
 * `rest` is what follows the epoch, by default two bytes no field gives meaning to.
 */
export function mlsFrame(
  wireFormat: number,
  groupId: string,
  epoch: bigint,
  prefixBytes: 1 | 2 | 4 = 1,
  rest: number[] = [0xde, 0xad]
): string {
  const id = Buffer.from(groupId, 'ascii');
  let len: Buffer;
  if (prefixBytes === 1) len = Buffer.from([id.length]);
  else if (prefixBytes === 2) {
    len = Buffer.alloc(2);
    len.writeUInt16BE(0x4000 | id.length);
  } else {
    len = Buffer.alloc(4);
    // `>>> 0`: JavaScript's `|` answers a SIGNED 32-bit integer, and the top bit set reads negative.
    len.writeUInt32BE((0x80000000 | id.length) >>> 0);
  }
  const e = Buffer.alloc(8);
  e.writeBigUInt64BE(epoch);
  const head = Buffer.from([0x00, 0x01, 0x00, wireFormat]);
  return Buffer.concat([head, len, id, e, Buffer.from(rest)]).toString('base64');
}

/**
 * A well-formed EXTERNAL commit's clear part: a `PublicMessage` whose `FramedContent` continues
 * with `sender_type` new_member_commit (4), an empty `authenticated_data<V>` and `content_type`
 * commit (3), then a `Commit` - one ExternalInit proposal and the mandatory `UpdatePath`, whose
 * `LeafNode` carries a BasicCredential naming `leafIdentity` - the shape every production external
 * commit has (`readCommitFrame`). Keys are filler bytes: nothing on the server verifies them.
 */
export function externalCommitFrame(
  groupId: string,
  epoch: bigint,
  leafIdentity = 'user-1:device-1',
  prefixBytes: 1 | 2 | 4 = 1
) {
  return mlsFrame(1, groupId, epoch, prefixBytes, [
    4,
    0x00,
    3,
    ...externalCommitBody(leafIdentity),
  ]);
}

/** The `Commit` of an external join whose path leaf names `leafIdentity` (`externalCommitFrame`). */
export function externalCommitBody(leafIdentity: string): number[] {
  const key = (fill: number) => [32, ...Array.from({ length: 32 }, () => fill)];
  // ProposalOrRef: type proposal (1), proposal_type external_init (6), kem_output<V>.
  const externalInit = [1, 0x00, 0x06, ...key(0x11)];
  const identity = [...Buffer.from(leafIdentity, 'utf8')];
  return [
    externalInit.length,
    ...externalInit,
    1, // optional<UpdatePath>: present
    ...key(0x22), // encryption_key<V>
    ...key(0x33), // signature_key<V>
    0x00,
    0x01, // credential_type basic
    identity.length,
    ...identity,
    0xad, // the rest of the leaf node, which nothing here reads
  ];
}

/** A member commit as Canari sends one: a `PrivateMessage`, whose sender is encrypted. */
export function memberCommitFrame(groupId: string, epoch: bigint) {
  return mlsFrame(2, groupId, epoch);
}
