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

  it('does not spend a rate-limited detection on the episode', () => {
    // A swarm of losses the rate limit swallowed must not look like a second episode.
    expect(noteDesyncDetected('g1', 0)).toEqual({ signal: true, escalate: true });
    for (let t = 1_000; t < 30_000; t += 1_000) {
      expect(noteDesyncDetected('g1', t)).toEqual({ signal: false, escalate: false });
    }
    expect(noteDesyncDetected('g1', 30_000)).toEqual({ signal: true, escalate: false });
  });
});

describe('reaching for the history diff', () => {
  it('solicits the diff on the FIRST detection, not after the narrow repair has failed', () => {
    // The narrow signal asks a rewound sender to re-encrypt at the same rewound ratchet, so
    // waiting for it to fail is waiting through the window in which messages are lost. Measured:
    // a 12-generation rewind lost five messages permanently and never reached a third signal.
    expect(noteDesyncDetected('g1', 0)).toEqual({ signal: true, escalate: true });
  });

  it('signals AND escalates at once - the two repairs are not alternatives', () => {
    const first = noteDesyncDetected('g1', 0);
    expect(first.signal && first.escalate).toBe(true);
  });

  it('does not re-solicit for the rest of the episode: the durable marker re-runs it', () => {
    expect(noteDesyncDetected('g1', 0)).toEqual({ signal: true, escalate: true });
    expect(noteDesyncDetected('g1', 40_000)).toEqual({ signal: true, escalate: false });
    expect(noteDesyncDetected('g1', 80_000)).toEqual({ signal: true, escalate: false });
  });

  it('treats losses past the window as a NEW episode, and escalates again', () => {
    expect(noteDesyncDetected('g1', 0).escalate).toBe(true);
    expect(noteDesyncDetected('g1', 40_000).escalate).toBe(false);
    // Past 5 min both have aged out, so this is a fresh episode rather than the tail of the old one.
    expect(noteDesyncDetected('g1', 400_000)).toEqual({ signal: true, escalate: true });
  });

  it('tracks each group on its own', () => {
    expect(noteDesyncDetected('g1', 0)).toEqual({ signal: true, escalate: true });
    expect(noteDesyncDetected('g2', 40_000)).toEqual({ signal: true, escalate: true });
    expect(noteDesyncDetected('g1', 40_000)).toEqual({ signal: true, escalate: false });
  });

  it('forgets the episode with the rest of the group state', () => {
    noteDesyncDetected('g1', 0);
    noteDesyncDetected('g1', 40_000);
    forgetFrameLedger('g1');
    expect(noteDesyncDetected('g1', 80_000)).toEqual({ signal: true, escalate: true });
  });
});
