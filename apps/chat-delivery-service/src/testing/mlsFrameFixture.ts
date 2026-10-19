/**
 * Builds the CLEAR header RFC 9420 gives a framed MLS message -
 * `version || wire_format || group_id<V> || epoch || rest` - as base64, the shape the send path
 * receives in `proto`. Wire format 1 is a `PublicMessage` (a commit), 2 a `PrivateMessage` (an
 * application frame), 3 a Welcome. `prefixBytes` picks the variable-length prefix of `group_id`.
 */
export function mlsFrame(
  wireFormat: number,
  groupId: string,
  epoch: bigint,
  prefixBytes: 1 | 2 | 4 = 1
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
  return Buffer.concat([head, len, id, e, Buffer.from([0xde, 0xad])]).toString('base64');
}
