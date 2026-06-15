// encryption.worker.ts - WebRTC Encoded Transform (insertable streams) for MLS-derived call keys.

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
let decryptFailures = 0;
// Per-kind counters so the logs unambiguously show whether *video* (not just audio)
// frames flow through the E2E transform - critical for diagnosing black remote video.
const encrypted = { audio: 0, video: 0 };
const decrypted = { audio: 0, video: 0 };
let videoKeyframesIn = 0;
let droppedNoKey = 0;
/** `onrtctransform` is the standard handler (Firefox 117+); typed explicitly for workers. */
type RtcTransformWorkerScope = typeof self & {
  onrtctransform: ((event: Event) => void) | null;
};

const workerScope = self as RtcTransformWorkerScope;

/** Receives the AES-GCM key material from the main thread (raw bytes, not CryptoKey). */
self.onmessage = async (event: MessageEvent<{ type: string; payload?: ArrayBuffer }>) => {
  if (event.origin && event.origin !== self.location.origin) return;
  if (event.data?.type === 'setKey') {
    const raw = event.data.payload;
    if (!raw || raw.byteLength !== 32) {
      self.postMessage({ type: 'keyError', detail: `invalid key length ${raw?.byteLength ?? 0}` });
      return;
    }
    try {
      callKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]);
      self.postMessage({ type: 'keyReady' });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      self.postMessage({ type: 'keyError', detail });
    }
  }
};

workerScope.onrtctransform = (event: Event) => {
  const transformEvent = event as unknown as TransformEventLike;
  const side = (transformEvent.transformer.options as { side?: string } | undefined)?.side;

  if (side !== 'sender' && side !== 'receiver') {
    self.postMessage({ type: 'warn', detail: `unknown transform side: ${String(side)}` });
  }

  const transform = new TransformStream({
    transform: async (frame, controller) => {
      if (!callKey) {
        droppedNoKey++;
        if (droppedNoKey <= 3 || droppedNoKey % 200 === 0) {
          self.postMessage({ type: 'droppedNoKey', count: droppedNoKey });
        }
        return;
      }
      try {
        const mediaKind = frameTypeLabel(frame);
        if (side === 'sender') {
          await encryptFrame(frame, controller);
          encrypted[mediaKind]++;
          if (encrypted[mediaKind] === 1 || encrypted[mediaKind] % 300 === 0) {
            self.postMessage({ type: 'encryptOk', count: encrypted[mediaKind], mediaKind });
          }
        } else {
          // Track the first decodable video keyframe arrival: a remote video that
          // never receives a keyframe stays black even though delta frames flow.
          if (mediaKind === 'video' && isVideoKeyframe(frame)) {
            videoKeyframesIn++;
            if (videoKeyframesIn <= 3) {
              self.postMessage({ type: 'videoKeyframeIn', count: videoKeyframesIn });
            }
          }
          await decryptFrame(frame, controller);
          decrypted[mediaKind]++;
          if (decrypted[mediaKind] === 1 || decrypted[mediaKind] % 300 === 0) {
            self.postMessage({ type: 'decryptOk', count: decrypted[mediaKind], mediaKind });
          }
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

function frameTypeLabel(frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame): 'audio' | 'video' {
  return frame.constructor.name.includes('Video') ? 'video' : 'audio';
}

/** True when an encoded video frame is a keyframe (IDR). Browser support varies. */
function isVideoKeyframe(frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame): boolean {
  const f = frame as unknown as {
    type?: string;
    getMetadata?: () => Record<string, unknown> | undefined;
  };
  if (typeof f.type === 'string') return f.type === 'key';
  try {
    return f.getMetadata?.()?.frameType === 'key';
  } catch {
    return false;
  }
}

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
