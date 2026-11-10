import { describe, expect, it, vi } from 'vitest';
import * as mb from 'mediabunny';
import { declareMp4Duration, isMp4Type, readMp4Duration, writeMvhdDuration } from './mp4Duration';
import { fragmentedMp4 } from './mp4Fixture.test-helper';
import { fragment, initSegment, join } from '$lib/live/fmp4.test-helper';

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
});
