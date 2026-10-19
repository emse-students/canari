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
  initSegmentEnd,
  rebaseFragment,
} from './fmp4Segments';
import { SYNC, box, fragment, initSegment, join, readTimes } from './fmp4.test-helper';

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
