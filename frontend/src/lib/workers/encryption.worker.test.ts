// @vitest-environment happy-dom
/**
 * The E2E worker's Opus witness (2026-10-19): a plaintext audio payload that is not an Opus packet
 * is NAMED, with its side, and a receiver payload that decrypts a second time is named as a double
 * encryption. The worker is loaded for real; only the transform streams and the frame class are
 * stand-ins, because no test engine has `RTCRtpScriptTransform`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Metadata = { payloadType?: number; mimeType?: string; rtpTimestamp?: number };
const OPUS_METADATA = (): Metadata => ({ payloadType: 111, mimeType: 'audio/opus' });
/** What every frame's `getMetadata` answers; a test swaps it and `afterEach` restores it. */
let metadata: () => Metadata = OPUS_METADATA;

/** Named like the engine's class; the worker takes the kind from the transform's options instead. */
class RTCEncodedAudioFrame {
  constructor(public data: ArrayBuffer) {}
  getMetadata() {
    return metadata();
  }
}

/** The caller's SEND key (bytes 1..32) and the callee's (33..64): one per direction. */
const CALLER_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const CALLEE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 33);
const posted: Array<Record<string, unknown>> = [];
/** The caller's send key, held by the test: what the worker as CALLEE must open. */
let key: CryptoKey;

type Scope = typeof globalThis & {
  onrtctransform: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent) => Promise<void> | void) | null;
};
const scope = globalThis as Scope;

beforeAll(async () => {
  vi.spyOn(globalThis, 'postMessage').mockImplementation(((msg: Record<string, unknown>) => {
    posted.push(msg);
  }) as typeof globalThis.postMessage);
  await import('./encryption.worker');
  await keyAs('caller');
  expect(posted.some((m) => m.type === 'keyReady')).toBe(true);
  key = await crypto.subtle.importKey('raw', CALLER_KEY, { name: 'AES-GCM' }, false, ['encrypt']);
});

/**
 * Keys the worker as one end of the call (`utils/callKeys.ts`): the caller sends with the caller
 * key and opens with the callee's, the callee the reverse. The SAME worker plays both ends of a
 * round trip by being re-keyed between its sender run and its receiver run.
 */
async function keyAs(role: 'caller' | 'callee') {
  const [send, receive] = role === 'caller' ? [CALLER_KEY, CALLEE_KEY] : [CALLEE_KEY, CALLER_KEY];
  await scope.onmessage!({
    data: { type: 'setKeys', send: send.slice().buffer, receive: receive.slice().buffer },
  } as MessageEvent);
}

afterEach(() => {
  posted.length = 0;
  metadata = OPUS_METADATA;
});

async function encrypt(
  plain: Uint8Array<ArrayBuffer>,
  iv = crypto.getRandomValues(new Uint8Array(12))
): Promise<Uint8Array<ArrayBuffer>> {
  const c = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('canari-call-v2|audio') },
      key,
      plain
    )
  );
  const out = new Uint8Array(12 + c.length);
  out.set(iv);
  out.set(c, 12);
  return out;
}

/** A video frame: the worker reads `video` from this class name, as from the engine's. */
class RTCEncodedVideoFrame extends RTCEncodedAudioFrame {}

/**
 * Runs frames through one transform of the worker and returns what it forwarded. A SENDER runs as
 * the caller and a RECEIVER as the callee (`keyAs`), so what one run sealed the next one opens.
 * The kind is the page's, in the options, as `CallService` passes it: video for a video frame
 * class unless `kind` overrides it (`null` = a transform the page gave no kind).
 */
async function run(
  side: 'sender' | 'receiver',
  payloads: Uint8Array[],
  epoch?: number,
  Frame: typeof RTCEncodedAudioFrame = RTCEncodedAudioFrame,
  kind: string | null = Frame === RTCEncodedVideoFrame ? 'video' : 'audio',
  role: 'caller' | 'callee' = side === 'sender' ? 'caller' : 'callee'
): Promise<Uint8Array[]> {
  await keyAs(role);
  const input = new ReadableStream({
    start(c) {
      for (const p of payloads) c.enqueue(new Frame(p.slice().buffer));
      c.close();
    },
  });
  const out: Uint8Array[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const writable = new WritableStream<RTCEncodedAudioFrame>({
    write(f) {
      out.push(new Uint8Array(f.data));
    },
    close() {
      done();
    },
  });
  scope.onrtctransform!({
    transformer: { readable: input, writable, options: { side, epoch, kind } },
  } as unknown as Event);
  await finished;
  return out;
}

/** A 20 ms CELT-only Opus packet (config 31, code 0) - what an encoder emits. */
const opus = () => Uint8Array.from([31 << 3, ...Array.from({ length: 80 }, () => 7)]);
/** Not Opus by rule R3: code 1 needs an even remainder. */
const notOpus = () => Uint8Array.from([(31 << 3) | 1, 1, 2, 3]);

describe('encryption.worker - the Opus witness', () => {
  it('says nothing about a valid Opus packet, either side', async () => {
    const sent = await run('sender', [opus()]);
    await run('receiver', sent);
    expect(posted.filter((m) => m.type === 'opusInvalid' || m.type === 'doubleEncrypted')).toEqual(
      []
    );
  });

  it('says nothing about an empty DTX frame - the encoder sending nothing is not a bad packet', async () => {
    const sent = await run('sender', [new Uint8Array(0)]);
    await run('receiver', sent);
    expect(posted.filter((m) => m.type === 'opusInvalid')).toEqual([]);
  });

  it('names a non-Opus payload on the SENDER, before encrypting, and still sends it', async () => {
    const sent = await run('sender', [notOpus()]);
    expect(sent).toHaveLength(1);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'opusInvalid', side: 'sender', length: 4, payloadType: 111 })
    );
  });

  it('names a decrypted payload that is not Opus on the RECEIVER', async () => {
    await run('receiver', [await encrypt(notOpus())]);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'opusInvalid', side: 'receiver' })
    );
    expect(posted.some((m) => m.type === 'doubleEncrypted')).toBe(false);
  });

  it('proves a double encryption: the decrypted payload decrypts again', async () => {
    // The inner IV is fixed so the inner ciphertext is certainly not Opus-shaped: TOC code 3 with
    // a frame count of 0 breaks rule R5 (a random IV would read as valid Opus about half the time).
    const innerIv = Uint8Array.from([0xfb, 0x00, ...Array.from({ length: 10 }, () => 9)]);
    await run('receiver', [await encrypt(await encrypt(opus(), innerIv))]);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'opusInvalid', side: 'receiver' })
    );
    expect(posted).toContainEqual(expect.objectContaining({ type: 'doubleEncrypted', count: 1 }));
  });

  it('accuses no frame whose metadata does not NAME Opus - a RED frame on an engine without mimeType', async () => {
    // WebKit may omit mimeType; a RED (or CN) frame is not an Opus packet by design.
    metadata = () => ({ payloadType: 63 });
    const sent = await run('sender', [notOpus()]);
    await run('receiver', sent);
    expect(posted.filter((m) => m.type === 'opusInvalid')).toEqual([]);
  });
});

describe('encryption.worker - a getMetadata that throws costs no frame', () => {
  const throwing = () => {
    throw new Error('engine says no');
  };

  it('SENDER: the frame is still encrypted and sent, and the throw is logged', async () => {
    metadata = throwing;
    const plain = opus();
    const sent = await run('sender', [plain]);
    expect(sent).toHaveLength(1);
    // Encrypted: IV + ciphertext + 16-byte tag, so never the plaintext itself.
    expect(sent[0].byteLength).toBe(12 + plain.byteLength + 16);
    metadata = OPUS_METADATA;
    expect(await run('receiver', sent)).toEqual([plain]);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'warn',
        detail: expect.stringContaining('getMetadata threw'),
      })
    );
  });

  it('RECEIVER: the frame is still decrypted and forwarded, and AES is not blamed', async () => {
    const plain = opus();
    const cipher = await encrypt(plain);
    metadata = throwing;
    expect(await run('receiver', [cipher])).toEqual([plain]);
    expect(posted.some((m) => m.type === 'decryptError')).toBe(false);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'warn',
        detail: expect.stringContaining('getMetadata threw'),
      })
    );
  });
});

describe('encryption.worker - the sender diagnostics (WebKit sender noise, 2026-10-19)', () => {
  /** 50 Opus frames with RTP timestamps 960 apart; `repeatAt` re-uses the previous frame's. */
  function timedFrames(repeatAt = -1): Uint8Array[] {
    let i = 0;
    metadata = () => {
      const n = i++;
      return { ...OPUS_METADATA(), rtpTimestamp: 960 * (n === repeatAt ? n - 1 : n) };
    };
    return Array.from({ length: 50 }, () => opus());
  }
  const shapes = () => posted.filter((m) => m.type === 'senderAudioShape');

  it('posts ONE line per transformer, with its per-side count and its first frame codec', async () => {
    await run('sender', [opus(), opus()]);
    const lines = posted.filter((m) => m.type === 'transformer');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      side: 'sender',
      mediaKind: 'audio',
      mimeType: 'audio/opus',
      payloadType: 111,
    });
    posted.length = 0;
    await run('sender', [opus()]);
    const next = posted.find((m) => m.type === 'transformer')!;
    expect((next.count as number) - (lines[0].count as number)).toBe(1);
  });

  it('a clean sender posts its shape once, after 50 frames, with no anomaly', async () => {
    await run('sender', timedFrames());
    expect(shapes()).toEqual([
      expect.objectContaining({
        frames: 50,
        notOpus: 0,
        repeatedTs: 0,
        ownIv: 0,
        lenMin: 81,
        lenMax: 81,
        tocClass: 'config31/code0',
        tocShare: 100,
      }),
    ]);
  });

  it('counts a repeated RTP timestamp per transformer, not across transformers', async () => {
    await run('sender', timedFrames(10));
    expect(shapes()[0]).toMatchObject({ repeatedTs: 1 });
    posted.length = 0;
    // A second transformer seeing the SAME timestamps is not a repeat of its own.
    await run('sender', timedFrames());
    expect(shapes()[0]).toMatchObject({ repeatedTs: 0 });
  });

  it('names a chained double pass by the IV it produced, without decrypting, and still sends', async () => {
    const once = await run('sender', timedFrames());
    posted.length = 0;
    const twice = await run('sender', once);
    expect(twice).toHaveLength(50);
    expect(shapes()[0]).toMatchObject({ ownIv: 50 });
    // The frames left encrypted twice: the receiver's own witness still fires.
    posted.length = 0;
    metadata = OPUS_METADATA;
    await run('receiver', twice); // ~half the inner ciphertexts break R1-R7, which triggers the probe
    expect(posted).toContainEqual(expect.objectContaining({ type: 'doubleEncrypted' }));
  });
});

describe('encryption.worker - the report the call asks for (2026-10-19)', () => {
  /** Asks the worker for its report, as CallService does, and returns the answer. */
  async function report(tag: string): Promise<Record<string, unknown>> {
    await scope.onmessage!({ data: { type: 'report', tag } } as MessageEvent);
    const answer = posted.find((m) => m.type === 'report' && m.tag === tag);
    expect(answer).toBeDefined();
    return answer!;
  }

  it('counts every frame the engine hands each side, and answers with the tag it was asked', async () => {
    const before = await report('before');
    const transformers = before.transformers as Record<string, number>;
    const framesIn = before.framesIn as Record<string, number>;
    const sent = await run('sender', [opus(), opus(), opus()]);
    await run('receiver', sent);
    const after = await report('after');
    expect(after.framesIn).toEqual({
      sender: (framesIn.sender ?? 0) + 3,
      receiver: (framesIn.receiver ?? 0) + 3,
    });
    expect(after.transformers).toEqual({
      sender: (transformers.sender ?? 0) + 1,
      receiver: (transformers.receiver ?? 0) + 1,
    });
  });

  it('counts per epoch and kind, and posts ONE inPath evidence per transformer on its first success', async () => {
    const before = await report('by-before');
    const by = (before.framesInBy ?? {}) as Record<string, number>;
    const sent = await run('sender', [opus(), opus()], 7);
    await run('receiver', sent, 7);
    const after = await report('by-after');
    const byAfter = after.framesInBy as Record<string, number>;
    expect(byAfter['7|sender|audio'] - (by['7|sender|audio'] ?? 0)).toBe(2);
    expect(byAfter['7|receiver|audio'] - (by['7|receiver|audio'] ?? 0)).toBe(2);
    const evidence = posted.filter((m) => m.type === 'inPath' && m.epoch === 7);
    expect(evidence).toEqual([
      expect.objectContaining({ side: 'sender', mediaKind: 'audio' }),
      expect.objectContaining({ side: 'receiver', mediaKind: 'audio' }),
    ]);
  });

  it('posts no inPath evidence for a receiver whose frames never decrypt', async () => {
    await run('receiver', [Uint8Array.from({ length: 40 }, () => 9)], 8);
    expect(posted.filter((m) => m.type === 'inPath' && m.epoch === 8)).toEqual([]);
  });

  it('counts an EMPTY receiver frame without a line, and names a non-empty one shorter than an IV', async () => {
    const before = await report('short-before');
    await run('receiver', [new Uint8Array(0), Uint8Array.from([1, 2, 3, 4, 5])]);
    const after = await report('short-after');
    expect(Number(after.tooShort) - Number(before.tooShort)).toBe(2);
    expect(Number(after.tooShortEmpty) - Number(before.tooShortEmpty)).toBe(1);
    const warns = posted.filter((m) => m.type === 'warn');
    expect(warns).toHaveLength(1);
    expect(String(warns[0].detail)).toContain('receiver audio frame of 5 byte(s) dropped');
  });
});

describe('encryption.worker - video frames (lot 2, 2026-10-20)', () => {
  const VP8 = (): Metadata => ({ payloadType: 96, mimeType: 'video/VP8' });
  /** A VP8 key frame: P bit (byte 0, bit 0) clear, start code 9d 01 2a, then the picture. */
  const keyFrame = () =>
    Uint8Array.from([
      0x10,
      0x02,
      0x00,
      0x9d,
      0x01,
      0x2a,
      0x80,
      0x02,
      0xe0,
      0x01,
      ...Array(60).fill(5),
    ]);
  /** A VP8 interframe: P bit set. */
  const interFrame = () => Uint8Array.from([0x31, 0x01, 0x00, ...Array(40).fill(6)]);
  const video = (side: 'sender' | 'receiver', p: Uint8Array[], epoch?: number) =>
    run(side, p, epoch, RTCEncodedVideoFrame);

  it('leaves the VP8 payload header in clear - 10 bytes on a key frame, 3 on an interframe - and encrypts the rest', async () => {
    metadata = VP8;
    const key = keyFrame();
    const inter = interFrame();
    const [k, i] = await video('sender', [key, inter]);
    expect(k.subarray(0, 10)).toEqual(key.subarray(0, 10));
    expect(k.byteLength).toBe(10 + 12 + (key.byteLength - 10) + 16);
    expect(i.subarray(0, 3)).toEqual(inter.subarray(0, 3));
    expect(i.byteLength).toBe(3 + 12 + (inter.byteLength - 3) + 16);
    // The picture itself never leaves in clear.
    expect(k.subarray(22, 22 + 60)).not.toEqual(key.subarray(10));
    expect(await video('receiver', [k, i])).toEqual([key, inter]);
  });

  it('binds the clear header: a frame whose header was altered on the way never decrypts', async () => {
    metadata = VP8;
    const before = (await (async () => {
      await scope.onmessage!({ data: { type: 'report', tag: 'aad-before' } } as MessageEvent);
      return posted.find((m) => m.tag === 'aad-before')!;
    })()) as { decryptFailuresBy: { video: number } };
    const [k] = await video('sender', [keyFrame()]);
    k[7] ^= 0x01; // the frame width, in the clear header
    expect(await video('receiver', [k])).toEqual([]);
    await scope.onmessage!({ data: { type: 'report', tag: 'aad-after' } } as MessageEvent);
    const after = posted.find((m) => m.tag === 'aad-after') as {
      decryptFailuresBy: { video: number };
    };
    expect(after.decryptFailuresBy.video - before.decryptFailuresBy.video).toBe(1);
  });

  it('binds the header LENGTH: a flipped P bit (3 read as 10, or 10 as 3) never decrypts', async () => {
    metadata = VP8;
    const failures = async (tag: string) => {
      await scope.onmessage!({ data: { type: 'report', tag } } as MessageEvent);
      const r = posted.find((m) => m.tag === tag) as { decryptFailuresBy: { video: number } };
      return r.decryptFailuresBy.video;
    };
    const before = await failures('pbit-before');
    const [k, i] = await video('sender', [keyFrame(), interFrame()]);
    k[0] ^= 0x01; // the key frame now reads as an interframe: 3 clear bytes, the IV split moves
    i[0] ^= 0x01; // and the interframe as a key frame: 10 clear bytes
    expect(await video('receiver', [k, i])).toEqual([]);
    expect((await failures('pbit-after')) - before).toBe(2);
  });

  it('passes an EMPTY video frame through on both sides, and decrypt-fails nothing', async () => {
    metadata = VP8;
    const sent = await video('sender', [new Uint8Array(0)]);
    expect(sent).toEqual([new Uint8Array(0)]);
    expect(await video('receiver', sent)).toEqual([new Uint8Array(0)]);
    expect(posted.some((m) => m.type === 'decryptError' || m.type === 'warn')).toBe(false);
  });

  it('drops a sender video frame shorter than its header - never framed so the receiver splits it elsewhere', async () => {
    metadata = VP8;
    expect(await video('sender', [Uint8Array.from([0x10, 1, 2, 3, 4])])).toEqual([]);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'warn',
        detail: expect.stringContaining('sender video frame of 5 byte(s) dropped'),
      })
    );
  });

  it('FAILS CLOSED when the engine names no codec: the frame is encrypted whole and counted', async () => {
    metadata = () => ({ payloadType: 96 });
    const plain = keyFrame();
    const [sent] = await video('sender', [plain]);
    expect(sent.byteLength).toBe(12 + plain.byteLength + 16);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'videoCodecUnexpected', mimeType: '?' })
    );
  });

  it('keeps the audio IV window for audio: video frames in between never flush it', async () => {
    let i = 0;
    metadata = () => ({ ...OPUS_METADATA(), rtpTimestamp: 960 * i++ });
    const once = await run(
      'sender',
      Array.from({ length: 50 }, () => opus())
    );
    metadata = VP8;
    await video(
      'sender',
      Array.from({ length: 100 }, () => interFrame())
    );
    posted.length = 0;
    i = 0;
    metadata = () => ({ ...OPUS_METADATA(), rtpTimestamp: 960 * i++ });
    await run('sender', once);
    expect(posted.find((m) => m.type === 'senderAudioShape')).toMatchObject({ ownIv: 50 });
  });

  it('a video frame of another codec is encrypted WHOLE and named - never sent in clear', async () => {
    metadata = () => ({ payloadType: 102, mimeType: 'video/H264' });
    const plain = Uint8Array.from([0, 0, 0, 1, 0x65, ...Array(30).fill(4)]);
    const [sent] = await video('sender', [plain]);
    expect(sent.byteLength).toBe(12 + plain.byteLength + 16);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'videoCodecUnexpected', mimeType: 'video/H264' })
    );
  });

  it('names a video frame too short for its header and an IV, with its kind', async () => {
    metadata = VP8;
    await video('receiver', [Uint8Array.from([0x31, 1, 0, 9, 9])]);
    const warns = posted.filter((m) => m.type === 'warn');
    expect(String(warns[0].detail)).toContain('receiver video frame of 5 byte(s) dropped');
  });
});

describe('encryption.worker - one key per direction, the kind bound to every frame (2026-10-21)', () => {
  /** The IV the next sealed frame draws, fixed so the wire bytes can be compared to a known answer. */
  const KAT_IV = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  async function sealedWithKatIv(payloads: Uint8Array[], Frame = RTCEncodedAudioFrame) {
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
      a.set(KAT_IV);
      return a;
    }) as typeof crypto.getRandomValues);
    try {
      return await run('sender', payloads, undefined, Frame);
    } finally {
      spy.mockRestore();
    }
  }
  /** The worker's lifetime decrypt failures, read from its report. */
  const failures = async (tag: string) => {
    await scope.onmessage!({ data: { type: 'report', tag } } as MessageEvent);
    return Number(posted.find((m) => m.tag === tag)!.decryptFailures);
  };

  it('seals an audio frame to the known answer: IV || AES-256-GCM(caller key, AAD `canari-call-v2|audio`)', async () => {
    // Computed with node:crypto (createCipheriv aes-256-gcm), outside WebCrypto and this worker.
    metadata = () => ({ payloadType: 63 }); // no Opus check: the payload is not a real packet
    const [sealed] = await sealedWithKatIv([Uint8Array.from([0xf8, 1, 2, 3, 4])]);
    expect(hex(sealed)).toBe('a0a1a2a3a4a5a6a7a8a9aaab41d03f65f99e50fe3f0255996507be6c4d915018ec');
  });

  it('seals a VP8 interframe to the known answer: header || IV || AES-GCM(AAD `canari-call-v2|video` || header)', async () => {
    metadata = () => ({ payloadType: 96, mimeType: 'video/VP8' });
    const [sealed] = await sealedWithKatIv(
      [Uint8Array.from([0x31, 0x01, 0x00, 6, 6, 6, 6])],
      RTCEncodedVideoFrame
    );
    expect(hex(sealed)).toBe(
      '310100a0a1a2a3a4a5a6a7a8a9aaabbfd73b6065bb1a498a706b1ac0542d2c6f5a5666'
    );
  });

  it('opens at the other end what one end sealed', async () => {
    const plain = opus();
    const sealed = await run('sender', [plain]);
    expect(await run('receiver', sealed)).toEqual([plain]);
  });

  it('does NOT open a frame reflected back to the end that sealed it', async () => {
    const before = await failures('reflect-before');
    const sealed = await run('sender', [opus()]);
    // The caller's own receiver opens with the CALLEE key; this frame was sealed with its own.
    const back = await run('receiver', sealed, undefined, RTCEncodedAudioFrame, 'audio', 'caller');
    expect(back).toEqual([]);
    expect((await failures('reflect-after')) - before).toBe(1);
  });

  it('does NOT open an audio frame on a video receiver (the kind is authenticated)', async () => {
    const before = await failures('kind-before');
    const sealed = await run('sender', [opus()]);
    expect(await run('receiver', sealed, undefined, RTCEncodedAudioFrame, 'video')).toEqual([]);
    expect((await failures('kind-after')) - before).toBe(1);
  });

  it("takes the kind from the page's options, never from the frame's class name", async () => {
    const plain = opus();
    const sealed = await run('sender', [plain]);
    // A frame whose class NAME says video, on the audio receiver it was sealed for: it opens.
    expect(await run('receiver', sealed, undefined, RTCEncodedVideoFrame, 'audio')).toEqual([
      plain,
    ]);
  });

  it('forwards nothing, and says so, on a transform the page gave no media kind', async () => {
    expect(await run('sender', [opus()], undefined, RTCEncodedAudioFrame, null)).toEqual([]);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'warn',
        detail: expect.stringContaining('without a media kind'),
      })
    );
  });

  it('refuses two EQUAL keys - they would let a reflected frame open', async () => {
    await scope.onmessage!({
      data: {
        type: 'setKeys',
        send: CALLER_KEY.slice().buffer,
        receive: CALLER_KEY.slice().buffer,
      },
    } as MessageEvent);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'keyError', detail: 'the send and receive keys are equal' })
    );
  });

  it('refuses a key of the wrong length, naming which', async () => {
    await scope.onmessage!({
      data: {
        type: 'setKeys',
        send: new Uint8Array(16).buffer,
        receive: CALLEE_KEY.slice().buffer,
      },
    } as MessageEvent);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'keyError', detail: 'invalid send key length 16' })
    );
  });

  describe('a receiver that opens nothing (the two ends hold different keys)', () => {
    /** Frames sealed by an end holding ANOTHER caller key: what a peer at another MLS epoch sends. */
    async function foreignFrames(n: number): Promise<Uint8Array[]> {
      const other = await crypto.subtle.importKey(
        'raw',
        Uint8Array.from({ length: 32 }, () => 0x55),
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );
      const aad = new TextEncoder().encode('canari-call-v2|audio');
      return Promise.all(
        Array.from({ length: n }, async () => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const c = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, other, opus())
          );
          return Uint8Array.from([...iv, ...c]);
        })
      );
    }
    const undecryptable = () => posted.filter((m) => m.type === 'undecryptable');

    it('is reported ONCE per receiver, at its 100th failure, with its epoch and kind', async () => {
      await run('receiver', await foreignFrames(99), 21);
      expect(undecryptable()).toEqual([]);
      await run('receiver', await foreignFrames(150), 22);
      expect(undecryptable()).toEqual([
        { type: 'undecryptable', epoch: 22, mediaKind: 'audio', failures: 100 },
      ]);
    });

    it('is never reported by a receiver that opened a frame first', async () => {
      const good = await run('sender', [opus()]);
      await run('receiver', [...good, ...(await foreignFrames(120))], 23);
      expect(undecryptable()).toEqual([]);
    });

    it('does not count short frames: they say nothing about the key', async () => {
      await run(
        'receiver',
        Array.from({ length: 120 }, () => Uint8Array.from([1, 2, 3])),
        24
      );
      expect(undecryptable()).toEqual([]);
    });
  });

  it('reports a transform that throws to the page, sampled - never one line per frame', async () => {
    await scope.onmessage!({ data: { type: 'report', tag: 'te-before' } } as MessageEvent);
    const before = Number(posted.find((m) => m.tag === 'te-before')!.transformErrors);
    await keyAs('caller');
    // A frame whose data cannot be read throws inside the transform's try.
    const broken = Object.defineProperty(new RTCEncodedAudioFrame(new ArrayBuffer(0)), 'data', {
      get(): ArrayBuffer {
        throw new Error('frame unreadable');
      },
    });
    const input = new ReadableStream({
      start(c) {
        for (let i = 0; i < 250; i++) c.enqueue(broken);
        c.close();
      },
    });
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    scope.onrtctransform!({
      transformer: {
        readable: input,
        writable: new WritableStream({ close: () => done() }),
        options: { side: 'sender', kind: 'audio' },
      },
    } as unknown as Event);
    await finished;
    const lines = posted.filter((m) => m.type === 'transformError');
    expect(lines.map((l) => Number(l.count) - before)).toEqual([1, 2, 3, 100, 200]);
    expect(String(lines[0].detail)).toContain('frame unreadable');
  });
});
