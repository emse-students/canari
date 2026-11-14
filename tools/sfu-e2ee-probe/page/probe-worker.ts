/**
 * The app's E2E worker (`encryption.worker.ts`), UNCHANGED, with one tap on each side of it - the
 * Q4 probe's way of answering "did the payload arrive byte for byte", which the worker itself never
 * asks.
 *
 * - On a SENDER transform, the tap sits AFTER the app's transform: it digests each frame exactly as
 *   the app wrote it to the wire (encrypted, the VP8 clear header in front).
 * - On a RECEIVER transform, the tap sits BEFORE the app's transform: it digests each frame exactly
 *   as the engine handed it over, before any decrypt.
 *
 * The publisher's and the subscriber's digests are then compared by the driver (`lib.mjs`,
 * `compareDigests`). The worker is imported, never copied: the transform under test is the app's.
 *
 * The tap only reads `frame.data`; it never changes a frame, and it forwards every frame it is
 * given, so the app's transform sees the same stream it would see without it.
 */
import '../../../frontend/src/lib/workers/encryption.worker';

type Kind = 'audio' | 'video';
type Direction = 'sent' | 'received';

interface TransformerLike {
  readable: ReadableStream;
  writable: WritableStream;
  options?: { side?: string; kind?: string };
}

type Scope = typeof self & { onrtctransform: ((event: Event) => void) | null };
const scope = self as Scope;

/** At most this many digests per direction and kind: a probe run is a few thousand frames. */
const CAP = 20_000;
const digests: Record<Direction, Record<Kind, string[]>> = {
  sent: { audio: [], video: [] },
  received: { audio: [], video: [] },
};

/**
 * `<byteLength>:<16 hex>`: two FNV-1a 32-bit passes with different offsets. Not cryptographic and
 * not meant to be - the frames are AES-GCM ciphertexts under a random IV, so two distinct frames
 * colliding on 64 bits AND a length is not a case a few thousand frames meet.
 */
function digest(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ bytes[i], 0x01000193) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return `${bytes.length}:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

function tap(direction: Direction, kind: Kind) {
  const list = digests[direction][kind];
  return new TransformStream({
    transform(frame: { data: ArrayBuffer }, controller) {
      if (list.length < CAP) list.push(digest(frame.data));
      controller.enqueue(frame);
    },
  });
}

const appTransform = scope.onrtctransform;
const appMessage = self.onmessage;

if (!appTransform || !appMessage) {
  // The app's worker no longer installs its handlers on import: the probe would test nothing.
  self.postMessage({
    type: 'probeFault',
    detail: 'encryption.worker.ts installed no onrtctransform/onmessage handler on import',
  });
} else {
  scope.onrtctransform = (event: Event) => {
    const t = (event as unknown as { transformer: TransformerLike }).transformer;
    const kind = t.options?.kind === 'video' ? 'video' : 'audio';
    let readable = t.readable;
    let writable = t.writable;
    if (t.options?.side === 'sender') {
      const out = tap('sent', kind);
      void out.readable.pipeTo(t.writable);
      writable = out.writable;
    } else {
      readable = t.readable.pipeThrough(tap('received', kind));
    }
    appTransform({ transformer: { readable, writable, options: t.options } } as unknown as Event);
  };
  self.onmessage = (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type === 'probeDigests') {
      self.postMessage({ type: 'probeDigests', digests });
      return;
    }
    return appMessage.call(self, event);
  };
}
