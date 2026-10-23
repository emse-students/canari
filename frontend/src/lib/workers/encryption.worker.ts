// encryption.worker.ts - WebRTC Encoded Transform (insertable streams) for MLS-derived call keys.

import { isValidOpusPacket } from '../utils/opusPacket';
import { clearHeaderBytes, isCallVideoCodec } from '../utils/callVideoFrame';
import {
  callMediaKind,
  DECRYPT_MISMATCH_FAILURES,
  frameAad,
  type CallTransformOptions,
} from '../utils/callFrameAad';
import type { CallMediaKind } from '../utils/callE2eReport';

/** Minimal typing for RTCTransformEvent (DOM lib may omit it in worker context). */
interface TransformEventLike {
  transformer: {
    readable: ReadableStream;
    writable: WritableStream;
    options?: Partial<CallTransformOptions>;
  };
}

/**
 * One key per direction (`utils/callKeys.ts`): this device encrypts with `sendKey` and decrypts
 * with `receiveKey`. Each is imported for that ONE use, so the send key cannot open a frame.
 */
let sendKey: CryptoKey | null = null;
let receiveKey: CryptoKey | null = null;
const ivLength = 12;
let decryptFailures = 0;
/** The same failures per kind: a video key mismatch or a mangled clear header shows apart. */
const decryptFailuresBy = { audio: 0, video: 0 };
/**
 * Video frames whose metadata named a codec other than VP8 (`isCallVideoCodec`): encrypted WHOLE,
 * so the receiver cannot decode them - the call's video m-lines are meant to carry VP8 only.
 */
let videoCodecUnexpected = 0;
/**
 * Sender VIDEO frames shorter than their clear header (`encryptFrame`): not a VP8 frame an encoder
 * emits, and one that cannot be framed so the receiver splits it the same way - dropped, never sent.
 */
let videoTooShortSent = 0;
/** Frames whose transform threw (`onrtctransform`'s catch): each one was lost, never forwarded. */
let transformErrors = 0;
/** Receiver frames too short to carry an IV, dropped before any decrypt (see `decryptFrame`). */
let tooShort = 0;
/** How many of the too-short frames were EMPTY (carry nothing; counted, not named). */
let tooShortEmpty = 0;
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
 * Every frame the engine handed a transform, per side, counted BEFORE anything can drop or throw:
 * the one number that says whether the transform is in the media path at all (`report`).
 */
const framesIn: Record<string, number> = {};
/**
 * The same count keyed `<epoch>|<side>|<kind>` (`framesKey`): the epoch is the peer connection the
 * transform was made for (`CallService` passes it in the transform's options), so a rebuilt peer
 * connection is judged on ITS frames, not the dead one's, and audio and video are judged apart.
 */
const framesInBy: Record<string, number> = {};

/** The key of `framesInBy`, shared with the main thread (`utils/callE2eReport.ts` reads it). */
function framesKey(epoch: number | undefined, side: string, kind: string): string {
  return `${epoch ?? 0}|${side}|${kind}`;
}
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

/** Receives the call's two AES-GCM keys from the main thread (raw bytes, not CryptoKey). */
self.onmessage = async (
  event: MessageEvent<{ type: string; send?: ArrayBuffer; receive?: ArrayBuffer }>
) => {
  if (event.origin && event.origin !== self.location.origin) return;
  if (event.data?.type === 'report') {
    self.postMessage(workerReport((event.data as { tag?: string }).tag ?? ''));
    return;
  }
  if (event.data?.type === 'setKeys') {
    const detail = keysProblem(event.data.send, event.data.receive);
    if (detail) {
      self.postMessage({ type: 'keyError', detail });
      return;
    }
    try {
      const send = await crypto.subtle.importKey(
        'raw',
        event.data.send!,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );
      const receive = await crypto.subtle.importKey(
        'raw',
        event.data.receive!,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );
      // Both or neither: a frame never meets one call's send key and another's receive key.
      sendKey = send;
      receiveKey = receive;
      self.postMessage({ type: 'keyReady' });
    } catch (e) {
      self.postMessage({ type: 'keyError', detail: String(e) });
    }
  }
};

/**
 * Why a `setKeys` pair cannot be used, or `null`. Two EQUAL keys are refused: they would put both
 * directions back in one nonce space and let a reflected frame open - exactly what two keys exist
 * to prevent - and only a broken derivation produces them.
 */
function keysProblem(send?: ArrayBuffer, receive?: ArrayBuffer): string | null {
  if (!send || send.byteLength !== 32) return `invalid send key length ${send?.byteLength ?? 0}`;
  if (!receive || receive.byteLength !== 32) {
    return `invalid receive key length ${receive?.byteLength ?? 0}`;
  }
  const a = new Uint8Array(send);
  const b = new Uint8Array(receive);
  if (a.every((byte, i) => byte === b[i])) return 'the send and receive keys are equal';
  return null;
}

workerScope.onrtctransform = (event: Event) => {
  const transformEvent = event as unknown as TransformEventLike;
  const options = transformEvent.transformer.options;
  const side = options?.side;
  const epoch = options?.epoch;
  // The kind comes from the PAGE, which knows the track (`utils/callFrameAad.ts`): it is
  // authenticated in every frame, so a transform without one forwards nothing rather than guess.
  const mediaKind = callMediaKind(options?.kind);

  if (side !== 'sender' && side !== 'receiver') {
    self.postMessage({ type: 'warn', detail: `unknown transform side: ${String(side)}` });
  }
  if (!mediaKind) {
    self.postMessage({
      type: 'warn',
      detail: `${String(side)} transform without a media kind (${String(options?.kind)}) - every frame dropped`,
    });
  }
  // The app attaches ONE transformer per sender and ONE per receiver: the per-side count, posted
  // with the first frame's codec, makes a second audio sender transformer (a double attach) visible.
  const id = ++transformerSeq;
  const sideKey = String(side);
  transformersPerSide[sideKey] = (transformersPerSide[sideKey] ?? 0) + 1;
  const sideCount = transformersPerSide[sideKey];
  let firstFrameSeen = false;
  /** Whether this transformer already posted its `inPath` evidence (once, on its first success). */
  let inPathPosted = false;
  /**
   * EVIDENCE that this transformer is in the media path: its first frame encrypted (sender) or
   * decrypted (receiver), posted ONCE per transformer with its epoch, so a rebuilt peer connection
   * earns the screen's "end-to-end encrypted" again from its OWN transforms.
   */
  const postInPath = (kind: CallMediaKind) => {
    if (inPathPosted) return;
    inPathPosted = true;
    self.postMessage({ type: 'inPath', side: sideKey, epoch: epoch ?? 0, mediaKind: kind });
  };
  /**
   * This RECEIVER transformer's decrypt failures while it has decrypted nothing. Reaching
   * `DECRYPT_MISMATCH_FAILURES` is posted ONCE as `undecryptable`: the page decides whether it is a
   * key mismatch (no receiver of the peer connection decrypted anything) or something else.
   */
  let failedUnopened = 0;
  let opened = false;
  const shape = newSenderShape(id);

  const transform = new TransformStream({
    transform: async (frame, controller) => {
      framesIn[sideKey] = (framesIn[sideKey] ?? 0) + 1;
      if (!mediaKind) return;
      const kindKey = framesKey(epoch, sideKey, mediaKind);
      framesInBy[kindKey] = (framesInBy[kindKey] ?? 0) + 1;
      if (!sendKey || !receiveKey) {
        droppedNoKey++;
        if (droppedNoKey <= 3 || droppedNoKey % 200 === 0) {
          self.postMessage({ type: 'droppedNoKey', count: droppedNoKey });
        }
        return;
      }
      try {
        // Read once per frame and shared: each read of a throwing `getMetadata` is a log line.
        const meta =
          !firstFrameSeen || mediaKind === 'video' || (side === 'sender' && mediaKind === 'audio')
            ? frameMetadata(frame)
            : undefined;
        const mimeType = mediaKind === 'video' ? meta?.mimeType : undefined;
        if (mediaKind === 'video' && !isCallVideoCodec(mimeType))
          noteUnexpectedVideoCodec(mimeType);
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
          if (!(await encryptFrame(frame, controller, mediaKind, mimeType))) return;
          encrypted[mediaKind]++;
          postInPath(mediaKind);
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
          const outcome = await decryptFrame(frame, controller, mediaKind, mimeType);
          if (outcome === 'failed' && !opened && ++failedUnopened === DECRYPT_MISMATCH_FAILURES) {
            self.postMessage({
              type: 'undecryptable',
              epoch: epoch ?? 0,
              mediaKind,
              failures: failedUnopened,
            });
          }
          if (outcome !== 'opened') return;
          opened = true;
          decrypted[mediaKind]++;
          postInPath(mediaKind);
          if (decrypted[mediaKind] === 1 || decrypted[mediaKind] % 300 === 0) {
            self.postMessage({ type: 'decryptOk', count: decrypted[mediaKind], mediaKind });
          }
        }
      } catch (e) {
        // To the page, which writes the call log: a worker's console reaches no exported log, and a
        // frame lost here is otherwise lost without a trace. Sampled like a decrypt failure - a
        // transform that throws throws on EVERY frame (50 a second).
        transformErrors++;
        if (transformErrors <= 3 || transformErrors % 100 === 0) {
          self.postMessage({ type: 'transformError', detail: String(e), count: transformErrors });
        }
      }
    },
  });

  void transformEvent.transformer.readable
    .pipeThrough(transform)
    .pipeTo(transformEvent.transformer.writable);
};

/**
 * What this worker has seen since it started, answered on request (`{ type: 'report' }`). WHY
 * (2026-10-19): a Mi 9T logged NO worker line in five calls - no first-frame `encrypting`, no
 * `decrypting` - and nothing could say whether the messages were lost or no frame ever reached
 * the transform. A report the main thread ASKS for separates the three: no answer (the bridge),
 * zero transformers (the engine never handed the worker one), zero frames (handed, never fed).
 */
function workerReport(tag: string) {
  return {
    type: 'report',
    tag,
    transformers: { ...transformersPerSide },
    framesIn: { ...framesIn },
    framesInBy: { ...framesInBy },
    encrypted: { ...encrypted },
    decrypted: { ...decrypted },
    decryptFailures,
    decryptFailuresBy: { ...decryptFailuresBy },
    videoKeyframesIn,
    videoCodecUnexpected,
    videoTooShortSent,
    tooShort,
    tooShortEmpty,
    droppedNoKey,
    opusInvalid: { ...opusInvalid },
    doubleEncrypted,
    transformErrors,
  };
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
 * A decrypted audio payload that is not Opus: does it decrypt AGAIN with the receive key and the
 * audio additional data? If so the sender applied the transform twice, which is proof, not
 * inference - logged, never undone here.
 */
async function probeDoubleEncryption(clear: Uint8Array): Promise<void> {
  if (clear.byteLength <= ivLength || !receiveKey) return;
  try {
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: clear.slice(0, ivLength),
        additionalData: frameAad('audio', new Uint8Array(0)),
      },
      receiveKey,
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

/**
 * Encrypts one frame with the SEND key as `clear header || IV || AES-GCM(rest)`. The clear header
 * is empty for audio and the VP8 payload header for video (`clearHeaderBytes`); the additional data
 * is the frame's kind followed by that header (`frameAad`), so neither can be altered or swapped
 * unseen. Returns whether a
 * frame was ENCRYPTED: an empty video frame is passed through as it is (it carries nothing, and
 * the receiver passes it the same way), and a non-empty one shorter than its header is dropped -
 * framed whole, the receiver would read its first IV byte as a header and split it elsewhere.
 */
async function encryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController,
  mediaKind: CallMediaKind,
  mimeType: string | undefined
): Promise<boolean> {
  const data = new Uint8Array(frame.data);
  const clear = clearHeaderBytes(mediaKind, mimeType, data);
  if (mediaKind === 'video' && data.byteLength === 0) {
    controller.enqueue(frame);
    return false;
  }
  if (data.byteLength < clear) {
    videoTooShortSent++;
    if (videoTooShortSent <= 3 || videoTooShortSent % 100 === 0) {
      self.postMessage({
        type: 'warn',
        detail: `sender video frame of ${data.byteLength} byte(s) dropped: shorter than its ${clear}-byte VP8 header (${videoTooShortSent} so far)`,
      });
    }
    return false;
  }
  const header = data.subarray(0, clear);
  const iv = crypto.getRandomValues(new Uint8Array(ivLength));
  // The ring is the AUDIO double-encryption probe's window: 30 video IVs a second would flush it.
  if (mediaKind === 'audio') rememberIv(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: frameAad(mediaKind, header) },
    sendKey!,
    data.subarray(clear)
  );

  const packed = new Uint8Array(clear + iv.byteLength + ciphertext.byteLength);
  packed.set(header, 0);
  packed.set(iv, clear);
  packed.set(new Uint8Array(ciphertext), clear + ivLength);

  frame.data = packed.buffer;
  controller.enqueue(frame);
  return true;
}

/** Names a video frame of a codec this transform cannot frame (`isCallVideoCodec`), a few times. */
function noteUnexpectedVideoCodec(mimeType: string | undefined): void {
  videoCodecUnexpected++;
  if (videoCodecUnexpected <= 3 || videoCodecUnexpected % 300 === 0) {
    self.postMessage({
      type: 'videoCodecUnexpected',
      mimeType: mimeType ?? '?',
      count: videoCodecUnexpected,
    });
  }
}

/**
 * What became of one received frame: `opened` (decrypted and forwarded), `skipped` (empty or too
 * short to be one of ours - never a verdict on the key), `failed` (AES-GCM refused it).
 */
type DecryptOutcome = 'opened' | 'skipped' | 'failed';

/**
 * Decrypts one frame with the RECEIVE key (`clear header || IV || ciphertext`, see `encryptFrame`)
 * and forwards it with its header put back.
 */
async function decryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController,
  mediaKind: CallMediaKind,
  mimeType: string | undefined
): Promise<DecryptOutcome> {
  const data = new Uint8Array(frame.data);
  // An empty video frame was passed through by the sender (`encryptFrame`): passed on the same way.
  if (mediaKind === 'video' && data.byteLength === 0) {
    controller.enqueue(frame);
    return 'skipped';
  }
  // The receiver reads the SAME clear first byte the sender read, so both find the same length.
  const clear = clearHeaderBytes(mediaKind, mimeType, data);
  if (data.byteLength < clear + ivLength) {
    // Cannot be one of ours (every encrypted frame is header + IV + tag, 28 bytes at least): dropped,
    // and COUNTED - this branch was silent until 2026-10-19. An EMPTY frame carries nothing (Chrome
    // hands the receiver a few per call, measured 18-39 in the rig): it is counted in the report
    // only. A NON-empty one is something else on the wire and is named.
    tooShort++;
    if (data.byteLength === 0) {
      tooShortEmpty++;
      return 'skipped';
    }
    const nonEmpty = tooShort - tooShortEmpty;
    if (nonEmpty <= 3 || nonEmpty % 100 === 0) {
      self.postMessage({
        type: 'warn',
        detail: `receiver ${mediaKind} frame of ${data.byteLength} byte(s) dropped: shorter than its clear header and an IV (${nonEmpty} so far)`,
      });
    }
    return 'skipped';
  }

  const header = data.slice(0, clear);
  const iv = data.slice(clear, clear + ivLength);
  const ciphertext = data.slice(clear + ivLength);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: frameAad(mediaKind, header) },
      receiveKey!,
      ciphertext
    );
    if (mediaKind === 'audio') {
      const clearAudio = new Uint8Array(plaintext);
      if (!checkOpus(frame, clearAudio, 'receiver')) await probeDoubleEncryption(clearAudio);
      frame.data = plaintext;
    } else {
      const out = new Uint8Array(clear + plaintext.byteLength);
      out.set(header, 0);
      out.set(new Uint8Array(plaintext), clear);
      frame.data = out.buffer;
    }
    controller.enqueue(frame);
    return 'opened';
  } catch (e) {
    decryptFailures++;
    decryptFailuresBy[mediaKind]++;
    if (decryptFailures <= 3 || decryptFailures % 100 === 0) {
      const detail = String(e);
      self.postMessage({ type: 'decryptError', detail, count: decryptFailures, mediaKind });
    }
    return 'failed';
  }
}
