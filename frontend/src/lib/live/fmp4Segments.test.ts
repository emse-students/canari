/**
 * THE CHUNK -> SEGMENT READER against the shapes WP-L1 measured: Android's init-alone first chunk,
 * iOS's init + media first chunk, the 14 % of Android chunks holding two fragments, and a box cut
 * across two chunks (never measured, never assumed away). Plus the keyframe read on its three
 * paths, the time shift a re-acquired camera's fragments get, and the viewer's read of where a
 * segment's init ends.
 */
import { describe, expect, it } from 'vitest';
import {
  Fmp4ParseError,
  Fmp4Splitter,
  composeSegment,
  holdLastFrameInterval,
  initSegmentEnd,
  rebaseFragment,
} from './fmp4Segments';
import {
  SYNC,
  box,
  fragment,
  initSegment,
  join,
  readTimes,
  readVideoDurations,
} from './fmp4.test-helper';

describe('Fmp4Splitter', () => {
  it('Android: the first chunk is the init alone, then one fragment per chunk', () => {
    const s = new Fmp4Splitter();
    const first = s.push(initSegment());
    expect(first.init).not.toBeNull();
    expect(first.init!.videoTrackId).toBe(1);
    expect(first.init!.timescales.get(1)).toBe(90_000);
    expect(first.init!.timescales.get(2)).toBe(48_000);
    expect(first.fragments).toEqual([]);
    const second = s.push(fragment());
    expect(second.init).toBeNull();
    expect(second.fragments).toHaveLength(1);
    expect(second.fragments[0].bytes).toEqual(fragment());
  });

  it('iOS: the first chunk is the init AND the first fragment, read the same way', () => {
    const s = new Fmp4Splitter();
    const first = s.push(join(initSegment(), fragment()));
    expect(first.init!.bytes).toEqual(initSegment());
    expect(first.fragments).toHaveLength(1);
  });

  it('a chunk carrying TWO fragments yields two, in order', () => {
    const s = new Fmp4Splitter();
    s.push(initSegment());
    const a = fragment({ videoTime: 0n, mediaBytes: 10 });
    const b = fragment({ videoTime: 180_000n, mediaBytes: 20 });
    const out = s.push(join(a, b));
    expect(out.fragments.map((f) => f.bytes)).toEqual([a, b]);
  });

  it('a box cut across chunks is carried, and completed by the next push', () => {
    const s = new Fmp4Splitter();
    const whole = join(initSegment(), fragment());
    const cut = initSegment().length + 13; // inside the moof's header and body
    const first = s.push(whole.slice(0, cut));
    expect(first.init).not.toBeNull();
    expect(first.fragments).toEqual([]);
    const second = s.push(whole.slice(cut, whole.length - 5)); // the mdat still short
    expect(second.fragments).toEqual([]);
    const third = s.push(whole.slice(whole.length - 5));
    expect(third.fragments).toHaveLength(1);
    expect(third.fragments[0].bytes).toEqual(fragment());
  });

  it('reads whether the video starts on a keyframe, on all three paths the flags may take', () => {
    const s = new Fmp4Splitter();
    s.push(initSegment());
    const read = (spec: Parameters<typeof fragment>[0]) =>
      s.push(fragment(spec)).fragments[0].startsOnKeyframe;
    expect(read({ flagsIn: 'first', keyframe: true })).toBe(true);
    expect(read({ flagsIn: 'first', keyframe: false })).toBe(false);
    expect(read({ flagsIn: 'per-sample', keyframe: true })).toBe(true);
    expect(read({ flagsIn: 'per-sample', keyframe: false })).toBe(false);
    // No flags in the fragment: the init's trex default (non-sync, as Chromium writes it).
    expect(read({ flagsIn: 'default' })).toBe(false);
    const sync = new Fmp4Splitter();
    sync.push(initSegment(SYNC));
    expect(sync.push(fragment({ flagsIn: 'default' })).fragments[0].startsOnKeyframe).toBe(true);
  });

  it('keeps a box between fragments (styp, free) with the fragment it leads', () => {
    const s = new Fmp4Splitter();
    s.push(initSegment());
    const free = box('free', [1, 2, 3]);
    const out = s.push(join(free, fragment()));
    expect(out.fragments[0].bytes).toEqual(join(free, fragment()));
  });

  it('refuses what it cannot frame: media before an init, a size-0 box, a size under the header', () => {
    expect(() => new Fmp4Splitter().push(fragment())).toThrow(Fmp4ParseError);
    const s = new Fmp4Splitter();
    s.push(initSegment());
    expect(() => s.push(new Uint8Array([0, 0, 0, 0, 0x6d, 0x64, 0x61, 0x74]))).toThrow(
      Fmp4ParseError
    );
    expect(() =>
      new Fmp4Splitter().push(new Uint8Array([0, 0, 0, 4, 0x66, 0x74, 0x79, 0x70]))
    ).toThrow(Fmp4ParseError);
  });
});

describe('composeSegment', () => {
  it('is the init followed by the fragment: every segment decodes on its own', () => {
    const s = new Fmp4Splitter();
    const { init } = s.push(initSegment());
    const f = s.push(fragment()).fragments[0];
    expect(composeSegment(init!, f)).toEqual(join(initSegment(), fragment()));
  });
});

describe('rebaseFragment', () => {
  const s = new Fmp4Splitter();
  const init = s.push(initSegment()).init!;

  it('shifts each track by the offset in its own timescale, in a copy', () => {
    const original = fragment({ videoTime: 90_000n, audioTime: 48_000 });
    const f = { bytes: original, startsOnKeyframe: true };
    const shifted = rebaseFragment(f, init, 2_500);
    expect(readTimes(shifted.bytes)).toEqual({
      video: 90_000n + 225_000n,
      audio: 48_000 + 120_000,
    });
    expect(readTimes(original)).toEqual({ video: 90_000n, audio: 48_000 });
    expect(shifted.startsOnKeyframe).toBe(true);
  });

  it('an offset of zero (the first recorder) returns the fragment untouched', () => {
    const f = { bytes: fragment(), startsOnKeyframe: true };
    expect(rebaseFragment(f, init, 0)).toBe(f);
  });

  it('refuses to overflow a 32-bit tfdt rather than wrap it', () => {
    const f = { bytes: fragment({ audioTime: 0xffff0000 }), startsOnKeyframe: true };
    expect(() => rebaseFragment(f, init, 60_000)).toThrow(Fmp4ParseError);
  });
});

describe('initSegmentEnd', () => {
  it('ends after moov for an init alone', () => {
    expect(
      initSegmentEnd(join(box('ftyp', new Uint8Array(12)), box('moov', new Uint8Array(40))))
    ).toBe(20 + 48);
  });

  it('ends after moov when a fragment follows (a self-contained segment)', () => {
    expect(
      initSegmentEnd(
        join(
          box('ftyp', new Uint8Array(12)),
          box('moov', new Uint8Array(40)),
          box('moof', new Uint8Array(8)),
          box('mdat', new Uint8Array(100))
        )
      )
    ).toBe(68);
  });

  it('is 0 for a media-only fragment', () => {
    expect(
      initSegmentEnd(join(box('moof', new Uint8Array(8)), box('mdat', new Uint8Array(100))))
    ).toBe(0);
  });

  it('is 0 for a truncated box or an empty buffer', () => {
    expect(
      initSegmentEnd(
        join(box('ftyp', new Uint8Array(12)), box('moov', new Uint8Array(40))).subarray(0, 30)
      )
    ).toBe(0);
    expect(initSegmentEnd(new Uint8Array(0))).toBe(0);
  });

  it('reads a 64-bit box size', () => {
    const big = new Uint8Array(16 + 4);
    const v = new DataView(big.buffer);
    v.setUint32(0, 1);
    big.set([0x66, 0x72, 0x65, 0x65], 4); // free
    v.setUint32(12, 20);
    expect(initSegmentEnd(join(big, box('moov', new Uint8Array(4))))).toBe(32);
  });
});

describe('initSegmentEnd on a box it cannot frame', () => {
  it('throws the typed error for a size-0 box and for a size under its own header', () => {
    expect(() => initSegmentEnd(join(box('ftyp', new Uint8Array(12)), new Uint8Array(8)))).toThrow(
      Fmp4ParseError
    );
    const tiny = box('free');
    new DataView(tiny.buffer).setUint32(0, 4);
    expect(() => initSegmentEnd(tiny)).toThrow(Fmp4ParseError);
  });
});

describe('the two halves agree', () => {
  it("the viewer finds the init exactly where the broadcaster's composeSegment put it", () => {
    const s = new Fmp4Splitter();
    const { init, fragments } = s.push(join(initSegment(), fragment()));
    const segment = composeSegment(init!, fragments[0]);
    expect(initSegmentEnd(segment)).toBe(initSegment().byteLength);
    expect(segment.subarray(initSegment().byteLength)).toEqual(fragment());
  });
});

describe('holdLastFrameInterval', () => {
  // 12.5 fps at 90 kHz: 7200 ticks a frame; Chromium writes the last one as 1/30 s (3000).
  const FRAME = 7200;
  const GUESS = 3000;
  const run = (n: number, last: number) => [...Array<number>(n - 1).fill(FRAME), last];

  it('a last frame written SHORTER than the one before it takes that interval', () => {
    const f = fragment({ videoDurations: run(25, GUESS) });
    const out = holdLastFrameInterval(initSegment(), f);
    expect(out.held).toEqual({ from: GUESS, to: FRAME, timescale: 90_000 });
    expect(readVideoDurations(out.bytes)).toEqual(run(25, FRAME));
    // A copy: the input is untouched, and only the one duration differs.
    expect(readVideoDurations(f)).toEqual(run(25, GUESS));
    expect(out.bytes.byteLength).toBe(f.byteLength);
  });

  it('the track times are left alone: the fragment lands where it was written', () => {
    const f = fragment({
      videoTime: 1_800_000n,
      audioTime: 960_000,
      videoDurations: run(25, GUESS),
    });
    expect(readTimes(holdLastFrameInterval(initSegment(), f).bytes)).toEqual(readTimes(f));
  });

  it('a last frame as long as, or LONGER than, the one before is a frame really held: unchanged', () => {
    for (const last of [FRAME, FRAME * 3]) {
      const f = fragment({ videoDurations: run(25, last) });
      const out = holdLastFrameInterval(initSegment(), f);
      expect(out.held).toBeNull();
      expect(out.bytes).toBe(f);
    }
  });

  it('ONE video sample has no interval of its own, and none is borrowed: unchanged', () => {
    const f = fragment({ videoDurations: [GUESS] });
    const out = holdLastFrameInterval(initSegment(), f);
    expect(out.held).toBeNull();
    expect(out.bytes).toBe(f);
  });

  it('an audio-only fragment, or durations stated only by default, are unchanged', () => {
    for (const f of [fragment({ tracks: 'audio' }), fragment({ flagsIn: 'first' })]) {
      const out = holdLastFrameInterval(initSegment(), f);
      expect(out.held).toBeNull();
      expect(out.bytes).toBe(f);
    }
  });

  it('a video-only fragment is corrected the same way', () => {
    const out = holdLastFrameInterval(
      initSegment(),
      fragment({ tracks: 'video', videoDurations: run(10, GUESS) })
    );
    expect(readVideoDurations(out.bytes)).toEqual(run(10, FRAME));
  });

  it('an init with no moov cannot be read against', () => {
    expect(() => holdLastFrameInterval(box('ftyp', [0, 0, 0, 0]), fragment())).toThrow(
      Fmp4ParseError
    );
  });

  it('across a GENERATION boundary nothing is carried: each fragment is read on its own intervals', () => {
    // The last fragment of a 12.5 fps recorder, then the first of a re-acquired one at 30 fps
    // (a camera flip), rebased 0.8 s after it as the broadcaster ships them: each fragment gets
    // ITS OWN previous interval.
    const init = initSegment();
    const parsed = new Fmp4Splitter().push(init).init!;
    const shipped = (durations: number[], offsetMs: number) =>
      rebaseFragment(
        { bytes: fragment({ videoDurations: durations }), startsOnKeyframe: true },
        parsed,
        offsetMs
      ).bytes as Uint8Array<ArrayBuffer>;
    const before = holdLastFrameInterval(init, shipped(run(25, GUESS), 10_000));
    const after = holdLastFrameInterval(init, shipped(Array<number>(60).fill(3000), 12_800));
    expect(readVideoDurations(before.bytes).at(-1)).toBe(FRAME);
    expect(after.held).toBeNull();
    expect(readVideoDurations(after.bytes)).toEqual(Array<number>(60).fill(3000));
    // The order of the calls changes nothing: the function holds no state between fragments.
    const again = holdLastFrameInterval(init, fragment({ videoDurations: run(25, GUESS) }));
    expect(again.held).toEqual(before.held);
  });

  it('closes the gap MSE reads as a discontinuity: the next fragment starts within 2 frames', () => {
    // 25 frames at 12.5 fps span 2 s; the next fragment starts at 180_000 ticks.
    const f = fragment({ videoTime: 0n, videoDurations: run(25, GUESS) });
    const nextStart = 180_000;
    const lastStart = 24 * FRAME;
    const gap = (durations: number[]) => nextStart - lastStart - durations.at(-1)!;
    // As written: the next frame comes 7200 ticks after the last one starts, over twice its
    // stated 3000 - a discontinuity.
    expect(nextStart - lastStart).toBeGreaterThan(2 * GUESS);
    const held = readVideoDurations(holdLastFrameInterval(initSegment(), f).bytes);
    expect(gap(held)).toBe(0);
    expect(nextStart - lastStart).toBeLessThanOrEqual(2 * held.at(-1)!);
  });
});
