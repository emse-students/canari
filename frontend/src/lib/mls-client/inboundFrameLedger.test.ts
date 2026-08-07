import {
  frameFingerprint,
  noteFrameProcessed,
  hasFrameBeenProcessed,
  noteDesyncDetected,
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

describe('rate-limiting the desync signal', () => {
  it('signals once per group per window, then again after it', () => {
    // A rewound sender fails EVERY frame until its ratchet passes what we consumed, and each
    // signal asks the peer to retransmit - answering a storm with a storm.
    expect(noteDesyncDetected('g1', 1_000).signal).toBe(true);
    expect(noteDesyncDetected('g1', 2_000).signal).toBe(false);
    expect(noteDesyncDetected('g1', 30_999).signal).toBe(false);
    expect(noteDesyncDetected('g1', 31_000).signal).toBe(true);
  });

  it('rate-limits each group on its own', () => {
    expect(noteDesyncDetected('g1', 1_000).signal).toBe(true);
    expect(noteDesyncDetected('g2', 1_000).signal).toBe(true);
  });

  it('does not spend a rate-limited detection on the escalation counter', () => {
    // Two signals, and a swarm of losses in between that the window swallowed: the third SIGNAL is
    // what escalates, not the thirtieth frame.
    expect(noteDesyncDetected('g1', 0)).toEqual({ signal: true, escalate: false });
    for (let t = 1_000; t < 30_000; t += 1_000) {
      expect(noteDesyncDetected('g1', t)).toEqual({ signal: false, escalate: false });
    }
    expect(noteDesyncDetected('g1', 30_000)).toEqual({ signal: true, escalate: false });
    expect(noteDesyncDetected('g1', 60_000)).toEqual({ signal: false, escalate: true });
  });
});

describe('giving up on the narrow repair', () => {
  it('escalates on the third signal, and asks for a window on the first two', () => {
    expect(noteDesyncDetected('g1', 0)).toEqual({ signal: true, escalate: false });
    expect(noteDesyncDetected('g1', 40_000)).toEqual({ signal: true, escalate: false });
    // Three signals inside the window: the retransmission is not repairing this group.
    expect(noteDesyncDetected('g1', 80_000)).toEqual({ signal: false, escalate: true });
  });

  it('never signals AND escalates at once - a repair shown not to work is not worth sending', () => {
    const verdicts = [0, 40_000, 80_000].map((t) => noteDesyncDetected('g1', t));
    expect(verdicts.every((v) => !(v.signal && v.escalate))).toBe(true);
  });

  it('forgets signals that fall outside the window: unrelated losses are not one failing repair', () => {
    expect(noteDesyncDetected('g1', 0).escalate).toBe(false);
    expect(noteDesyncDetected('g1', 40_000).escalate).toBe(false);
    // Past 5 min the first two have aged out one by one, so what would have been the third and
    // fourth signal are only the second and first of a fresh episode - no escalation on either.
    expect(noteDesyncDetected('g1', 320_000)).toEqual({ signal: true, escalate: false });
    expect(noteDesyncDetected('g1', 360_000)).toEqual({ signal: true, escalate: false });
    // Three inside one window at last.
    expect(noteDesyncDetected('g1', 400_000)).toEqual({ signal: false, escalate: true });
  });

  it('clears the count when it fires, so the escalation gets its own chance', () => {
    [0, 40_000, 80_000].forEach((t) => noteDesyncDetected('g1', t));
    // Back to asking for a window: the diff has been started and must be allowed to land.
    expect(noteDesyncDetected('g1', 120_000)).toEqual({ signal: true, escalate: false });
    expect(noteDesyncDetected('g1', 160_000)).toEqual({ signal: true, escalate: false });
    expect(noteDesyncDetected('g1', 200_000)).toEqual({ signal: false, escalate: true });
  });

  it('counts each group on its own', () => {
    [0, 40_000].forEach((t) => noteDesyncDetected('g1', t));
    expect(noteDesyncDetected('g2', 80_000)).toEqual({ signal: true, escalate: false });
    expect(noteDesyncDetected('g1', 80_000)).toEqual({ signal: false, escalate: true });
  });

  it('forgets the count with the rest of the group state', () => {
    [0, 40_000].forEach((t) => noteDesyncDetected('g1', t));
    forgetFrameLedger('g1');
    expect(noteDesyncDetected('g1', 80_000)).toEqual({ signal: true, escalate: false });
  });
});
