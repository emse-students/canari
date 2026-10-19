/**
 * Self-test of the verdict: a clean result passes, and the app worker's own witness lines fail a
 * row even when every audio metric reads clean - a gated row may not log a non-Opus payload.
 * Run: `bun test tools/call-audio-fidelity`.
 */
import { describe, expect, it } from 'bun:test';
import { transformInPath, verdict, witnessLines } from './matrix.mjs';

/** A result shaped like `rig.mjs` writes one, every metric clean. */
function clean(log = []) {
  return {
    gated: true,
    metrics: {
      matchCoef: 0.98,
      bandwidthHz: 10_412,
      clippedSamples: 0,
      dropouts: { ms: 170 },
      segments: { speech: { lsdDb: 3.95, hfLossDb: -2 } },
    },
    bitExact: { measured: { corrupted: 0 } },
    concealedPct: 0,
    log,
  };
}

describe('verdict', () => {
  it('passes a clean result with an ordinary log', () => {
    const v = verdict(clean(['caller worker {"type":"warn","detail":"x"}']));
    expect(v).toMatchObject({ pass: true, ok: true, failed: [] });
  });

  it('fails a clean-sounding result whose worker named a non-Opus payload', () => {
    const r = clean([
      'callee worker {"type":"opusInvalid","side":"receiver","count":1}',
      'callee worker {"type":"doubleEncrypted","count":1}',
    ]);
    expect(witnessLines(r)).toBe(2);
    expect(verdict(r)).toMatchObject({ pass: false, failed: ['witness'] });
  });

  it('reads a result saved before the log existed as having no witness lines', () => {
    const r = clean();
    delete r.log;
    expect(witnessLines(r)).toBe(0);
  });

  it('fails an E2E row whose receiver transform was handed no frame - media around the worker', () => {
    const r = clean();
    r.transformPath = { e2e: true, senderFrames: 1722, receiverFrames: 0 };
    expect(transformInPath(r)).toBe(false);
    expect(verdict(r)).toMatchObject({ pass: false, failed: ['transform-in-path'] });
    r.transformPath = { e2e: false, senderFrames: 0, receiverFrames: 0 };
    expect(transformInPath(r)).toBe(true);
  });
});
