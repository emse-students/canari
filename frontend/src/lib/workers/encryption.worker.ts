// encryption.worker.ts - WebRTC Encoded Transform (insertable streams) for MLS-derived call keys.

import { isValidOpusPacket } from '../utils/opusPacket';

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
/** Plaintext audio payloads that are NOT Opus packets, per side (see `checkOpus`). */
const opusInvalid = { sender: 0, receiver: 0 };
/** Receiver payloads that decrypted TWICE with the call key: the sender encrypted them twice. */
let doubleEncrypted = 0;
/** Frames whose `getMetadata()` threw (see `frameMetadata`). */
let metadataFailures = 0;
/** Every transformer this worker was handed is numbered, and counted per side (`onrtctransform`). */
let transformerSeq = 0;
const transformersPerSide: Record<string, number> = {};
/**
 * The IVs of the last frames this worker ENCRYPTED, as hex. A sender input that STARTS with one of
 * them is a frame this worker already encrypted, handed back for a second pass: exact, and no
 * decrypt (the IV is 12 random bytes, so a real Opus payload never matches by chance).
 */
const recentIvs: string[] = [];
const recentIvSet = new Set<string>();
const RECENT_IVS = 64;
/** RTP timestamps remembered per sender transformer, to see one frame handed over twice. */
const RECENT_TS = 64;
/** The sender audio shape is posted after this many frames, then every `SHAPE_EVERY` IF anomalous. */
const SHAPE_FIRST = 50;
const SHAPE_EVERY = 1500;
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
      const detail = String(e);
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
  // The app attaches ONE transformer per sender and ONE per receiver: the per-side count, posted
  // with the first frame's codec, makes a second audio sender transformer (a double attach) visible.
  const id = ++transformerSeq;
  const sideKey = String(side);
  transformersPerSide[sideKey] = (transformersPerSide[sideKey] ?? 0) + 1;
  const sideCount = transformersPerSide[sideKey];
  let firstFrameSeen = false;
  const shape = newSenderShape(id);

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
        // Read once per frame and shared: each read of a throwing `getMetadata` is a log line.
        const meta =
          !firstFrameSeen || (side === 'sender' && mediaKind === 'audio')
            ? frameMetadata(frame)
            : undefined;
        if (!firstFrameSeen && meta) {
          firstFrameSeen = true;
          self.postMessage({
            type: 'transformer',
            id,
            side: sideKey,
            count: sideCount,
            mediaKind,
            mimeType: meta.mimeType ?? '?',
            payloadType: meta.payloadType ?? -1,
          });
        }
        if (side === 'sender') {
          if (mediaKind === 'audio') {
            const payload = new Uint8Array(frame.data);
            const valid = checkOpus(frame, payload, 'sender', meta);
            recordSenderShape(shape, payload, valid, meta?.rtpTimestamp);
          }
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
          // Counted only when it decrypted: a failed frame is `decryptError`, and counting it here
          // too made a wrong-key call log `decryptOk` (measured in Chrome 155, 2026-10-17).
          if (!(await decryptFrame(frame, controller))) return;
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

/**
 * Counts and names a plaintext audio payload that is not an Opus packet (RFC 6716 R1-R7): on the
 * sender BEFORE it is encrypted, on the receiver AFTER it is decrypted. The payload is forwarded
 * unchanged - this is a witness, not a filter: the decoder rejects such a frame itself and NetEq
 * conceals it, and what was missing until 2026-10-19 was knowing WHICH side handed it over (a Mi 9T
 * hearing an iPhone logged NetEq decode errors on 30 % of packets with no way to say). Only a frame
 * whose metadata NAMES `audio/opus` is checked: a RED or CN frame is not an Opus packet by design,
 * and an engine that omits `mimeType` (WebKit may) gives no way to tell one from the other, so it
 * is never accused - that side's witness is silent rather than wrong.
 * Returns whether the payload is a valid Opus packet (or was not checked).
 */
function checkOpus(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  payload: Uint8Array,
  side: 'sender' | 'receiver',
  knownMeta?: FrameMeta
): boolean {
  // An EMPTY payload is the encoder saying "nothing this frame" (DTX), not a packet: measured in
  // Chrome 155 with usedtx=1, which hands the transform 0-byte frames in every pause.
  if (payload.byteLength === 0) return true;
  const meta = knownMeta ?? frameMetadata(frame);
  if (meta.mimeType?.toLowerCase() !== 'audio/opus') return true;
  if (isValidOpusPacket(payload)) return true;
  const count = ++opusInvalid[side];
  if (count <= 3 || count % 100 === 0) {
    self.postMessage({
      type: 'opusInvalid',
      side,
      count,
      length: payload.byteLength,
      toc: payload[0] ?? -1,
      payloadType: meta.payloadType ?? -1,
    });
  }
  return false;
}

/**
 * A decrypted audio payload that is not Opus: does it decrypt AGAIN with the same key? If so the
 * sender applied the transform twice, which is proof, not inference - logged, never undone here.
 */
async function probeDoubleEncryption(clear: Uint8Array): Promise<void> {
  if (clear.byteLength <= ivLength || !callKey) return;
  try {
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: clear.slice(0, ivLength) },
      callKey,
      clear.slice(ivLength)
    );
  } catch {
    // The expected answer: the payload is not a second ciphertext under this key.
    return;
  }
  doubleEncrypted++;
  if (doubleEncrypted <= 3 || doubleEncrypted % 100 === 0) {
    self.postMessage({ type: 'doubleEncrypted', count: doubleEncrypted });
  }
}

/** The fields of an encoded frame's metadata the worker reads. */
interface FrameMeta {
  mimeType?: string;
  payloadType?: number;
  rtpTimestamp?: number;
}

/**
 * The frame's metadata, or an empty object on an engine without `getMetadata` or one whose
 * `getMetadata` throws. The witness must never cost a frame: a throw here propagated to the
 * transform's catch, which dropped a sender frame before encryption and, on the receiver, sat
 * inside the decrypt `try` and was reported as an AES failure. So it is caught and logged here.
 */
function frameMetadata(frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame): FrameMeta {
  const f = frame as { getMetadata?: () => FrameMeta };
  if (typeof f.getMetadata !== 'function') return {};
  try {
    return f.getMetadata() ?? {};
  } catch (e) {
    metadataFailures++;
    if (metadataFailures <= 3 || metadataFailures % 100 === 0) {
      self.postMessage({
        type: 'warn',
        detail: `frame getMetadata threw (${metadataFailures} so far): ${String(e)}`,
      });
    }
    return {};
  }
}

/** Hex of the first `ivLength` bytes - an IV's identity in `recentIvs`. */
function ivKey(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < ivLength; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Remembers an IV this worker just produced (the last `RECENT_IVS` of them). */
function rememberIv(iv: Uint8Array): void {
  const k = ivKey(iv);
  recentIvs.push(k);
  recentIvSet.add(k);
  if (recentIvs.length > RECENT_IVS) recentIvSet.delete(recentIvs.shift()!);
}

/** Running shape of one sender audio transformer's input - lengths and Opus TOC classes only. */
interface SenderShape {
  id: number;
  frames: number;
  /** Payloads named `audio/opus` that break RFC 6716 R1-R7 (`checkOpus`). */
  notOpus: number;
  /** Frames whose RTP timestamp this transformer had already seen: one frame handed over twice. */
  repeatedTs: number;
  /** Frames starting with an IV this worker produced: its own output, handed back (double pass). */
  ownIv: number;
  recentTs: number[];
  lenMin: number;
  lenMax: number;
  lenSum: number;
  /** Count per TOC class `config << 2 | code` (RFC 6716 section 3.1): mode, bandwidth, frame size. */
  tocClasses: Map<number, number>;
}

function newSenderShape(id: number): SenderShape {
  return {
    id,
    frames: 0,
    notOpus: 0,
    repeatedTs: 0,
    ownIv: 0,
    recentTs: [],
    lenMin: Number.POSITIVE_INFINITY,
    lenMax: 0,
    lenSum: 0,
    tocClasses: new Map(),
  };
}

/**
 * Records one sender audio input. Posts a summary after `SHAPE_FIRST` frames, then every
 * `SHAPE_EVERY` ONLY when an anomaly counter is non-zero, so a clean call logs it once. The TOC
 * byte is the codec's framing (mode, bandwidth, frame size), never the voice; no payload byte
 * leaves the worker. A witness, never a filter: the frame is encrypted and sent as it came.
 */
function recordSenderShape(
  shape: SenderShape,
  payload: Uint8Array,
  validOpus: boolean,
  ts: number | undefined
): void {
  shape.frames++;
  if (!validOpus) shape.notOpus++;
  const len = payload.byteLength;
  shape.lenMin = Math.min(shape.lenMin, len);
  shape.lenMax = Math.max(shape.lenMax, len);
  shape.lenSum += len;
  if (len > 0) {
    const cls = ((payload[0] >> 3) << 2) | (payload[0] & 0x3);
    shape.tocClasses.set(cls, (shape.tocClasses.get(cls) ?? 0) + 1);
  }
  if (len > ivLength && recentIvSet.has(ivKey(payload))) shape.ownIv++;
  if (typeof ts === 'number') {
    if (shape.recentTs.includes(ts)) shape.repeatedTs++;
    shape.recentTs.push(ts);
    if (shape.recentTs.length > RECENT_TS) shape.recentTs.shift();
  }
  const anomalous = shape.notOpus + shape.repeatedTs + shape.ownIv > 0;
  const due = shape.frames === SHAPE_FIRST || (anomalous && shape.frames % SHAPE_EVERY === 0);
  if (!due) return;
  let top = -1;
  let topCount = 0;
  for (const [cls, n] of shape.tocClasses) {
    if (n > topCount) [top, topCount] = [cls, n];
  }
  self.postMessage({
    type: 'senderAudioShape',
    id: shape.id,
    frames: shape.frames,
    notOpus: shape.notOpus,
    repeatedTs: shape.repeatedTs,
    ownIv: shape.ownIv,
    lenMin: shape.lenMin,
    lenMax: shape.lenMax,
    lenAvg: Math.round(shape.lenSum / shape.frames),
    tocClass: top < 0 ? 'none' : `config${top >> 2}/code${top & 0x3}`,
    tocShare: Math.round((100 * topCount) / shape.frames),
  });
}

async function encryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController
) {
  const iv = crypto.getRandomValues(new Uint8Array(ivLength));
  rememberIv(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, callKey!, frame.data);

  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), ivLength);

  frame.data = packed.buffer;
  controller.enqueue(frame);
}

/** Decrypts one frame and forwards it; `false` when it was dropped (too short, or wrong key). */
async function decryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController
): Promise<boolean> {
  const data = new Uint8Array(frame.data);
  if (data.byteLength < ivLength) return false;

  const iv = data.slice(0, ivLength);
  const ciphertext = data.slice(ivLength);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, callKey!, ciphertext);
    if (frameTypeLabel(frame) === 'audio') {
      const clear = new Uint8Array(plaintext);
      if (!checkOpus(frame, clear, 'receiver')) await probeDoubleEncryption(clear);
    }
    frame.data = plaintext;
    controller.enqueue(frame);
    return true;
  } catch (e) {
    decryptFailures++;
    if (decryptFailures <= 3 || decryptFailures % 100 === 0) {
      const detail = String(e);
      self.postMessage({ type: 'decryptError', detail, count: decryptFailures });
    }
    return false;
  }
}
