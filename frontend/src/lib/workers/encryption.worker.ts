// encryption.worker.ts — WebRTC Encoded Transform (insertable streams) for MLS-derived call keys.

/** Minimal typing for RTCTransformEvent (DOM lib may omit it in worker context). */
interface TransformEventLike {
  transformer: {
    readable: ReadableStream;
    writable: WritableStream;
    options?: { side?: string };
  };
}

let callKey: CryptoKey | null = null;
const ivLength = 12;

/** Receives the AES-GCM key from the main thread (not transferable on every frame). */
self.onmessage = (event: MessageEvent<{ type: string; payload?: CryptoKey }>) => {
  if (event.data?.type === 'setKey') {
    callKey = event.data.payload ?? null;
  }
};

/**
 * Browser fires `rtctransform` when RTCRtpScriptTransform is attached — not postMessage.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/RTCTransformEvent
 */
self.addEventListener('rtctransform', (event) => {
  const transformEvent = event as unknown as TransformEventLike;
  const side = (transformEvent.transformer.options as { side?: string } | undefined)?.side;
  const transform = new TransformStream({
    transform: async (frame, controller) => {
      if (!callKey) {
        controller.enqueue(frame);
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

  transformEvent.transformer.readable
    .pipeThrough(transform)
    .pipeTo(transformEvent.transformer.writable);
});

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
    console.error('[Worker] Decryption failed', e);
  }
}
