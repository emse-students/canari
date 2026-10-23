/**
 * THE EPOCH A SEALED FRAME WAS ENCRYPTED AT, READ FROM THE FRAME ITSELF.
 *
 * The send ledger (`sendRatchetLedger.ts`) counts each frame against the epoch whose ratchet it
 * spent, and the frame is the one place that answer is a FACT: `getEpoch` read beside the encrypt is
 * a second read of a state an incoming commit can move in between (and on native, a cache).
 *
 * RFC 9420 section 6: an `MLSMessage` opens with `version` (uint16, mls10 = 1) and `wire_format`
 * (uint16), and both a `PublicMessage` (1, through its `FramedContent`) and a `PrivateMessage` (2)
 * then carry `opaque group_id<V>` followed by `uint64 epoch`, in clear. `<V>` is the variable-length
 * prefix of section 2.1.2: the top two bits of the first byte give the prefix length (1, 2 or 4
 * bytes), the rest is the length. `mls-core/tests/burn_spent_generations.rs` pins this layout against
 * openmls's own reading (`MlsManager::parse_message_epoch`).
 */

/** The bytes handed in are not an MLS public or private message this reader can place an epoch in. */
export class UnreadableFrameEpochError extends Error {
  constructor(reason: string) {
    super(`the sealed frame carries no readable epoch: ${reason}`);
    this.name = 'UnreadableFrameEpochError';
  }
}

const MLS10 = 1;
const PUBLIC_MESSAGE = 1;
const PRIVATE_MESSAGE = 2;

/**
 * The epoch `frame` was sealed at. Throws {@link UnreadableFrameEpochError} for anything that is not
 * an mls10 public or private message, or whose epoch does not fit a JS number exactly.
 */
export function sealedFrameEpoch(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (frame.byteLength < 5) throw new UnreadableFrameEpochError(`${frame.byteLength} bytes`);
  const version = view.getUint16(0);
  if (version !== MLS10) throw new UnreadableFrameEpochError(`version ${version}`);
  const wireFormat = view.getUint16(2);
  if (wireFormat !== PUBLIC_MESSAGE && wireFormat !== PRIVATE_MESSAGE) {
    throw new UnreadableFrameEpochError(`wire format ${wireFormat}`);
  }
  const first = frame[4];
  const prefix = 1 << (first >> 6);
  if (prefix > 4) throw new UnreadableFrameEpochError('an invalid variable-length prefix');
  if (frame.byteLength < 4 + prefix) throw new UnreadableFrameEpochError('a truncated group id');
  let length = first & 0x3f;
  for (let i = 1; i < prefix; i++) length = length * 256 + frame[4 + i];
  const at = 4 + prefix + length;
  if (frame.byteLength < at + 8) throw new UnreadableFrameEpochError('a truncated epoch');
  const epoch = view.getBigUint64(at);
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnreadableFrameEpochError(`epoch ${epoch} past the exact range of a number`);
  }
  return Number(epoch);
}
