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

/** Named like the engine's class: the worker reads the kind from the constructor's name. */
class RTCEncodedAudioFrame {
  constructor(public data: ArrayBuffer) {}
  getMetadata() {
    return metadata();
  }
}

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const posted: Array<Record<string, unknown>> = [];
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
  await scope.onmessage!({ data: { type: 'setKey', payload: KEY.slice().buffer } } as MessageEvent);
  expect(posted.some((m) => m.type === 'keyReady')).toBe(true);
  key = await crypto.subtle.importKey('raw', KEY, { name: 'AES-GCM' }, false, ['encrypt']);
});

afterEach(() => {
  posted.length = 0;
  metadata = OPUS_METADATA;
});

async function encrypt(
  plain: Uint8Array<ArrayBuffer>,
  iv = crypto.getRandomValues(new Uint8Array(12))
): Promise<Uint8Array<ArrayBuffer>> {
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(12 + c.length);
  out.set(iv);
  out.set(c, 12);
  return out;
}

/** Runs frames through one transform of the worker and returns what it forwarded. */
async function run(side: 'sender' | 'receiver', payloads: Uint8Array[]): Promise<Uint8Array[]> {
  const input = new ReadableStream({
    start(c) {
      for (const p of payloads) c.enqueue(new RTCEncodedAudioFrame(p.slice().buffer));
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
    transformer: { readable: input, writable, options: { side } },
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

  it('counts an EMPTY receiver frame without a line, and names a non-empty one shorter than an IV', async () => {
    const before = await report('short-before');
    await run('receiver', [new Uint8Array(0), Uint8Array.from([1, 2, 3, 4, 5])]);
    const after = await report('short-after');
    expect(Number(after.tooShort) - Number(before.tooShort)).toBe(2);
    expect(Number(after.tooShortEmpty) - Number(before.tooShortEmpty)).toBe(1);
    const warns = posted.filter((m) => m.type === 'warn');
    expect(warns).toHaveLength(1);
    expect(String(warns[0].detail)).toContain('receiver frame of 5 byte(s) dropped');
  });
});
