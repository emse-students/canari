import { sealedFrameEpoch, UnreadableFrameEpochError } from './sealedFrameEpoch';
import { sealedFrame } from './test/sealedFrame';

/**
 * The layout read here is pinned against openmls in
 * `mls-core/tests/burn_spent_generations.rs` (`a_sealed_frame_carries_its_epoch_...`); these cases
 * pin the reader's own arithmetic: the prefix lengths, the byte order, and what it refuses.
 */
describe('sealedFrameEpoch', () => {
  it('reads the epoch of a private message, past one byte', () => {
    expect(sealedFrameEpoch(sealedFrame(300, 'g-1', new Uint8Array([9, 9])))).toBe(300);
  });

  it('reads past a two-byte group id prefix', () => {
    const id = new Uint8Array(70).fill(97);
    const frame = new Uint8Array(4 + 2 + id.length + 8);
    const view = new DataView(frame.buffer);
    view.setUint16(0, 1);
    view.setUint16(2, 1); // a public message carries the same header
    view.setUint16(4, 0x4000 | id.length);
    frame.set(id, 6);
    view.setBigUint64(6 + id.length, 12n);
    expect(sealedFrameEpoch(frame)).toBe(12);
  });

  it('refuses what is not an mls10 public or private message, typed', () => {
    const welcome = sealedFrame(1);
    new DataView(welcome.buffer).setUint16(2, 3);
    expect(() => sealedFrameEpoch(welcome)).toThrow(UnreadableFrameEpochError);
    expect(() => sealedFrameEpoch(new Uint8Array([1, 2, 3]))).toThrow(UnreadableFrameEpochError);
    expect(() => sealedFrameEpoch(sealedFrame(1).slice(0, 10))).toThrow(UnreadableFrameEpochError);
  });
});
