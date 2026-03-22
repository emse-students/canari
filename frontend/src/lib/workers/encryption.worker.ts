// encryption.worker.ts

let callKey: CryptoKey | null = null;
const ivLength = 12;

self.onmessage = async (event) => {
  const { type, payload } = event.data;

  if (type === 'setKey') {
    callKey = payload;
    console.log('[Worker] Encryption key set');
  } else if (type === 'rtctransform') {
    const {
      transformer: { readable, writable },
      side,
    } = payload;

    const transformStream = new TransformStream({
      transform: async (frame, controller) => {
        if (!callKey) {
          // Pass through if key not ready
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
          // Drop frame on error rather than sending unencrypted
        }
      },
    });

    readable.pipeThrough(transformStream).pipeTo(writable);
  }
};

async function encryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController
) {
  const iv = crypto.getRandomValues(new Uint8Array(ivLength));
  // frame.data is ArrayBuffer
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, callKey!, frame.data);

  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), 12);

  frame.data = packed.buffer;
  controller.enqueue(frame);
}

async function decryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController
) {
  const data = new Uint8Array(frame.data);
  if (data.byteLength < ivLength) return; // Too short

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
