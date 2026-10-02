/**
 * The capture's rules (CanaReels R3, C4): a press held past the threshold records until it lifts, a
 * tap toggles, the cap ends a take whatever the gesture, and the container is the platform's.
 */
import { describe, expect, it } from 'vitest';
import {
  SHUTTER_HOLD_THRESHOLD_MS,
  captureReducer,
  classifyLimitsFault,
  classifyShutterPress,
  formatTakeTime,
  pickReelRecorderMime,
  ringFraction,
  type CaptureState,
  type ReelClip,
} from './reelCapture';

const clip: ReelClip = { blob: new Blob(['x'], { type: 'video/webm' }), source: 'camera' };
const ready: CaptureState = { kind: 'ready' };

describe('classifyShutterPress', () => {
  it('reads a short press as a tap and a long one as a hold', () => {
    expect(classifyShutterPress(0)).toBe('tap');
    expect(classifyShutterPress(SHUTTER_HOLD_THRESHOLD_MS - 1)).toBe('tap');
    expect(classifyShutterPress(SHUTTER_HOLD_THRESHOLD_MS)).toBe('hold');
  });
});

describe('captureReducer', () => {
  it('a HOLD records from the press and ends at the release', () => {
    const recording = captureReducer(ready, { type: 'press', at: 1000 });
    expect(recording).toEqual({ kind: 'recording', pressedAt: 1000, mode: 'pending' });
    expect(captureReducer(recording, { type: 'release', at: 3000 })).toEqual({ kind: 'finishing' });
  });

  it('a TAP starts a take that the release does not end, and the next press does', () => {
    const recording = captureReducer(ready, { type: 'press', at: 1000 });
    const toggled = captureReducer(recording, { type: 'release', at: 1100 });
    expect(toggled).toEqual({ kind: 'recording', pressedAt: 1000, mode: 'toggle' });
    expect(captureReducer(toggled, { type: 'release', at: 5000 })).toBe(toggled);
    expect(captureReducer(toggled, { type: 'press', at: 9000 })).toEqual({ kind: 'finishing' });
  });

  it('the cap ends a take whether held or toggled', () => {
    const held: CaptureState = { kind: 'recording', pressedAt: 0, mode: 'pending' };
    const toggled: CaptureState = { kind: 'recording', pressedAt: 0, mode: 'toggle' };
    expect(captureReducer(held, { type: 'limit' })).toEqual({ kind: 'finishing' });
    expect(captureReducer(toggled, { type: 'limit' })).toEqual({ kind: 'finishing' });
  });

  it('a finished take is reviewed, and a discard returns to the preview', () => {
    const review = captureReducer({ kind: 'finishing' }, { type: 'stopped', clip });
    expect(review).toEqual({ kind: 'review', clip });
    expect(captureReducer(review, { type: 'discard' })).toEqual(ready);
  });

  it('a gallery pick goes straight to review, and only from the preview', () => {
    expect(captureReducer(ready, { type: 'picked', clip })).toEqual({ kind: 'review', clip });
    const recording: CaptureState = { kind: 'recording', pressedAt: 0, mode: 'toggle' };
    expect(captureReducer(recording, { type: 'picked', clip })).toBe(recording);
  });

  it('a failed recorder returns to the preview from recording or finishing', () => {
    expect(
      captureReducer({ kind: 'recording', pressedAt: 0, mode: 'pending' }, { type: 'failed' })
    ).toEqual(ready);
    expect(captureReducer({ kind: 'finishing' }, { type: 'failed' })).toEqual(ready);
  });

  it('touches that decide nothing leave the state alone', () => {
    expect(captureReducer(ready, { type: 'release', at: 1 })).toBe(ready);
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
