/**
 * A fragmented MP4 written by the SAME muxer and options `prepareVideoForUpload` uses (mediabunny,
 * `fastStart: 'fragmented'`), so the duration tests read the bytes the app ships: `mvhd` duration 0,
 * no `mehd`, one `moof` a second, an `mfra` at the end.
 */
import * as mb from 'mediabunny';

/** The avcC of a 320x240 baseline stream - enough for the muxer; no frame is decoded here. */
const AVCC = new Uint8Array([
  1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xc0, 0x1e, 1, 0, 4, 0x68, 0xce, 0x3c, 0x80,
]);

/** `frames` frames at 30 fps, muxed as the app muxes an upload. */
export async function fragmentedMp4(frames: number): Promise<Uint8Array<ArrayBuffer>> {
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
