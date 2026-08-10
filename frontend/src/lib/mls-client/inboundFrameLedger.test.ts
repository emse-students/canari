import {
  frameFingerprint,
  noteFrameProcessed,
  hasFrameBeenProcessed,
  forgetFrameLedger,
  resetFrameLedgerForTests,
} from './inboundFrameLedger';

const bytes = (...v: number[]) => new Uint8Array(v);

beforeEach(() => resetFrameLedgerForTests());

describe('telling a double delivery from a rewind', () => {
  it('gives identical frames the same fingerprint and different frames different ones', () => {
    expect(frameFingerprint(bytes(1, 2, 3))).toBe(frameFingerprint(bytes(1, 2, 3)));
    expect(frameFingerprint(bytes(1, 2, 3))).not.toBe(frameFingerprint(bytes(1, 2, 4)));
    // Order matters: a rolling sum would collide on a permutation, and MLS frames of one
    // conversation share most of their bytes.
    expect(frameFingerprint(bytes(1, 2))).not.toBe(frameFingerprint(bytes(2, 1)));
    expect(frameFingerprint(bytes())).toBe(frameFingerprint(bytes()));
  });

  it('recognises a frame it has processed, and only in the group it processed it in', () => {
    const fp = frameFingerprint(bytes(9, 9, 9));
    noteFrameProcessed('g1', fp);

    expect(hasFrameBeenProcessed('g1', fp)).toBe(true);
    // The same generation is consumed independently per group; a hit in the wrong one would call a
    // real loss a duplicate.
    expect(hasFrameBeenProcessed('g2', fp)).toBe(false);
    expect(hasFrameBeenProcessed('g1', frameFingerprint(bytes(9, 9, 8)))).toBe(false);
  });

  it('forgets the oldest frames rather than growing without bound', () => {
    const first = frameFingerprint(bytes(0));
    noteFrameProcessed('g1', first);
    for (let i = 1; i <= 200; i++) noteFrameProcessed('g1', frameFingerprint(bytes(i, i >> 8)));

    expect(hasFrameBeenProcessed('g1', first)).toBe(false);
    expect(hasFrameBeenProcessed('g1', frameFingerprint(bytes(200, 0)))).toBe(true);
  });

  it('does not let a repeated frame evict 200 others by pushing the ring forward', () => {
    const fp = frameFingerprint(bytes(7));
    const other = frameFingerprint(bytes(8));
    noteFrameProcessed('g1', other);
    for (let i = 0; i < 500; i++) noteFrameProcessed('g1', fp);

    expect(hasFrameBeenProcessed('g1', other)).toBe(true);
  });

  it('drops a group on request', () => {
    const fp = frameFingerprint(bytes(1));
    noteFrameProcessed('g1', fp);
    forgetFrameLedger('g1');
    expect(hasFrameBeenProcessed('g1', fp)).toBe(false);
  });
});
