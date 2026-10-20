/**
 * One side of a measured call, in one Chrome process whose fake microphone plays a known file.
 *
 * Faithful to `CallService` where it matters for SOUND, by IMPORTING rather than copying: the
 * capture constraints and the sender parameters come from `frontend/src/lib/utils/callAudio.ts`,
 * the E2E transform is the app's own `encryption.worker.ts` (wrapped only to impair the network),
 * and the order is the app's - `addTrack`, the sender transform, the RECEIVER transform of the same
 * transceiver before any negotiation, then `configureCallAudioSenders`, then perfect-negotiation's
 * implicit `setLocalDescription()`. Playback is an `<audio>` element on the remote stream, as
 * `CallOverlay.svelte` plays it. What it leaves out is everything that does not touch a sample:
 * MLS key derivation (a fixed test key here), the relay socket (the driver carries the SDP), the
 * ring.
 */
import {
  buildCallAudioConstraints,
  configureCallAudioSenders,
} from '../../../frontend/src/lib/utils/callAudio';
import { transformAttribute } from '../../../frontend/src/lib/utils/callE2eReport';

interface Impair {
  loss?: number;
  burst?: number;
  jitterMs?: number;
  seed?: number;
}

interface RigConfig {
  /** `app` = the app's constraints; `off` = every browser voice processing step disabled. */
  processing: 'app' | 'off';
  /** The app's E2E transform on both directions. */
  e2e: boolean;
  /** Extra Opus fmtp parameters forced on the SDP this side sends (an experiment, not the app). */
  fmtp?: Record<string, string> | null;
  /** Network impairment on this side's RECEIVER. */
  impair?: Impair | null;
  /** Audio codec order for this side's transceiver (`setCodecPreferences`), e.g. RED first. */
  codecOrder?: string[];
  /** SCENARIO: send nothing at first; `addLateTrack()` later puts the audio on a NEW m-line. */
  lateTrack?: boolean;
  /**
   * SCENARIO with `lateTrack`: the late audio goes on the transceiver the OTHER side's offer created
   * (`addTrack` reuses it) instead of a fresh one - its sender got its transform in `ontrack`, as
   * `CallService.handleRemoteTrack` does since 2026-10-20.
   */
  reuseRemoteTransceiver?: boolean;
  /**
   * FAULT ROW with `reuseRemoteTransceiver`: `ontrack` attaches the RECEIVER only (the app before
   * 2026-10-20), so the reused sender was bare at its creation and Chromium short-circuited it -
   * a transform assigned at `addTrack`, even in the same task, is never fed.
   */
  bareSenderInOntrack?: boolean;
  /** FAULT ROW: this side's sender applies the app transform twice. */
  doubleEncrypt?: boolean;
  /** FAULT ROW: this side derives a DIFFERENT key (two MLS epochs - review item F5). */
  wrongKey?: boolean;
  /** FAULT ROW: this side encrypts but attaches NO receiver transform (ciphertext to the decoder). */
  noReceiverTransform?: boolean;
  /**
   * FAULT ROW: both transforms are assigned ONE TASK after `addTrack` - the app's order until
   * 2026-10-20 (an await of the worker's `keyReady` in between). Chromium short-circuits them: the
   * transformers exist and are never fed (CALL-E2E-BYPASS-MI9T).
   */
  transformOneTaskLate?: boolean;
}

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 11 + 5);

let pc: RTCPeerConnection;
let cfg: RigConfig;
let worker: Worker | null = null;
let remote: MediaStream | null = null;
let localStream: MediaStream | null = null;
let recorder: { chunks: Float32Array[]; ctx: AudioContext } | null = null;
const statsLog: unknown[] = [];
const log: string[] = [];
let impairCounts = { dropped: 0, passed: 0 };

function note(msg: string) {
  log.push(`${(performance.now() / 1000).toFixed(2)} ${msg}`);
}

function constraints(): MediaTrackConstraints {
  if (cfg.processing === 'app') return buildCallAudioConstraints();
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48_000,
  };
}

async function keyWorker(): Promise<Worker> {
  const w = new Worker('/impair.worker.js', { type: 'module' });
  await new Promise<void>((resolve, reject) => {
    w.addEventListener('message', (e: MessageEvent<{ type: string; detail?: string }>) => {
      if (e.data?.type === 'keyReady') resolve();
      if (e.data?.type === 'keyError') reject(new Error(e.data.detail));
    });
    const copy = (cfg.wrongKey ? OTHER_KEY : KEY).slice();
    w.postMessage({ type: 'setKey', payload: copy.buffer }, [copy.buffer]);
  });
  w.addEventListener('message', (e: MessageEvent<{ type: string; detail?: string }>) => {
    const t = e.data?.type;
    if (t === 'impair') impairCounts = e.data as unknown as typeof impairCounts;
    else if (
      [
        'decryptError',
        'keyError',
        'warn',
        'opusInvalid',
        'doubleEncrypted',
        'transformer',
        'senderAudioShape',
      ].includes(t)
    ) {
      note(`worker ${JSON.stringify(e.data)}`);
    }
  });
  return w;
}

function transformOptions(side: 'sender' | 'receiver') {
  return {
    side,
    passthrough: !cfg.e2e,
    doubleEncrypt: !!cfg.doubleEncrypt,
    ...(side === 'receiver' ? (cfg.impair ?? {}) : {}),
  };
}

function needsTransform(): boolean {
  return cfg.e2e || !!cfg.impair;
}

async function gathered(): Promise<string> {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve();
      });
    });
  }
  return outgoing(pc.localDescription!.sdp);
}

/** The SDP as this side SENDS it (the app munges none), with any experiment's fmtp override. */
function outgoing(sdp: string): string {
  let out = sdp;
  if (cfg.fmtp) {
    const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(out)?.[1];
    if (pt) {
      out = out.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (_m, params: string) => {
        const map = new Map(params.split(';').map((p) => p.split('=') as [string, string]));
        for (const [k, v] of Object.entries(cfg.fmtp!)) map.set(k, v);
        return `a=fmtp:${pt} ${[...map].map(([k, v]) => `${k}=${v}`).join(';')}`;
      });
    }
  }
  return out;
}

async function setup(config: RigConfig) {
  cfg = config;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints(), video: false });
  const settings = stream.getAudioTracks()[0].getSettings();
  pc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all' });
  pc.ontrack = (e) => {
    remote = e.streams[0] ?? new MediaStream([e.track]);
    // As CallService.handleRemoteTrack: a receiver without its transform gets one HERE (late).
    const late = !!worker && !e.receiver.transform && !cfg.noReceiverTransform;
    if (late)
      e.receiver.transform = new RTCRtpScriptTransform(worker!, transformOptions('receiver'));
    // As CallService.handleRemoteTrack: the SENDER of a transceiver the offer created, in the same
    // task - a bare one is short-circuited for good if `addTrack` reuses it later.
    if (late && !cfg.bareSenderInOntrack && !e.transceiver.sender.transform)
      e.transceiver.sender.transform = new RTCRtpScriptTransform(worker!, transformOptions('sender'));
    note(`ontrack ${e.track.kind}${late ? ' - receiver transform attached LATE, in ontrack' : ''}`);
  };
  pc.onconnectionstatechange = () => note(`connectionState=${pc.connectionState}`);
  if (needsTransform()) worker = await keyWorker();
  localStream = stream;
  for (const track of cfg.lateTrack ? [] : stream.getTracks()) {
    const sender = pc.addTrack(track, stream);
    if (worker && cfg.transformOneTaskLate) await new Promise((r) => setTimeout(r, 0));
    if (worker) {
      sender.transform = new RTCRtpScriptTransform(worker, transformOptions('sender'));
      const t = pc.getTransceivers().find((x) => x.sender === sender)!;
      if (!cfg.noReceiverTransform)
        t.receiver.transform = new RTCRtpScriptTransform(worker, transformOptions('receiver'));
    }
  }
  if (cfg.codecOrder) {
    const caps = RTCRtpReceiver.getCapabilities('audio')?.codecs ?? [];
    const rank = (c: RTCRtpCodec) => {
      const i = cfg.codecOrder!.indexOf(c.mimeType.toLowerCase());
      return i < 0 ? 99 : i;
    };
    const ordered = [...caps].sort((a, b) => rank(a) - rank(b));
    for (const t of pc.getTransceivers()) t.setCodecPreferences(ordered);
    note(`codec order ${ordered.map((c) => c.mimeType).join(',')}`);
  }
  await configureCallAudioSenders(pc, false);
  return { settings, constraints: constraints() };
}

/**
 * SCENARIO: this side's audio goes out on a NEW m-line, added after the first negotiation - what
 * the other side sees when an engine does not reuse the transceiver `addTrack` made before the
 * offer arrived. Returns the renegotiation offer.
 */
async function addLateTrack() {
  const track = localStream!.getAudioTracks()[0];
  if (cfg.reuseRemoteTransceiver) {
    const sender = pc.addTrack(track, localStream!);
    const reused = pc.getTransceivers().length === 1;
    // In the same task as `addTrack`: what the app did, and still not enough on a bare sender.
    if (worker && !sender.transform)
      sender.transform = new RTCRtpScriptTransform(worker, transformOptions('sender'));
    note(`late track on ${reused ? 'the transceiver the offer created' : 'a NEW transceiver'}`);
    await pc.setLocalDescription();
    return gathered();
  }
  const t = pc.addTransceiver(track, { direction: 'sendrecv', streams: [localStream!] });
  if (worker) {
    t.sender.transform = new RTCRtpScriptTransform(worker, transformOptions('sender'));
    t.receiver.transform = new RTCRtpScriptTransform(worker, transformOptions('receiver'));
  }
  await pc.setLocalDescription();
  return gathered();
}

async function offer() {
  await pc.setLocalDescription();
  return gathered();
}

async function answer(sdp: string) {
  await pc.setRemoteDescription({ type: 'offer', sdp });
  await pc.setLocalDescription();
  return gathered();
}

async function accept(sdp: string) {
  await pc.setRemoteDescription({ type: 'answer', sdp });
}

async function connected() {
  if (pc.connectionState === 'connected') return;
  await new Promise<void>((resolve, reject) => {
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') resolve();
      if (pc.connectionState === 'failed') reject(new Error('connection failed'));
    });
  });
}

const WORKLET = `
class Rec extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('rec', Rec);
`;

/** Starts playing the remote stream (as the app does) and recording it, sample for sample. */
async function record() {
  if (!remote) throw new Error('no remote stream');
  const el = document.createElement('audio');
  el.autoplay = true;
  el.srcObject = remote;
  document.body.append(el);
  await el.play().catch((e: unknown) => note(`audio.play failed: ${String(e)}`));
  const ctx = new AudioContext({ sampleRate: 48_000 });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const src = ctx.createMediaStreamSource(remote);
  const node = new AudioWorkletNode(ctx, 'rec', { channelCount: 1, channelCountMode: 'explicit' });
  const chunks: Float32Array[] = [];
  node.port.onmessage = (e: MessageEvent<Float32Array>) => chunks.push(e.data);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  await ctx.resume();
  recorder = { chunks, ctx };
  note(`recording at ${ctx.sampleRate} Hz`);
}

/** One flat stats sample: what the receiver and the sender say about the audio, once a second. */
async function sampleStats() {
  const r = await pc.getStats();
  const s: Record<string, unknown> = { t: performance.now() / 1000, impair: { ...impairCounts } };
  const byId = new Map<string, Record<string, unknown>>();
  r.forEach((v) => byId.set(v.id, v));
  r.forEach((v) => {
    if (v.type === 'inbound-rtp' && v.kind === 'audio') {
      Object.assign(s, {
        in_packetsReceived: v.packetsReceived,
        in_packetsLost: v.packetsLost,
        in_jitter: v.jitter,
        in_concealedSamples: v.concealedSamples,
        in_silentConcealedSamples: v.silentConcealedSamples,
        in_concealmentEvents: v.concealmentEvents,
        in_totalSamplesReceived: v.totalSamplesReceived,
        in_inserted: v.insertedSamplesForDeceleration,
        in_removed: v.removedSamplesForAcceleration,
        in_audioLevel: v.audioLevel,
        in_jbDelay: v.jitterBufferDelay,
        in_jbEmitted: v.jitterBufferEmittedCount,
        in_jbTarget: v.jitterBufferTargetDelay,
        in_fecPacketsReceived: v.fecPacketsReceived,
        in_bytes: v.bytesReceived,
        in_codec: (byId.get(v.codecId as string) ?? {}).mimeType,
        in_fmtp: (byId.get(v.codecId as string) ?? {}).sdpFmtpLine,
        in_channels: (byId.get(v.codecId as string) ?? {}).channels,
      });
    }
    if (v.type === 'outbound-rtp' && v.kind === 'audio') {
      Object.assign(s, {
        out_bytes: v.bytesSent,
        out_packets: v.packetsSent,
        out_targetBitrate: v.targetBitrate,
        out_codec: (byId.get(v.codecId as string) ?? {}).mimeType,
        out_fmtp: (byId.get(v.codecId as string) ?? {}).sdpFmtpLine,
      });
    }
    if (v.type === 'media-source' && v.kind === 'audio') {
      Object.assign(s, { src_audioLevel: v.audioLevel, src_erl: v.echoReturnLoss });
    }
    if (v.type === 'candidate-pair' && v.nominated && v.state === 'succeeded') {
      const l = byId.get(v.localCandidateId as string) ?? {};
      const rm = byId.get(v.remoteCandidateId as string) ?? {};
      Object.assign(s, {
        pair: `${String(l.candidateType)}/${String(l.protocol)}->${String(rm.candidateType)}/${String(rm.protocol)}`,
        rttMs: typeof v.currentRoundTripTime === 'number' ? v.currentRoundTripTime * 1000 : null,
      });
    }
  });
  statsLog.push(s);
}

let statsTimer = 0;
function startStats() {
  statsTimer = window.setInterval(() => void sampleStats(), 1000);
}

/** How long `finish` waits for one answer of the worker before the row fails on it. */
const WORKER_ANSWER_MS = 5_000;

/**
 * Posts `request` and resolves with the worker's first message of type `answer`. The listener is
 * removed either way, and no answer within `WORKER_ANSWER_MS` REJECTS: a row must fail on a worker
 * that does not answer, never hang on it.
 */
function askWorker(
  w: Worker,
  request: Record<string, unknown>,
  answer: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<{ type?: string }>) => {
      if (e.data?.type !== answer) return;
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      resolve(e.data as Record<string, unknown>);
    };
    const timer = setTimeout(() => {
      w.removeEventListener('message', onMessage);
      reject(
        new Error(`the worker did not answer ${String(request.type)} in ${WORKER_ANSWER_MS} ms`)
      );
    }, WORKER_ANSWER_MS);
    w.addEventListener('message', onMessage);
    w.postMessage(request);
  });
}

/** Stops everything and returns the recording (base64 Float32 LE) and the stats series. */
async function finish() {
  window.clearInterval(statsTimer);
  await sampleStats();
  const senderParams = pc
    .getSenders()
    .filter((s) => s.track?.kind === 'audio')
    .map((s) => s.getParameters().encodings);
  let b64 = '';
  let sampleRate = 0;
  if (recorder) {
    sampleRate = recorder.ctx.sampleRate;
    const total = recorder.chunks.reduce((a, c) => a + c.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const c of recorder.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const bytes = new Uint8Array(all.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    b64 = btoa(bin);
    await recorder.ctx.close();
  }
  let tap: { sent: string[]; received: string[] } | null = null;
  let report: Record<string, unknown> | null = null;
  if (worker) {
    // The app worker's OWN report, asked exactly as CallService asks it: frames per side. It is
    // returned in the result, not noted in the log as well.
    report = await askWorker(worker, { type: 'report', tag: 'rig' }, 'report');
    tap = (await askWorker(worker, { type: 'dumpTap' }, 'tap')) as unknown as typeof tap;
  }
  pc.close();
  worker?.terminate();
  const engine = {
    ua: navigator.userAgent,
    senderAttr: transformAttribute(RTCRtpSender.prototype),
    receiverAttr: transformAttribute(RTCRtpReceiver.prototype),
  };
  return { b64, sampleRate, stats: statsLog, senderParams, log, tap, report, engine };
}

Object.assign(window, {
  rig: {
    setup,
    addLateTrack,
    offer,
    answer,
    accept,
    connected,
    record,
    startStats,
    finish,
    outgoing,
  },
});
document.title = 'rig-ready';
