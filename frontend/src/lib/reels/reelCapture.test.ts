/**
 * The capture's rules (CanaReels R3, C4): ONE shutter - a tap is a photo, a press that stays down
 * past the threshold is a video that its release ends - and the cap ends a take whatever the gesture.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SHUTTER_HOLD_THRESHOLD_MS,
  captureFileFrom,
  captureReducer,
  destinationRules,
  handsBackTake,
  classifyLimitsFault,
  lensFlipAllowed,
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
    expect(pickReelRecorderMime(false, everything)).toBe('video/webm;codecs=h264,opus');
  });

  it('prefers hardware H.264 over software VP9 on Android, VP9 only without it (2026-10-09)', () => {
    expect(pickReelRecorderMime(false, (t) => t !== 'video/webm;codecs=h264,opus')).toBe(
      'video/webm;codecs=vp9,opus'
    );
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

describe('lensFlipAllowed', () => {
  it('lets the lens flip only before a take and while one records', () => {
    expect(lensFlipAllowed(ready)).toBe(true);
    expect(lensFlipAllowed(recording)).toBe(true);
  });

  it('refuses it while the press is being decided, a photo is read, a take finishes or is reviewed', () => {
    for (const state of [
      pressing,
      { kind: 'photo' },
      { kind: 'finishing' },
      { kind: 'review', clip },
    ] as const) {
      expect(lensFlipAllowed(state)).toBe(false);
    }
  });
});

describe('destinationRules (D-camera 2026-10-11; one camera, one behaviour 2026-10-19)', () => {
  it('a chat takes photos only, and hands the take back as a file', () => {
    expect(destinationRules('chat')).toEqual({
      photoOnly: true,
      microphone: 'never',
      photoHandsBack: true,
      videoHandsBack: true,
      fromComposer: false,
      gallery: false,
      soundRemoval: false,
    });
  });

  it('a NEW post hands a photo back, and sends a filmed video to the reel publish step', () => {
    expect(destinationRules('post')).toEqual({
      photoOnly: false,
      microphone: 'separate',
      photoHandsBack: true,
      videoHandsBack: false,
      fromComposer: true,
      gallery: false,
      soundRemoval: false,
    });
  });

  it('the post EDITOR hands every take back: an existing post never becomes a reel', () => {
    expect(destinationRules('post-edit')).toEqual({
      photoOnly: false,
      microphone: 'separate',
      photoHandsBack: true,
      videoHandsBack: true,
      fromComposer: false,
      gallery: false,
      soundRemoval: false,
    });
  });

  it('the feed is the reel flow, unchanged', () => {
    expect(destinationRules('feed')).toEqual({
      photoOnly: false,
      microphone: 'with-lens',
      photoHandsBack: false,
      videoHandsBack: false,
      fromComposer: false,
      gallery: true,
      soundRemoval: true,
    });
  });

  it('handsBackTake reads the media: a photo and a video of the same destination may part ways', () => {
    const photo = new Blob(['p'], { type: 'image/webp' });
    const video = new Blob(['v'], { type: 'video/mp4' });
    expect(handsBackTake(destinationRules('post'), photo)).toBe(true);
    expect(handsBackTake(destinationRules('post'), video)).toBe(false);
    expect(handsBackTake(destinationRules('post-edit'), video)).toBe(true);
    expect(handsBackTake(destinationRules('feed'), video)).toBe(false);
  });
});

describe('captureFileFrom', () => {
  it('names a photo and a video by their own type, codecs ignored', () => {
    expect(captureFileFrom(new Blob(['x'], { type: 'image/jpeg' }), 7).name).toBe(
      'canari-photo-7.jpg'
    );
    const webm = captureFileFrom(new Blob(['x'], { type: 'video/webm;codecs=vp9,opus' }), 7);
    expect(webm.name).toBe('canari-video-7.webm');
    expect(webm.type).toBe('video/webm;codecs=vp9,opus');
    expect(captureFileFrom(new Blob(['x'], { type: 'video/mp4' }), 7).name).toBe(
      'canari-video-7.mp4'
    );
  });

  it('names the Android WebView take by the container it reports, never .bin (Mi 9T, v1.2.9-alpha.1)', () => {
    const mkv = captureFileFrom(new Blob(['x'], { type: 'video/x-matroska;codecs=avc1,opus' }), 7);
    expect(mkv.name).toBe('canari-video-7.mkv');
    expect(mkv.type).toBe('video/x-matroska;codecs=avc1,opus');
  });

  it('names the editor photo (WebP) and its PNG stand-in by their type, never .bin (Mi 9T, v1.2.9-alpha.3)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(captureFileFrom(new Blob(['x'], { type: 'image/webp' }), 7).name).toBe(
      'canari-photo-7.webp'
    );
    expect(captureFileFrom(new Blob(['x'], { type: 'image/png' }), 7).name).toBe(
      'canari-photo-7.png'
    );
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('accuses a truly unknown type and names it .bin', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(captureFileFrom(new Blob(['x'], { type: 'image/heic' }), 7).name).toBe(
      'canari-photo-7.bin'
    );
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
