// encryption.worker.ts - WebRTC Encoded Transform (insertable streams) for MLS-derived call keys.

/** Minimal typing for RTCTransformEvent (DOM lib may omit it in worker context). */
interface TransformEventLike {
  transformer: {
    readable: ReadableStream;
    writable: WritableStream;
    options?: Partial<CallTransformOptions>;
  };
}

import {
  callMediaKind,
  frameAad,
  type CallMediaKind,
  type CallTransformOptions,
} from '../utils/callKeys';

/** One key per direction (`utils/callKeys.ts`): this device encrypts with `send`, decrypts with `receive`. */
let sendKey: CryptoKey | null = null;
let receiveKey: CryptoKey | null = null;
const ivLength = 12;
let decryptFailures = 0;
let transformErrors = 0;
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

/** Receives the two AES-GCM keys from the main thread (raw bytes, not CryptoKey). */
self.onmessage = async (
  event: MessageEvent<{ type: string; send?: ArrayBuffer; receive?: ArrayBuffer }>
) => {
  if (event.origin && event.origin !== self.location.origin) return;
  if (event.data?.type === 'getCounters') {
    // The EXACT totals for the call report (WP-C2): the progress messages below are sampled
    // (first frame, then every 300), so they cannot be summed into a count.
    self.postMessage({
      type: 'counters',
      counters: {
        encFrames: encrypted.audio + encrypted.video,
        decFrames: decrypted.audio + decrypted.video,
        decFail: decryptFailures,
        keyframesIn: videoKeyframesIn,
      },
    });
    return;
  }
  if (event.data?.type === 'setKeys') {
    const { send, receive } = event.data;
    for (const [name, raw] of [
      ['send', send],
      ['receive', receive],
    ] as const) {
      if (!raw || raw.byteLength !== 32) {
        self.postMessage({
          type: 'keyError',
          detail: `invalid ${name} key length ${raw?.byteLength ?? 0}`,
        });
        return;
      }
    }
    try {
      // Each key can do ONE thing: the send key cannot decrypt, the receive key cannot encrypt.
      sendKey = await crypto.subtle.importKey('raw', send!, { name: 'AES-GCM' }, false, [
        'encrypt',
      ]);
      receiveKey = await crypto.subtle.importKey('raw', receive!, { name: 'AES-GCM' }, false, [
        'decrypt',
      ]);
      self.postMessage({ type: 'keyReady' });
    } catch (e) {
      const detail = String(e);
      self.postMessage({ type: 'keyError', detail });
    }
  }
};

workerScope.onrtctransform = (event: Event) => {
  const transformEvent = event as unknown as TransformEventLike;
  const options = transformEvent.transformer.options;
  const side = options?.side;
  // The kind comes from the page, which knows the track: it is bound into every frame's AAD, so a
  // transform without one forwards nothing rather than guessing.
  const mediaKind = callMediaKind(options?.kind);

  if (side !== 'sender' && side !== 'receiver') {
    self.postMessage({ type: 'warn', detail: `unknown transform side: ${String(side)}` });
  }
  if (!mediaKind) {
    self.postMessage({
      type: 'warn',
      detail: `transform without a media kind (${String(options?.kind)}) - every frame dropped`,
    });
  }

  const transform = new TransformStream({
    transform: async (frame, controller) => {
      if (!mediaKind) return;
      if (!sendKey || !receiveKey) {
        droppedNoKey++;
        if (droppedNoKey <= 3 || droppedNoKey % 200 === 0) {
          self.postMessage({ type: 'droppedNoKey', count: droppedNoKey });
        }
        return;
      }
      try {
        if (side === 'sender') {
          await encryptFrame(frame, mediaKind, controller);
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
          // Counted only when it decrypted: a failed frame is `decryptError`, and counting it here
          // too made a wrong-key call log `decryptOk` (measured in Chrome 155, 2026-10-17).
          if (!(await decryptFrame(frame, mediaKind, controller))) return;
          decrypted[mediaKind]++;
          if (decrypted[mediaKind] === 1 || decrypted[mediaKind] % 300 === 0) {
            self.postMessage({ type: 'decryptOk', count: decrypted[mediaKind], mediaKind });
          }
        }
      } catch (e) {
        // Reported to the page, which writes it to the call log: a console line in a worker
        // reaches no exported log, and a frame lost here is otherwise lost without a trace.
        // Sampled like decrypt failures: a transform that throws throws on EVERY frame (50 a
        // second), and one log line per frame would bury the call log.
        transformErrors++;
        if (isSampled(transformErrors)) {
          self.postMessage({ type: 'transformError', detail: String(e), count: transformErrors });
        }
      }
    },
  });

  void transformEvent.transformer.readable
    .pipeThrough(transform)
    .pipeTo(transformEvent.transformer.writable);
};

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
  kind: CallMediaKind,
  controller: TransformStreamDefaultController
) {
  const iv = crypto.getRandomValues(new Uint8Array(ivLength));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: frameAad(kind) as BufferSource },
    sendKey!,
    frame.data
  );

  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), ivLength);

  frame.data = packed.buffer;
  controller.enqueue(frame);
}

/** Decrypts one frame and forwards it; `false` when it was dropped (too short, or wrong key). */
async function decryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  kind: CallMediaKind,
  controller: TransformStreamDefaultController
): Promise<boolean> {
  const data = new Uint8Array(frame.data);
  if (data.byteLength < ivLength) {
    // Too short to carry an IV: a frame that was never encrypted (a peer sending in clear). It
    // is a decrypt failure like any other, or `dec_fail` would read 0 on exactly that call.
    recordDecryptFailure(`frame of ${data.byteLength} byte(s) is shorter than an IV`);
    return false;
  }

  const iv = data.slice(0, ivLength);
  const ciphertext = data.slice(ivLength);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: frameAad(kind) as BufferSource },
      receiveKey!,
      ciphertext
    );
    frame.data = plaintext;
    controller.enqueue(frame);
    return true;
  } catch (e) {
    recordDecryptFailure(String(e));
    return false;
  }
}

/** The failures the page is told about: the first three, then every 100th. */
function isSampled(count: number): boolean {
  return count <= 3 || count % 100 === 0;
}

/** Counts one dropped frame, and tells the page about the sampled ones. */
function recordDecryptFailure(detail: string) {
  decryptFailures++;
  if (isSampled(decryptFailures)) {
    self.postMessage({ type: 'decryptError', detail, count: decryptFailures });
  }
}
