// encryption.worker.ts — WebRTC Encoded Transform (insertable streams) for MLS-derived call keys.

/** Minimal typing for RTCTransformEvent (DOM lib may omit it in worker context). */
interface TransformEventLike {
  transformer: {
    readable: ReadableStream;
    writable: WritableStream;
    options?: { side?: string };
  };
}

/** `onrtctransform` exists at runtime but is missing from default worker lib types. */
type RtcTransformWorkerScope = typeof self & {
  onrtctransform: ((event: Event) => void) | null;
};

const workerScope = self as RtcTransformWorkerScope;

let callKey: CryptoKey | null = null;
const ivLength = 12;
let decryptFailures = 0;

/** Receives the AES-GCM key from the main thread (not transferable on every frame). */
self.onmessage = (event: MessageEvent<{ type: string; payload?: CryptoKey }>) => {
  if (event.data?.type === 'setKey') {
    callKey = event.data.payload ?? null;
    self.postMessage({ type: 'keyReady' });
  }
};

/**
 * One handler per worker — `addEventListener` would stack and break every pipe after the
 * second RTCRtpScriptTransform (symptom: remote video with a live track but black frames).
 * @see https://developer.mozilla.org/en-US/docs/Web/API/RTCTransformEvent
 */
workerScope.onrtctransform = (event: Event) => {
  const transformEvent = event as unknown as TransformEventLike;
  const side = (transformEvent.transformer.options as { side?: string } | undefined)?.side;
  const transform = new TransformStream({
    transform: async (frame, controller) => {
      if (!callKey) {
        // Drop until key is set — passthrough would make the remote decrypt fail permanently.
        return;
      }
      try {
        if (side === 'sender') {
          await encryptFrame(frame, controller);
        } else {
          await decryptFrame(frame, controller);
        }
      } catch (e) {
        console.error('[Worker] Transform error:', e);
      }
    },
  });

  void transformEvent.transformer.readable
    .pipeThrough(transform)
    .pipeTo(transformEvent.transformer.writable);
};

async function encryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController
) {
  const iv = crypto.getRandomValues(new Uint8Array(ivLength));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, callKey!, frame.data);

  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), ivLength);

  frame.data = packed.buffer;
  controller.enqueue(frame);
}

async function decryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController
) {
  const data = new Uint8Array(frame.data);
  if (data.byteLength < ivLength) return;

  const iv = data.slice(0, ivLength);
  const ciphertext = data.slice(ivLength);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, callKey!, ciphertext);
    frame.data = plaintext;
    controller.enqueue(frame);
  } catch (e) {
    decryptFailures++;
    if (decryptFailures <= 3 || decryptFailures % 100 === 0) {
      const detail = e instanceof Error ? e.message : String(e);
      self.postMessage({ type: 'decryptError', detail, count: decryptFailures });
    }
    console.error('[Worker] Decryption failed', e);
  }
}
