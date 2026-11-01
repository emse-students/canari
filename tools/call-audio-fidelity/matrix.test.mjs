/**
 * Self-test of the verdict: a clean result passes, and the app worker's own witness lines fail a
 * row even when every audio metric reads clean - a gated row may not log a non-Opus payload.
 * Run: `bun test tools/call-audio-fidelity`.
 */
import { describe, expect, it } from 'bun:test';
import { nsChecks, transformInPath, verdict, videoChecks, witnessLines } from './matrix.mjs';

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

  it('fails a noise-suppression row whose sender did not carry the processed track to the end', () => {
    const on = { state: 'on', sendsProcessed: true, fallbacks: 0, stats: { frames: 3000 } };
    expect(nsChecks({ ...clean(), ns: on })).toEqual([['ns-on', true]]);
    expect(nsChecks(clean())).toEqual([]);
    for (const ns of [
      { ...on, state: 'unavailable', sendsProcessed: false, fallbacks: 1 },
      { ...on, sendsProcessed: false },
      { ...on, fallbacks: 1 },
      { ...on, stats: null },
    ]) {
      expect(verdict({ ...clean(), ns })).toMatchObject({ pass: false, failed: ['ns-on'] });
    }
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

/** A video row's measurement, as `rig.mjs` writes it (the numbers of the 2026-10-20 run). */
function cleanVideo() {
  const r = clean();
  r.videoPath = {
    senderFrames: 1084,
    receiverFrames: 1077,
    decrypted: 1077,
    decryptFailed: 0,
    codec: 'video/VP8',
    fps: 29.9,
    freezes: 0,
    keyFramesDecoded: 3,
    pictures: { local: { rgb: [6, 147, 2] }, remote: { rgb: [4, 148, 1] } },
    remoteEvents: ['unmute'],
  };
  return r;
}

describe('the video checks (lot 2)', () => {
  it('passes the measured clean video row', () => {
    expect(verdict(cleanVideo())).toMatchObject({ pass: true, failed: [] });
  });

  it('adds nothing to an audio row', () => {
    expect(videoChecks(clean())).toEqual([]);
  });

  it('fails a bare video sender: no frame in the sender transform, every receiver frame failing', () => {
    const r = cleanVideo();
    r.videoPath.senderFrames = 0;
    r.videoPath.decrypted = 0;
    r.videoPath.decryptFailed = 1103;
    expect(verdict(r).failed).toEqual(['video-in-path', 'video-decrypted']);
  });

  it('fails a whole-frame VP8 (a key frame storm) and an H.264 call', () => {
    const storm = cleanVideo();
    storm.videoPath.keyFramesDecoded = 509;
    expect(verdict(storm).failed).toEqual(['video-keyframes']);
    const h264 = cleanVideo();
    h264.videoPath.codec = 'video/H264';
    expect(verdict(h264).failed).toEqual(['video-codec']);
  });

  it('fails a picture that is not the one sent, and a camera-off that never muted the peer', () => {
    const r = cleanVideo();
    r.videoPath.pictures.remote.rgb = [120, 30, 200];
    r.videoPath.offState = { muted: false };
    r.videoPath.remoteEvents = ['unmute'];
    expect(verdict(r).failed).toEqual(['video-picture', 'video-mute-when-off']);
  });
});
