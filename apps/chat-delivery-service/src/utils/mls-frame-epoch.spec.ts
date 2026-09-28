import { mlsFrameEpoch } from './mls-frame-epoch';

/** Builds `version || wire_format || group_id<V> || epoch || rest`, the header RFC 9420 puts in clear. */
function frame(
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

const GROUP = '68227a77-0515-43d7-b7ee-2943bfa78f1f';

describe('mlsFrameEpoch', () => {
  it('reads an application frame (PrivateMessage) at its epoch', () => {
    expect(mlsFrameEpoch(frame(2, GROUP, 12n))).toBe(12);
  });

  it('reads a commit (PublicMessage) at its base epoch', () => {
    expect(mlsFrameEpoch(frame(1, GROUP, 11n))).toBe(11);
  });

  it('honours the two- and four-byte length prefixes', () => {
    expect(mlsFrameEpoch(frame(2, GROUP, 7n, 2))).toBe(7);
    expect(mlsFrameEpoch(frame(2, GROUP, 7n, 4))).toBe(7);
  });

  it('answers null for anything that is not a framed MLS 1.0 message', () => {
    // A Welcome is wire_format 3: it carries no clear epoch, and the rule does not speak about it.
    expect(mlsFrameEpoch(frame(3, GROUP, 5n))).toBeNull();
    expect(
      mlsFrameEpoch(Buffer.from([0x00, 0x02, 0x00, 0x02, 0x00]).toString('base64'))
    ).toBeNull();
    expect(mlsFrameEpoch(frame(2, GROUP, 5n).slice(0, 20))).toBeNull();
    expect(mlsFrameEpoch('')).toBeNull();
  });
});
