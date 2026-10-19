/**
 * The app's REAL E2E worker (`encryption.worker.ts`), with an optional network impairment in front
 * of its RECEIVER side. The receiver transform runs between the depacketiser and the jitter buffer
 * (NetEq), so a frame dropped here is a lost packet to NetEq - its FEC and concealment answer it
 * exactly as they would a packet lost on the wire - and a frame held here arrives late.
 *
 * Options (passed in `RTCRtpScriptTransform`'s options beside the app's own `side`):
 * `loss` (mean loss ratio), `burst` (mean burst length, packets), `jitterMs` (max extra delay,
 * uniform, order preserved), `seed`, and `passthrough` (no E2E: forward frames untouched, so an
 * impairment can be applied to an unencrypted call too).
 */
import '../../../frontend/src/lib/workers/encryption.worker';

interface Transformer {
  readable: ReadableStream;
  writable: WritableStream;
  options?: {
    side?: string;
    loss?: number;
    burst?: number;
    jitterMs?: number;
    seed?: number;
    passthrough?: boolean;
    doubleEncrypt?: boolean;
  };
}

type Scope = typeof self & { onrtctransform: ((event: Event) => void) | null };
const scope = self as Scope;
const appHandler = scope.onrtctransform;
if (!appHandler) throw new Error('the app worker installed no onrtctransform');

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let dropped = 0;
let passed = 0;

scope.onrtctransform = (event: Event) => {
  const transformer = (event as unknown as { transformer: Transformer }).transformer;
  const o = transformer.options ?? {};
  let readable = transformer.readable;
  if (o.side === 'receiver' && ((o.loss ?? 0) > 0 || (o.jitterMs ?? 0) > 0)) {
    const rand = prng(o.seed ?? 7);
    const loss = o.loss ?? 0;
    const burst = Math.max(1, o.burst ?? 1);
    // Two-state (Gilbert) loss: mean burst `burst`, stationary loss ratio `loss`.
    const pEnter = loss > 0 ? loss / (burst * (1 - loss)) : 0;
    const pStay = 1 - 1 / burst;
    let bad = false;
    readable = readable.pipeThrough(
      new TransformStream({
        async transform(frame, controller) {
          bad = bad ? rand() < pStay : rand() < pEnter;
          if (bad) {
            dropped++;
            return;
          }
          passed++;
          if (o.jitterMs) await new Promise((r) => setTimeout(r, rand() * (o.jitterMs ?? 0)));
          controller.enqueue(frame);
        },
      })
    );
  }
  // The bit-exact TAP: the PLAINTEXT payload of every frame, on the sender BEFORE the app encrypts
  // it and on the receiver AFTER the app decrypts it. The driver compares the two lists across
  // the two processes: a decrypted frame that is not byte-identical to one the other side encoded
  // is corrupted audio reaching the decoder, the one fault that sounds like formless noise.
  const taps = o.side === 'sender' ? sentTap : receivedTap;
  const tap = () =>
    new TransformStream({
      transform(frame: { data: ArrayBuffer }, controller) {
        taps.push(fnv(new Uint8Array(frame.data)));
        controller.enqueue(frame);
      },
    });
  let writable = transformer.writable;
  if (o.side === 'sender') readable = readable.pipeThrough(tap());
  else {
    const t2 = tap();
    void t2.readable.pipeTo(transformer.writable);
    writable = t2.writable;
  }
  if (o.passthrough) {
    void readable.pipeTo(writable);
    return;
  }
  // Built field by field: the platform transformer's members are prototype getters, so a spread
  // would copy none of them.
  if (o.side === 'sender' && o.doubleEncrypt) {
    // FAULT: the app transform applied TWICE on this sender - frames leave encrypted two times.
    const between = new TransformStream();
    appHandler({
      transformer: { readable, writable: between.writable, options: transformer.options },
    } as unknown as Event);
    appHandler({
      transformer: { readable: between.readable, writable, options: transformer.options },
    } as unknown as Event);
    return;
  }
  appHandler({
    transformer: { readable, writable, options: transformer.options },
  } as unknown as Event);
};

/** FNV-1a over the payload, with its length: a frame's identity for the cross-process compare. */
function fnv(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return `${b.length}:${h.toString(16)}`;
}

const sentTap: string[] = [];
const receivedTap: string[] = [];
self.addEventListener('message', (e: MessageEvent<{ type: string }>) => {
  if (e.data?.type === 'dumpTap')
    self.postMessage({ type: 'tap', sent: sentTap, received: receivedTap });
});

setInterval(() => self.postMessage({ type: 'impair', dropped, passed }), 1000);
