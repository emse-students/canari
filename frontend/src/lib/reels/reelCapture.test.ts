/**
 * The capture's rules (CanaReels R3, C4): ONE shutter - a tap is a photo, a press that stays down
 * past the threshold is a video that its release ends - and the cap ends a take whatever the gesture.
 */
import { describe, expect, it } from 'vitest';
import {
  SHUTTER_HOLD_THRESHOLD_MS,
  captureReducer,
  classifyLimitsFault,
  formatTakeTime,
  pickReelRecorderMime,
  ringFraction,
  shutterRingFraction,
  type CaptureState,
  type ReelClip,
} from './reelCapture';

const clip: ReelClip = { blob: new Blob(['x'], { type: 'video/webm' }), source: 'camera' };
const ready: CaptureState = { kind: 'ready' };
const pressing: CaptureState = { kind: 'pressing', pressedAt: 1000 };
const recording: CaptureState = { kind: 'recording', pressedAt: 1000 };

describe('the hold threshold', () => {
  it('is in the 300-400 ms band phone cameras use', () => {
    expect(SHUTTER_HOLD_THRESHOLD_MS).toBeGreaterThanOrEqual(300);
    expect(SHUTTER_HOLD_THRESHOLD_MS).toBeLessThanOrEqual(400);
  });
});

describe('captureReducer', () => {
  it('a press waits to learn what it is', () => {
    expect(captureReducer(ready, { type: 'press', at: 1000 })).toEqual(pressing);
  });

  it('a TAP (released before the threshold fired) takes a photo, which is then reviewed', () => {
    const photo = captureReducer(pressing, { type: 'release', at: 1100 });
    expect(photo).toEqual({ kind: 'photo' });
    expect(captureReducer(photo, { type: 'picked', clip })).toEqual({ kind: 'review', clip });
  });

  it('a HOLD starts recording under the finger, and its release ends the take', () => {
    const filming = captureReducer(pressing, { type: 'hold' });
    expect(filming).toEqual(recording);
    expect(captureReducer(filming, { type: 'release', at: 5000 })).toEqual({ kind: 'finishing' });
  });

  it('a cancelled touch before the threshold decides nothing: no photo, no take', () => {
    expect(captureReducer(pressing, { type: 'cancel' })).toEqual(ready);
  });

  it('a cancelled touch during a take ENDS it and keeps it', () => {
    expect(captureReducer(recording, { type: 'cancel' })).toEqual({ kind: 'finishing' });
  });

  it('a second press cannot end or restart a take - only the release, the cap or a cancel do', () => {
    expect(captureReducer(recording, { type: 'press', at: 9000 })).toBe(recording);
  });

  it('the cap ends a take', () => {
    expect(captureReducer(recording, { type: 'limit' })).toEqual({ kind: 'finishing' });
  });

  it('a finished take is reviewed, and a discard returns to the preview', () => {
    const review = captureReducer({ kind: 'finishing' }, { type: 'stopped', clip });
    expect(review).toEqual({ kind: 'review', clip });
    expect(captureReducer(review, { type: 'discard' })).toEqual(ready);
  });

  it('a gallery pick goes straight to review, and only from the preview', () => {
    expect(captureReducer(ready, { type: 'picked', clip })).toEqual({ kind: 'review', clip });
    expect(captureReducer(recording, { type: 'picked', clip })).toBe(recording);
    expect(captureReducer(pressing, { type: 'picked', clip })).toBe(pressing);
  });

  it('a failed photo, take or press returns to the preview', () => {
    expect(captureReducer({ kind: 'photo' }, { type: 'failed' })).toEqual(ready);
    expect(captureReducer(recording, { type: 'failed' })).toEqual(ready);
    expect(captureReducer({ kind: 'finishing' }, { type: 'failed' })).toEqual(ready);
    expect(captureReducer(pressing, { type: 'failed' })).toEqual(ready);
  });

  it('touches that decide nothing leave the state alone', () => {
    expect(captureReducer(ready, { type: 'release', at: 1 })).toBe(ready);
    expect(captureReducer(ready, { type: 'hold' })).toBe(ready);
    const finishing: CaptureState = { kind: 'finishing' };
    expect(captureReducer(finishing, { type: 'press', at: 1 })).toBe(finishing);
    const review: CaptureState = { kind: 'review', clip };
    expect(captureReducer(review, { type: 'press', at: 1 })).toBe(review);
  });
});

describe('pickReelRecorderMime', () => {
  const everything = () => true;
  it('records MP4 on iOS and WebM elsewhere (read on the phones 2026-10-01)', () => {
    expect(pickReelRecorderMime(true, everything)).toBe('video/mp4;codecs=avc1,mp4a');
    expect(pickReelRecorderMime(false, everything)).toBe('video/webm;codecs=vp9,opus');
  });

  it('takes the first the engine records, and none is null', () => {
    expect(pickReelRecorderMime(false, (t) => t === 'video/webm;codecs=vp8,opus')).toBe(
      'video/webm;codecs=vp8,opus'
    );
    expect(pickReelRecorderMime(true, () => false)).toBeNull();
  });
});

describe('ringFraction and formatTakeTime', () => {
  it('fills the ring to the cap and no further', () => {
    expect(ringFraction(0, 90_000)).toBe(0);
    expect(ringFraction(45_000, 90_000)).toBe(0.5);
    expect(ringFraction(120_000, 90_000)).toBe(1);
  });

  it('prints m:ss', () => {
    expect(formatTakeTime(0)).toBe('0:00');
    expect(formatTakeTime(61_900)).toBe('1:01');
    expect(formatTakeTime(90_000)).toBe('1:30');
  });
});

describe('classifyLimitsFault', () => {
  it('no status is unreachable; any status, the 500 and 400 of an older server included, is refused', () => {
    expect(classifyLimitsFault(null)).toBe('unreachable');
    expect(classifyLimitsFault(500)).toBe('refused');
    expect(classifyLimitsFault(400)).toBe('refused');
    expect(classifyLimitsFault(404)).toBe('refused');
  });
});

describe('shutterRingFraction', () => {
  it('follows the take while it records and while it finishes', () => {
    expect(shutterRingFraction({ kind: 'recording', pressedAt: 0 }, 45_000, 90_000)).toBe(0.5);
    expect(shutterRingFraction({ kind: 'finishing' }, 90_000, 90_000)).toBe(1);
  });

  it('is EMPTY in every other state, whatever the clock still holds (a cancelled take)', () => {
    for (const state of [ready, pressing, { kind: 'photo' }, { kind: 'review', clip }] as const) {
      expect(shutterRingFraction(state, 60_000, 90_000)).toBe(0);
    }
  });
});
