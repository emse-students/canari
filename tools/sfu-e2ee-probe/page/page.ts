/**
 * One end of the Q4 probe (`../probe.mjs`), in one headless Chrome: the PUBLISHER pushes its fake
 * microphone (and camera) to a Cloudflare Realtime session, the SUBSCRIBER pulls those tracks into a
 * second session. The page never sees the Cloudflare app secret: the driver calls the API and hands
 * the page only SDP.
 *
 * What is the app's, IMPORTED rather than copied: the E2E transform (`encryption.worker.ts`, behind
 * the digest tap of `probe-worker.ts`), the capture constraints and sender parameters
 * (`utils/callAudio.ts`), the VP8 hold (`utils/callVideo.ts`) and the codec name the worker frames
 * on, and the ORDER the durable rule requires - each transform assigned in the task that created its
 * sender, and in `ontrack` for a transceiver `setRemoteDescription` created
 * (docs/wiki/durable-rules.md, "Calls, and their record").
 *
 * What is a stand-in: the keys (random bytes from the driver, one per direction as `setKeys` takes
 * them, not an MLS export). The keying is not what Q4 asks; the frame format on the wire is.
 *
 * The page proves nothing itself: it reports, and the driver decides (`../lib.mjs`).
 */
import {
  buildCallAudioConstraints,
  configureCallAudioSenders,
} from '../../../frontend/src/lib/utils/callAudio';
import { preferVp8 } from '../../../frontend/src/lib/utils/callVideo';
import { CALL_VIDEO_MIME_TYPE } from '../../../frontend/src/lib/utils/callVideoFrame';

type Kind = 'audio' | 'video';

interface ProbeConfig {
  role: 'publisher' | 'subscriber';
  /** Hex of the 32-byte key this page encrypts with, and the one it decrypts with. */
  sendKey: string;
  receiveKey: string;
  /** Whether the publisher also sends its fake camera, held to VP8. */
  video: boolean;
}

/** One pushed track, as Cloudflare's `tracks/new` takes it. */
interface PushedTrack {
  mid: string;
  trackName: string;
  kind: Kind;
}

const log: string[] = [];
let cfg: ProbeConfig;
let pc: RTCPeerConnection | null = null;
let worker: Worker | null = null;
let fault: string | null = null;
let lastReport: Record<string, unknown> | null = null;
let workerDead: Promise<void> = new Promise(() => {});
/** The codec the subscriber held each pulled video transceiver to, per mid. */
const heldVideo = new Map<string, string | undefined>();

function note(msg: string) {
  log.push(`${(performance.now() / 1000).toFixed(2)} ${msg}`);
}

function setFault(why: string) {
  note(`FAULT ${why}`);
  fault ??= why;
}

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));

/** The probe worker, keyed as `CallService.ensureWorkerKeyReady` keys the app's, BEFORE any track. */
async function keyWorker(): Promise<Worker> {
  const w = new Worker('/probe-worker.js', { type: 'module' });
  workerDead = new Promise<void>((resolve) => {
    w.addEventListener('error', (e: ErrorEvent) => {
      setFault(`the encryption worker failed: ${e.message || 'it did not load'}`);
      resolve();
    });
    w.addEventListener('messageerror', () => {
      setFault('the encryption worker sent a message that could not be deserialised');
      resolve();
    });
  });
  w.addEventListener('message', (e: MessageEvent<{ type?: string; detail?: string }>) => {
    const t = e.data?.type;
    if (t === 'report') lastReport = e.data as Record<string, unknown>;
    else if (t === 'probeFault') setFault(String(e.data.detail));
    else if (
      [
        'decryptError',
        'keyError',
        'warn',
        'transformError',
        'undecryptable',
        'transformer',
      ].includes(t ?? '')
    )
      note(`worker ${JSON.stringify(e.data)}`);
  });
  const keyed = new Promise<void>((resolve, reject) => {
    w.addEventListener('message', (e: MessageEvent<{ type?: string; detail?: string }>) => {
      if (e.data?.type === 'keyReady') resolve();
      if (e.data?.type === 'keyError') reject(new Error(e.data.detail));
    });
    const send = fromHex(cfg.sendKey).buffer;
    const receive = fromHex(cfg.receiveKey).buffer;
    w.postMessage({ type: 'setKeys', send, receive }, [send, receive]);
  });
  await Promise.race([
    keyed,
    workerDead.then(() => {
      throw new Error(fault ?? 'the encryption worker died');
    }),
  ]);
  return w;
}

function transform(side: 'sender' | 'receiver', kind: Kind, videoCodec?: string) {
  return new RTCRtpScriptTransform(worker!, { side, kind, epoch: 1, videoCodec });
}

/** Keys the worker and builds the one peer connection this page holds to Cloudflare. */
async function init(config: ProbeConfig) {
  cfg = config;
  worker = await keyWorker();
  // Cloudflare's SFU is ICE-lite and lists its own candidates in its SDP; STUN gives this side a
  // server-reflexive candidate, as Cloudflare's own examples configure it.
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    bundlePolicy: 'max-bundle',
  });
  const peer = pc;
  peer.onconnectionstatechange = () => {
    note(`connectionState=${peer.connectionState}`);
    if (peer.connectionState === 'failed') setFault('the peer connection to Cloudflare FAILED');
  };
  peer.ontrack = (e) => {
    const kind = e.track.kind as Kind;
    // As CallService.handleRemoteTrack: a transceiver the remote offer created is armed HERE, in
    // the task that created it, and its video is held to VP8 before the answer is made.
    let videoCodec: string | undefined;
    if (kind === 'video')
      videoCodec = preferVp8(e.transceiver, note) ? CALL_VIDEO_MIME_TYPE : undefined;
    if (!e.receiver.transform) e.receiver.transform = transform('receiver', kind, videoCodec);
    heldVideo.set(String(e.transceiver.mid), videoCodec);
    note(`ontrack ${kind} mid=${e.transceiver.mid} codec=${videoCodec ?? '-'}`);
  };
}

/**
 * PUBLISHER: captures, adds one send-only transceiver per track with its sender transform in the
 * same task, and returns the local offer and the tracks Cloudflare is to take.
 */
async function publishOffer(): Promise<{ sdp: string; tracks: PushedTrack[] }> {
  const peer = pc!;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: buildCallAudioConstraints(),
    video: cfg.video ? { width: 640, height: 480, frameRate: 30 } : false,
  });
  const added: { t: RTCRtpTransceiver; kind: Kind }[] = [];
  for (const track of stream.getTracks()) {
    const kind = track.kind as Kind;
    const t = peer.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    let videoCodec: string | undefined;
    if (kind === 'video') {
      if (!preferVp8(t, note)) {
        setFault('this Chrome cannot hold the video transceiver to VP8');
        throw new Error(fault!);
      }
      videoCodec = CALL_VIDEO_MIME_TYPE;
    }
    // In the task that created the sender: one task later, Chromium short-circuits it for good
    // (CALL-E2E-BYPASS-MI9T).
    t.sender.transform = transform('sender', kind, videoCodec);
    added.push({ t, kind });
  }
  await configureCallAudioSenders(peer, false, note);
  await peer.setLocalDescription(await peer.createOffer());
  return {
    sdp: peer.localDescription!.sdp,
    tracks: added.map(({ t, kind }) => ({ mid: String(t.mid), trackName: `${kind}-0`, kind })),
  };
}

async function applyAnswer(sdp: string) {
  await pc!.setRemoteDescription({ type: 'answer', sdp });
}

/** SUBSCRIBER: takes Cloudflare's offer for the pulled tracks and returns this side's answer. */
async function answerOffer(sdp: string): Promise<string> {
  const peer = pc!;
  await peer.setRemoteDescription({ type: 'offer', sdp });
  await peer.setLocalDescription(await peer.createAnswer());
  return peer.localDescription!.sdp;
}

/** The worker's report, the RTP counters per kind, the negotiated codecs and the selected pair. */
async function state() {
  const peer = pc;
  const answered = new Promise<void>((resolve) => {
    const onReport = (e: MessageEvent<{ type?: string }>) => {
      if (e.data?.type !== 'report') return;
      worker?.removeEventListener('message', onReport);
      resolve();
    };
    worker?.addEventListener('message', onReport);
  });
  worker?.postMessage({ type: 'report', tag: 'q4' });
  const inbound: Record<string, Record<string, unknown>> = {};
  const outbound: Record<string, Record<string, unknown>> = {};
  let pair: Record<string, unknown> | null = null;
  if (peer) {
    const stats = await peer.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    stats.forEach((s: Record<string, unknown>) => byId.set(String(s.id), s));
    const codecOf = (s: Record<string, unknown>) =>
      (byId.get(String(s.codecId))?.mimeType as string | undefined) ?? null;
    for (const s of byId.values()) {
      const kind = String(s.kind);
      if (s.type === 'inbound-rtp') {
        inbound[kind] = {
          packetsReceived: s.packetsReceived,
          bytesReceived: s.bytesReceived,
          packetsLost: s.packetsLost,
          framesDecoded: s.framesDecoded ?? null,
          codec: codecOf(s),
        };
      }
      if (s.type === 'outbound-rtp') {
        outbound[kind] = {
          packetsSent: s.packetsSent,
          bytesSent: s.bytesSent,
          framesEncoded: s.framesEncoded ?? null,
          codec: codecOf(s),
        };
      }
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const p = byId.get(String(s.selectedCandidatePairId));
        const local = p && byId.get(String(p.localCandidateId));
        const remote = p && byId.get(String(p.remoteCandidateId));
        pair = {
          local: local?.candidateType ?? null,
          protocol: local?.protocol ?? null,
          remote: remote?.candidateType ?? null,
        };
      }
    }
  }
  await Promise.race([answered, workerDead]);
  return {
    fault,
    connectionState: peer?.connectionState ?? null,
    report: lastReport,
    inbound,
    outbound,
    pair,
    heldVideo: Object.fromEntries(heldVideo),
  };
}

/** The tap's digests: what this page's transforms wrote (sent) and were handed (received). */
async function digests() {
  const got = new Promise<unknown>((resolve) => {
    const on = (e: MessageEvent<{ type?: string; digests?: unknown }>) => {
      if (e.data?.type !== 'probeDigests') return;
      worker?.removeEventListener('message', on);
      resolve(e.data.digests);
    };
    worker?.addEventListener('message', on);
  });
  worker?.postMessage({ type: 'probeDigests' });
  return Promise.race([got, workerDead.then(() => null)]);
}

function close() {
  pc?.close();
}

Object.assign(window, {
  probe: { init, publishOffer, applyAnswer, answerOffer, state, digests, close, log: () => log },
});
document.title = 'probe-ready';
