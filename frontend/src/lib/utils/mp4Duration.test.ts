import { describe, expect, it, vi } from 'vitest';
import * as mb from 'mediabunny';
import { declareMp4Duration, isMp4Type, readMp4Duration } from './mp4Duration';

/** The avcC of a 320x240 baseline stream - enough for the muxer; no frame is decoded here. */
const AVCC = new Uint8Array([
  1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xc0, 0x1e, 1, 0, 4, 0x68, 0xce, 0x3c, 0x80,
]);

/**
 * A fragmented MP4 written by the SAME muxer and options `prepareVideoForUpload` uses
 * (`fastStart: 'fragmented'`), `frames` frames at 30 fps - so the test reads the bytes the app ships.
 */
async function fragmentedMp4(frames: number): Promise<Uint8Array> {
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: new mb.BufferTarget(),
  });
  const source = new mb.EncodedVideoPacketSource('avc');
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (let i = 0; i < frames; i++) {
    await source.add(
      new mb.EncodedPacket(
        new Uint8Array([0, 0, 0, 1, 0x65]),
        i % 30 === 0 ? 'key' : 'delta',
        i / 30,
        1 / 30
      ),
      i === 0
        ? {
            decoderConfig: {
              codec: 'avc1.42c01e',
              codedWidth: 320,
              codedHeight: 240,
              description: AVCC,
            },
          }
        : undefined
    );
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer!);
}

describe('mp4Duration', () => {
  it('reads the muxer output as UNDECLARED (mvhd 0) yet 10 s long from its fragments - the defect', async () => {
    const bytes = await fragmentedMp4(300);
    const reading = readMp4Duration(bytes);
    expect(reading.declaredSeconds).toBe(0);
    expect(reading.samplesSeconds).toBeCloseTo(10, 3);
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

  it('leaves bytes that are not an MP4 alone', () => {
    const junk = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65, 1, 2, 3]);
    expect(declareMp4Duration(junk)).toEqual({ kind: 'not-fragmented' });
    expect(readMp4Duration(new Uint8Array(3))).toEqual({
      samplesSeconds: null,
      declaredSeconds: null,
    });
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
