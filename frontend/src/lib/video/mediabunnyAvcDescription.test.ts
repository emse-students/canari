/**
 * THE BEHAVIOUR MEDIABUNNY OWES US FOR FIREFOX'S ENCODER (mediabunny issue 559), UNPATCHED SINCE 1.65.0.
 *
 * Firefox's WebCodecs H.264 encoder on Windows (Media Foundation) hands back an
 * AVCDecoderConfigurationRecord whose SPS and PPS each carry their first byte twice, reserved bits
 * zeroed - while every key frame carries the correct parameter sets in-band. Muxed as is, the file
 * plays in Firefox and fails to decode in Chrome, so an Android reader cannot seek it
 * (docs/wiki/frontend/video-preparation.md). Mediabunny 1.65.0 strips the doubled byte itself, but only
 * when `navigator.userAgent` says Firefox, and it caches that answer for the life of the module - so
 * the case imports a fresh copy under the Firefox user agent.
 *
 * No test engine has WebCodecs, so a fake `VideoEncoder` replays the bytes Firefox 158 emitted for
 * a real clip (2026-10-13), and the MP4 mediabunny writes is read back: its `avcC` must be the
 * well-formed record. On 1.63.0 without our former patch this failed on the doubled `67 67`.
 */

/** The SPS and PPS Firefox put in-band, read from its output. */
const SPS = [
  0x67, 0x64, 0x00, 0x1f, 0xac, 0x2c, 0xac, 0x05, 0x00, 0x5b, 0xa1, 0x00, 0x00, 0x03, 0x00, 0x01,
  0x00, 0x00, 0x03, 0x00, 0x3c, 0x0d, 0xa0, 0x88, 0x45, 0x38,
];
const PPS = [0x68, 0xce, 0x3c, 0x30];

/** The record Firefox's encoder emitted for them: lengths 27/5, each first byte doubled. */
const FIREFOX_AVCC = new Uint8Array([
  0x01,
  0x64,
  0x00,
  0x1f,
  0x03,
  0x01,
  0x00,
  0x1b,
  0x67,
  ...SPS,
  0x01,
  0x00,
  0x05,
  0x68,
  ...PPS,
]);

/** The record those parameter sets make, as ISO 14496-15 writes it. */
const WELL_FORMED_AVCC = [
  0x01,
  0x64,
  0x00,
  0x1f,
  0xff,
  0xe1,
  0x00,
  SPS.length,
  ...SPS,
  0x01,
  0x00,
  PPS.length,
  ...PPS,
];

function lengthPrefixed(...units: number[][]): Uint8Array {
  const out: number[] = [];
  for (const u of units) out.push(0, 0, 0, u.length, ...u);
  return new Uint8Array(out);
}

/** A key frame as Firefox writes it: access unit delimiter, SPS, PPS, then an IDR slice. */
const KEY_FRAME = lengthPrefixed([0x09, 0x10], SPS, PPS, [0x65, 0x88, 0x84, 0x00, 0x33, 0xff]);

const FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0";

/** What the fake encoder hands back for every frame; each test sets it. */
let emitted: { data: Uint8Array; description: Uint8Array } = {
  data: KEY_FRAME,
  description: FIREFOX_AVCC,
};

class FakeEncodedVideoChunk {
  readonly type: "key" | "delta";
  readonly timestamp: number;
  readonly duration: number;
  readonly byteLength: number;
  private readonly data: Uint8Array;
  constructor(init: {
    type: "key" | "delta";
    timestamp: number;
    duration: number;
    data: Uint8Array;
  }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration;
    this.data = init.data;
    this.byteLength = init.data.byteLength;
  }
  copyTo(dest: Uint8Array) {
    dest.set(this.data);
  }
}

class FakeVideoFrame {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly format = "RGBX";
  readonly colorSpace = {};
  constructor(
    _data: unknown,
    init: { timestamp: number; duration?: number; codedWidth: number; codedHeight: number },
  ) {
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.codedWidth = this.displayWidth = init.codedWidth;
    this.codedHeight = this.displayHeight = init.codedHeight;
  }
  clone() {
    return this;
  }
  close() {}
}

class FakeVideoEncoder {
  static async isConfigSupported(config: unknown) {
    return { supported: true, config };
  }
  state = "unconfigured";
  encodeQueueSize = 0;
  private config: { codec: string; width: number; height: number } | null = null;
  constructor(private readonly init: { output: (chunk: unknown, meta?: unknown) => void }) {}
  addEventListener() {}
  removeEventListener() {}
  configure(config: { codec: string; width: number; height: number }) {
    this.config = config;
    this.state = "configured";
  }
  encode(frame: FakeVideoFrame) {
    const chunk = new FakeEncodedVideoChunk({
      type: "key",
      timestamp: frame.timestamp,
      duration: frame.duration ?? 33_333,
      data: emitted.data,
    });
    this.init.output(chunk, {
      decoderConfig: {
        codec: this.config!.codec,
        codedWidth: this.config!.width,
        codedHeight: this.config!.height,
        description: emitted.description,
      },
    });
  }
  async flush() {}
  close() {
    this.state = "closed";
  }
}

function indexOf(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  vi.stubGlobal("EncodedVideoChunk", FakeEncodedVideoChunk);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Encodes two frames through the fake encoder and returns the `avcC` record the MP4 carries. */
async function writtenAvcRecord(userAgent: string): Promise<number[]> {
  vi.stubGlobal("navigator", { userAgent });
  const { BufferTarget, Mp4OutputFormat, Output, VideoSample, VideoSampleSource } =
    await import("mediabunny");
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "fragmented" }),
    target: new BufferTarget(),
  });
  const source = new VideoSampleSource({ codec: "avc", bitrate: 1_000_000 });
  output.addVideoTrack(source);
  await output.start();
  for (let i = 0; i < 2; i++) {
    await source.add(
      new VideoSample(new Uint8Array(16 * 16 * 4), {
        format: "RGBX",
        codedWidth: 16,
        codedHeight: 16,
        timestamp: i / 30,
        duration: 1 / 30,
      }),
    );
  }
  await output.finalize();

  const bytes = new Uint8Array(output.target.buffer!);
  const avcC = indexOf(bytes, [0x61, 0x76, 0x63, 0x43]); // 'avcC'
  expect(avcC).toBeGreaterThan(0);
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(avcC - 4);
  return Array.from(bytes.subarray(avcC + 4, avcC - 4 + boxSize));
}

describe("mediabunny AVC description (issue 559)", () => {
  it("writes a well-formed record when Firefox's encoder hands back a malformed one", async () => {
    emitted = { data: KEY_FRAME, description: FIREFOX_AVCC };
    // Mediabunny strips the doubled bytes and re-serialises the record it parsed, which had no
    // High-profile extension (the former patch rebuilt one: `fd f8 f8 00`). Chrome reading it is a
    // reading owed on the Windows desktop (docs/wiki/frontend/video-preparation.md).
    expect(await writtenAvcRecord(FIREFOX_UA)).toEqual(WELL_FORMED_AVCC);
  });
});
