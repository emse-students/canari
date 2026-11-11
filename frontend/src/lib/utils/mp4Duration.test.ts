import { describe, expect, it, vi } from 'vitest';
import * as mb from 'mediabunny';
import {
  declareMp4Duration,
  isMp4Type,
  readMp4Duration,
  MIN_VIDEO_BYTES_PER_SECOND,
  readMp4TailDuration,
  writeMvhdDuration,
} from './mp4Duration';
import { fragmentedMp4 } from './mp4Fixture.test-helper';
import { box, fragment, initSegment, join } from '$lib/live/fmp4.test-helper';

/** Offset of the first box of `type` (its size field), or -1. */
function boxAt(bytes: Uint8Array, type: string): number {
  const code = Array.from(type, (c) => c.charCodeAt(0));
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (code.every((c, k) => bytes[i + k] === c)) return i - 4;
  }
  return -1;
}

/** Offset of a full box's timescale field (`mvhd`, `mdhd`): after version/flags and two times. */
function timescaleAt(bytes: Uint8Array, start: number): number {
  return start + 8 + 4 + (bytes[start + 8] === 1 ? 16 : 8);
}

/** The offsets at which `after` differs from `before` (same length). */
function changedOffsets(before: Uint8Array, after: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) out.push(i);
  return out;
}

/** A seeded generator, so a failing flip is the same flip on every run. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('mp4Duration', () => {
  it('reads the muxer output as UNDECLARED (mvhd 0) yet 10 s long from its fragments - the defect', async () => {
    const bytes = await fragmentedMp4(300);
    const reading = readMp4Duration(bytes);
    expect(reading.declaredSeconds).toBe(0);
    expect(reading.samplesSeconds).toBeCloseTo(10, 3);
    expect(reading.complete).toBe(true);
  });

  it('writes the samples length into mvhd in place, and a second pass writes nothing', async () => {
    const bytes = await fragmentedMp4(300);
    const size = bytes.byteLength;
    const first = declareMp4Duration(bytes);
    expect(first.kind).toBe('written');
    expect(bytes.byteLength).toBe(size);
    expect(readMp4Duration(bytes).declaredSeconds).toBeCloseTo(10, 3);
    expect(declareMp4Duration(bytes).kind).toBe('declared');
  });

  it('the patched file still demuxes to the same packets (nothing moved)', async () => {
    const bytes = await fragmentedMp4(90);
    declareMp4Duration(bytes);
    const input = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    expect(track).not.toBeNull();
    expect(await input.computeDuration()).toBeCloseTo(3, 2);
    const sink = new mb.EncodedPacketSink(track!);
    let count = 0;
    for await (const _packet of sink.packets()) count++;
    expect(count).toBe(90);
  });

  it('a track that does not start at 0 lasts from its FIRST decode time, not from 0', () => {
    // Two one-sample video fragments of 3000 ticks at 90 kHz, starting 10 s into the timeline.
    const bytes = join(
      initSegment(),
      fragment({ videoTime: 900_000n, flagsIn: 'per-sample' }),
      fragment({ videoTime: 903_000n, flagsIn: 'per-sample' })
    );
    expect(readMp4Duration(bytes).samplesSeconds).toBeCloseTo(6000 / 90_000, 6);
  });

  it('leaves bytes that are not an MP4 alone', () => {
    const junk = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65, 1, 2, 3]);
    expect(declareMp4Duration(junk)).toEqual({ kind: 'not-fragmented' });
    expect(readMp4Duration(new Uint8Array(3))).toEqual({
      samplesSeconds: null,
      declaredSeconds: null,
      complete: false,
    });
  });

  /**
   * NOTHING THE READER IS HANDED CAN MAKE IT THROW, OR WRITE OUTSIDE THE ONE FIELD (review of
   * #3311). Every prefix of a real upload: a cut inside a box is never written; a cut exactly on a
   * box boundary is a well-formed shorter movie, and if written, says that movie's own length.
   */
  it('every prefix: no throw, no write when cut inside a box', async () => {
    const full = await fragmentedMp4(30);
    const mvhd = boxAt(full, 'mvhd');
    for (let length = 0; length < full.byteLength; length++) {
      const prefix = full.slice(0, length);
      const before = prefix.slice();
      const reading = readMp4Duration(prefix);
      const outcome = declareMp4Duration(prefix);
      if (!reading.complete) {
        expect(outcome.kind, `prefix ${length}`).toBe('not-fragmented');
        expect(changedOffsets(before, prefix), `prefix ${length}`).toEqual([]);
      } else if (outcome.kind === 'written') {
        expect(outcome.seconds).toBeLessThanOrEqual(1 + 1e-6);
        for (const at of changedOffsets(before, prefix)) {
          expect(at).toBeGreaterThanOrEqual(mvhd);
          expect(at).toBeLessThan(mvhd + 120);
        }
      }
    }
  });

  it('random byte flips: no throw, and nothing written outside the movie header', async () => {
    const original = await fragmentedMp4(30);
    const mvhd = boxAt(original, 'mvhd');
    const mvhdEnd = mvhd + new DataView(original.buffer).getUint32(mvhd);
    const random = seeded(3311);
    for (let round = 0; round < 400; round++) {
      const bytes = original.slice();
      const flips = 1 + Math.floor(random() * 3);
      for (let f = 0; f < flips; f++) {
        bytes[Math.floor(random() * bytes.length)] ^= 1 + Math.floor(random() * 255);
      }
      const before = bytes.slice();
      expect(() => declareMp4Duration(bytes), `round ${round}`).not.toThrow();
      for (const at of changedOffsets(before, bytes)) {
        expect(at, `round ${round}`).toBeGreaterThanOrEqual(mvhd);
        expect(at, `round ${round}`).toBeLessThan(mvhdEnd);
      }
    }
  });

  it('a last box of size 0 (to the end) and a 64-bit size are walked like any other', async () => {
    const full = await fragmentedMp4(30);
    const mfra = boxAt(full, 'mfra');
    expect(mfra).toBeGreaterThan(0);

    const toEnd = full.slice();
    new DataView(toEnd.buffer).setUint32(mfra, 0);
    expect(declareMp4Duration(toEnd)).toMatchObject({ kind: 'written' });

    // The same `mfra` with size 1 and a 64-bit largesize (8 bytes longer).
    const tail = full.slice(mfra);
    const wide = new Uint8Array(full.byteLength + 8);
    wide.set(full.subarray(0, mfra));
    const view = new DataView(wide.buffer);
    view.setUint32(mfra, 1);
    wide.set(tail.subarray(4, 8), mfra + 4);
    view.setBigUint64(mfra + 8, BigInt(tail.byteLength + 8));
    wide.set(tail.subarray(8), mfra + 16);
    expect(declareMp4Duration(wide)).toMatchObject({ kind: 'written' });

    // A largesize past the end, and a size-1 box with no room for its largesize: incomplete.
    const past = wide.slice();
    new DataView(past.buffer).setBigUint64(mfra + 8, 2n ** 60n);
    const pastBefore = past.slice();
    expect(declareMp4Duration(past)).toEqual({ kind: 'not-fragmented' });
    expect(changedOffsets(pastBefore, past)).toEqual([]);
    const stub = join(full, new Uint8Array([0, 0, 0, 1, 0x66, 0x72, 0x65, 0x65]));
    const stubBefore = stub.slice();
    expect(declareMp4Duration(stub)).toEqual({ kind: 'not-fragmented' });
    expect(changedOffsets(stubBefore, stub)).toEqual([]);
  });

  it("a timescale of 0 - the movie's or the track's - writes nothing", async () => {
    const movieZero = await fragmentedMp4(30);
    new DataView(movieZero.buffer).setUint32(timescaleAt(movieZero, boxAt(movieZero, 'mvhd')), 0);
    const movieBefore = movieZero.slice();
    expect(declareMp4Duration(movieZero)).toEqual({ kind: 'not-fragmented' });
    expect(changedOffsets(movieBefore, movieZero)).toEqual([]);

    const trackZero = await fragmentedMp4(30);
    new DataView(trackZero.buffer).setUint32(timescaleAt(trackZero, boxAt(trackZero, 'mdhd')), 0);
    const trackBefore = trackZero.slice();
    expect(readMp4Duration(trackZero).samplesSeconds).toBeNull();
    expect(declareMp4Duration(trackZero)).toEqual({ kind: 'not-fragmented' });
    expect(changedOffsets(trackBefore, trackZero)).toEqual([]);
  });

  /**
   * THE STREAM PATCHES ONLY THE HEAD (review of #3311): its first segment holds the `moov`, the rest
   * stays the engine's blobs. The head is cut mid-fragment, so the length comes from the caller.
   */
  it('writeMvhdDuration patches a COPY of a head cut mid-fragment, and only when it says less', async () => {
    const full = await fragmentedMp4(90);
    const head = full.slice(0, boxAt(full, 'moof') + 20);
    const untouched = head.slice();
    const patched = writeMvhdDuration(head, 3);
    expect(patched).not.toBeNull();
    expect(changedOffsets(untouched, head), 'the head itself is not written').toEqual([]);
    const whole = join(patched!, full.subarray(head.byteLength));
    expect(readMp4Duration(whole).declaredSeconds).toBeCloseTo(3, 3);
    expect(writeMvhdDuration(whole, 3), 'already declared').toBeNull();
    expect(writeMvhdDuration(head, Number.NaN)).toBeNull();
    expect(writeMvhdDuration(head, 0)).toBeNull();
    expect(writeMvhdDuration(full.slice(0, 20), 3), 'no moov in it').toBeNull();
  });

  it('a reader gives an already-uploaded video its length before the engine sees it, and only a video', async () => {
    const { declareVideoDuration } = await import('./mediaBlobCache');
    const bytes = await fragmentedMp4(60);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    declareVideoDuration({ mediaId: 'm', mimeType: 'video/mp4', type: 'image' }, bytes.buffer);
    expect(readMp4Duration(bytes).declaredSeconds, 'not a video: untouched').toBe(0);
    declareVideoDuration(
      { mediaId: 'm', mimeType: 'video/mp4; codecs="avc1"', type: 'video' },
      bytes.buffer
    );
    expect(readMp4Duration(bytes).declaredSeconds).toBeCloseTo(2, 3);
    expect(String(info.mock.calls[0][0])).toContain('undeclared movie duration');
    info.mockRestore();
  });

  it('names the MP4 types only', () => {
    expect(isMp4Type('video/mp4; codecs="avc1.42c01e"')).toBe(true);
    expect(isMp4Type('video/webm')).toBe(false);
  });

  describe('readMp4TailDuration - a stream learns its length from its head and its tail', () => {
    /**
     * The size the reader is told the file has. The fixture's frames are synthetic (3.5 kB for 10 s,
     * far below any real encode); a real 10 s clip is megabytes, which is what the plausibility
     * bound (`MIN_VIDEO_BYTES_PER_SECOND`) is measured against.
     */
    const CLIP_BYTES = 10 * 1024 * 1024;

    /** The head a stream holds: cut inside the first fragment, as its first segment is. */
    const headOf = (bytes: Uint8Array) => bytes.subarray(0, boxAt(bytes, 'moof') + 20);

    /** Where the `tfra`'s entries are, and how wide each field is. */
    function tfraLayout(bytes: Uint8Array) {
      const at = boxAt(bytes, 'tfra');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const wide = bytes[at + 8] === 1;
      const sizes = view.getUint32(at + 16);
      const stride =
        (wide ? 16 : 8) + ((sizes >> 4) & 3) + 1 + (((sizes >> 2) & 3) + 1) + ((sizes & 3) + 1);
      return { at, view, wide, count: view.getUint32(at + 20), entries: at + 24, stride };
    }

    /** Every answer the reader gives is either a refusal or a believable length for these bytes. */
    function plausible(reading: ReturnType<typeof readMp4TailDuration>, fileBytes: number) {
      if (reading.kind !== 'seconds') return;
      expect(Number.isFinite(reading.seconds)).toBe(true);
      expect(reading.seconds).toBeGreaterThan(0);
      expect(fileBytes / reading.seconds).toBeGreaterThanOrEqual(MIN_VIDEO_BYTES_PER_SECOND);
    }

    it("reads the muxer output's length from the moov and the file's last bytes only", async () => {
      const bytes = await fragmentedMp4(300);
      for (const tailBytes of [bytes.byteLength, 1000]) {
        const start = bytes.byteLength - tailBytes;
        const reading = readMp4TailDuration(
          headOf(bytes),
          bytes.subarray(start),
          start,
          CLIP_BYTES
        );
        expect(reading.kind).toBe('seconds');
        if (reading.kind === 'seconds') expect(reading.seconds).toBeCloseTo(10, 3);
      }
    });

    it('a tail that starts after the last fragment asks for the bytes from where it starts', async () => {
      const bytes = await fragmentedMp4(300);
      const start = boxAt(bytes, 'mfra') - 8;
      const n = CLIP_BYTES;
      const reading = readMp4TailDuration(headOf(bytes), bytes.subarray(start), start, n);
      expect(reading.kind).toBe('earlier');
      if (reading.kind !== 'earlier') return;
      expect(reading.from).toBeLessThan(start);
      const wider = readMp4TailDuration(
        headOf(bytes),
        bytes.subarray(reading.from),
        reading.from,
        n
      );
      expect(wider.kind).toBe('seconds');
    });

    it('answers the ABSOLUTE end - what an MSE duration is - for a track that does not start at 0', () => {
      // Two 3000-tick video fragments at 90 kHz, from 10 s; their mfra lists both.
      const init = initSegment();
      const a = fragment({ videoTime: 900_000n, flagsIn: 'per-sample' });
      const b = fragment({ videoTime: 903_000n, flagsIn: 'per-sample' });
      const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
      const u64 = (n: number) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
      const entry = (time: number, offset: number) => [...u64(time), ...u64(offset), 1, 1, 1];
      const tfra = box(
        'tfra',
        [1, 0, 0, 0],
        u32(1),
        u32(0),
        u32(2),
        entry(900_000, init.length),
        entry(903_000, init.length + a.length)
      );
      const mfraSize = 8 + tfra.length + 16;
      const file = join(init, a, b, box('mfra', tfra, box('mfro', [0, 0, 0, 0], u32(mfraSize))));
      const reading = readMp4TailDuration(file, file, 0, 10_000_000);
      expect(reading).toEqual({ kind: 'seconds', seconds: 906_000 / 90_000 });
    });

    it('a corrupt tfra time over intact fragments changes nothing: the tfdt and trun are the answer', async () => {
      const bytes = await fragmentedMp4(300);
      const { view, wide, count, entries, stride } = tfraLayout(bytes);
      for (let k = 0; k < count; k++) {
        const time = entries + k * stride;
        if (wide) view.setBigUint64(time, 0xffff_ffff_ffff_f000n);
        else view.setUint32(time, 0xffff_ff00);
      }
      const reading = readMp4TailDuration(headOf(bytes), bytes, 0, CLIP_BYTES);
      expect(reading.kind).toBe('seconds');
      if (reading.kind === 'seconds') expect(reading.seconds).toBeCloseTo(10, 3);
    });

    it('refuses a length the file is too small to hold, and names why', async () => {
      const bytes = await fragmentedMp4(300);
      // A 64-bit tfdt near 2^64 on the last fragment: hours of video in 3.5 kB.
      const tfdtAt = (() => {
        for (let i = boxAt(bytes, 'mfra'); i > 4; i--) {
          if (String.fromCharCode(...bytes.subarray(i, i + 4)) === 'tfdt') return i - 4;
        }
        return -1;
      })();
      expect(tfdtAt).toBeGreaterThan(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes[tfdtAt + 8] === 1) view.setBigUint64(tfdtAt + 12, 0xffff_ffff_ffff_0000n);
      else view.setUint32(tfdtAt + 12, 0xffff_0000);
      const reading = readMp4TailDuration(headOf(bytes), bytes, 0, CLIP_BYTES);
      expect(reading.kind).toBe('unreadable');
      if (reading.kind === 'unreadable') expect(reading.why).toContain('implausible');
    });

    it('a timescale of 0 and a tfra count past its box give no length, and say why', async () => {
      const zeroScale = await fragmentedMp4(60);
      for (const at of [boxAt(zeroScale, 'mdhd')]) {
        new DataView(zeroScale.buffer).setUint32(timescaleAt(zeroScale, at), 0);
      }
      expect(readMp4TailDuration(headOf(zeroScale), zeroScale, 0, CLIP_BYTES)).toMatchObject({
        kind: 'unreadable',
      });

      const huge = await fragmentedMp4(60);
      const { view, at } = tfraLayout(huge);
      view.setUint32(at + 20, 0xffff_ffff);
      expect(readMp4TailDuration(headOf(huge), huge, 0, CLIP_BYTES)).toEqual({
        kind: 'unreadable',
        why: 'the mfra lists no fragment',
      });
    });

    it('fuzz: never throws, and every length it gives is finite, positive and plausible', async () => {
      const bytes = await fragmentedMp4(60);
      const head = headOf(bytes);
      expect(
        readMp4TailDuration(head, bytes.subarray(0, bytes.byteLength - 3), 0, CLIP_BYTES)
      ).toMatchObject({ kind: 'unreadable' });
      expect(readMp4TailDuration(new Uint8Array(16), bytes, 0, CLIP_BYTES)).toEqual({
        kind: 'unreadable',
        why: 'no moov in the head',
      });
      const rand = seeded(7);
      for (let k = 0; k < 400; k++) {
        const copy = new Uint8Array(bytes);
        const at = bytes.byteLength - 1 - Math.floor(rand() * 2048);
        copy[at] ^= 1 + Math.floor(rand() * 255);
        let reading: ReturnType<typeof readMp4TailDuration> | undefined;
        expect(() => (reading = readMp4TailDuration(head, copy, 0, CLIP_BYTES))).not.toThrow();
        plausible(reading!, CLIP_BYTES);
      }
    });
  });
});
