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
import {
  applyCallVideoRung,
  callVideoConstraints,
  preferVp8,
} from '../../../frontend/src/lib/utils/callVideo';
import {
  CALL_VIDEO_LADDER,
  CallVideoQualityLoop,
} from '../../../frontend/src/lib/utils/callVideoQuality';

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
  /** VIDEO: the fake camera from the start, on its own `addTrack` transceiver, VP8 required. */
  video?: boolean;
  /**
   * VIDEO, after the first negotiation: `fresh` = the camera on a NEW transceiver with both
   * transforms in its task (`CallService.toggleVideo`); `reuse-bare` = FAULT, `addTrack` reuses the
   * video transceiver the other side's offer created, whose sender `ontrack` left bare.
   */
  lateCamera?: 'fresh' | 'reuse-bare';
  /** EXPERIMENT: the video m-lines held to H.264 instead of VP8 (the app's worker unchanged). */
  videoCodec?: 'vp8' | 'h264';
  /** EXPERIMENT: video frames encrypted WHOLE, VP8 header included (the worker before 2026-10-20). */
  wholeFrameVideo?: boolean;
  /**
   * EXPERIMENT: hold the camera sender on this rung of `CALL_VIDEO_LADDER` (0 = 720p) instead of
   * running the app's quality ladder - the encode cost of each rung, measured apart.
   */
  videoRung?: number;
}

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 11 + 5);

let pc: RTCPeerConnection;
let cfg: RigConfig;
let worker: Worker | null = null;
let remote: MediaStream | null = null;
let localStream: MediaStream | null = null;
/** The camera's transceiver on this side (from the start, or added late). */
let cameraTransceiver: RTCRtpTransceiver | null = null;
/** The remote video track and the element rendering it, as the call screen renders it. */
let remoteVideoTrack: MediaStreamTrack | null = null;
let remoteVideoEl: HTMLVideoElement | null = null;
/** Mute/unmute events of the remote video track, in order. */
const remoteVideoEvents: string[] = [];
let recorder: { chunks: Float32Array[]; ctx: AudioContext } | null = null;
const statsLog: unknown[] = [];
const log: string[] = [];
let impairCounts = { dropped: 0, passed: 0 };
/**
 * The camera sender's quality ladder: the app's own `CallVideoQualityLoop`, the loop `CallService`
 * runs (sample, step, apply), so the rig measures the app's loop and not a copy of it.
 */
let ladder: CallVideoQualityLoop | null = null;

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

function transformOptions(side: 'sender' | 'receiver', kind: 'audio' | 'video' = 'audio') {
  return {
    side,
    kind,
    wholeFrameVideo: !!cfg.wholeFrameVideo,
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
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: constraints(),
    video: cfg.video ? callVideoConstraints('user') : false,
  });
  const settings = stream.getAudioTracks()[0].getSettings();
  pc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all' });
  pc.ontrack = (e) => {
    const kind = e.track.kind as 'audio' | 'video';
    if (kind === 'audio') remote = e.streams[0] ?? new MediaStream([e.track]);
    // As CallService.handleRemoteTrack: a receiver without its transform gets one HERE (late).
    const late = !!worker && !e.receiver.transform && !cfg.noReceiverTransform;
    if (late)
      e.receiver.transform = new RTCRtpScriptTransform(worker!, transformOptions('receiver', kind));
    // As CallService.handleRemoteTrack: the SENDER of a transceiver the offer created, in the same
    // task - a bare one is short-circuited for good if `addTrack` reuses it later.
    if (late && !cfg.bareSenderInOntrack && !e.transceiver.sender.transform)
      e.transceiver.sender.transform = new RTCRtpScriptTransform(
        worker!,
        transformOptions('sender', kind)
      );
    if (kind === 'video') {
      requireVideoCodec(e.transceiver);
      watchRemoteVideo(e.track);
    }
    note(`ontrack ${e.track.kind}${late ? ' - receiver transform attached LATE, in ontrack' : ''}`);
  };
  pc.onconnectionstatechange = () => note(`connectionState=${pc.connectionState}`);
  if (needsTransform()) worker = await keyWorker();
  localStream = stream;
  for (const track of cfg.lateTrack ? stream.getVideoTracks() : stream.getTracks()) {
    const sender = pc.addTrack(track, stream);
    if (worker && cfg.transformOneTaskLate) await new Promise((r) => setTimeout(r, 0));
    const t = pc.getTransceivers().find((x) => x.sender === sender)!;
    const kind = track.kind as 'audio' | 'video';
    if (worker) {
      sender.transform = new RTCRtpScriptTransform(worker, transformOptions('sender', kind));
      if (!cfg.noReceiverTransform)
        t.receiver.transform = new RTCRtpScriptTransform(
          worker,
          transformOptions('receiver', kind)
        );
    }
    if (kind === 'video') {
      cameraTransceiver = t;
      requireVideoCodec(t);
      startCameraQuality(sender);
    }
  }
  if (cfg.codecOrder) {
    const caps = RTCRtpReceiver.getCapabilities('audio')?.codecs ?? [];
    const rank = (c: RTCRtpCodec) => {
      const i = cfg.codecOrder!.indexOf(c.mimeType.toLowerCase());
      return i < 0 ? 99 : i;
    };
    const ordered = [...caps].sort((a, b) => rank(a) - rank(b));
    for (const t of pc.getTransceivers())
      if ((t.sender.track ?? t.receiver.track)?.kind === 'audio') t.setCodecPreferences(ordered);
    note(`codec order ${ordered.map((c) => c.mimeType).join(',')}`);
  }
  await configureCallAudioSenders(pc, false, note);
  return { settings, constraints: constraints() };
}

/**
 * The video codec a transceiver is held to: VP8 through the app's own `preferVp8`, or H.264 for the
 * experiment row (the app's worker then encrypts it whole and says so).
 */
function requireVideoCodec(t: RTCRtpTransceiver) {
  if (cfg.videoCodec !== 'h264') {
    if (!preferVp8(t, note)) throw new Error('VP8 cannot be required');
    return;
  }
  const caps = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
  const h264 = caps.filter((c) => /video\/(h264|rtx)/i.test(c.mimeType));
  t.setCodecPreferences(h264);
  note(`video held to ${h264.filter((c) => /h264/i.test(c.mimeType)).length} H.264 profile(s)`);
}

/** Renders the remote video as the call screen does, and records its mute/unmute events. */
function watchRemoteVideo(track: MediaStreamTrack) {
  remoteVideoTrack = track;
  track.onmute = () => remoteVideoEvents.push('mute');
  track.onunmute = () => remoteVideoEvents.push('unmute');
  if (!remoteVideoEl) {
    remoteVideoEl = document.createElement('video');
    remoteVideoEl.muted = true;
    remoteVideoEl.playsInline = true;
    remoteVideoEl.autoplay = true;
    document.body.append(remoteVideoEl);
  }
  remoteVideoEl.srcObject = new MediaStream([track]);
  void remoteVideoEl.play().catch((e: unknown) => note(`remote video play failed: ${String(e)}`));
}

/**
 * VIDEO SCENARIO: the camera goes on after the first negotiation. `fresh` is the app's
 * `toggleVideo` (a new transceiver, both transforms in its task); `reuse-bare` is the FAULT the app
 * avoided on 2026-10-20 (`addTrack` reusing the peer's offer-created transceiver, its sender bare).
 * Returns the renegotiation offer.
 */
async function addLateCamera() {
  const cam = await navigator.mediaDevices.getUserMedia({ video: callVideoConstraints('user') });
  const track = cam.getVideoTracks()[0];
  if (cfg.lateCamera === 'reuse-bare') {
    const sender = pc.addTrack(track, cam);
    const t = pc.getTransceivers().find((x) => x.sender === sender)!;
    // In the same task as `addTrack`: what the app did, and not enough on a sender left bare.
    if (worker && !sender.transform)
      sender.transform = new RTCRtpScriptTransform(worker, transformOptions('sender', 'video'));
    note(`late camera on transceiver mid=${t.mid} (${t.mid === null ? 'NEW' : 'REUSED'})`);
    cameraTransceiver = t;
  } else {
    const t = pc.addTransceiver(track, { direction: 'sendrecv', streams: [cam] });
    if (worker) {
      t.sender.transform = new RTCRtpScriptTransform(worker, transformOptions('sender', 'video'));
      t.receiver.transform = new RTCRtpScriptTransform(
        worker,
        transformOptions('receiver', 'video')
      );
    }
    requireVideoCodec(t);
    cameraTransceiver = t;
  }
  startCameraQuality(cameraTransceiver.sender);
  await pc.setLocalDescription();
  return gathered();
}

/**
 * The camera sender's quality: a fixed rung for the `videoRung` experiment, else the app's ladder
 * from its start rung, sampled every `CALL_VIDEO_QUALITY_SAMPLE_MS` until `finish`.
 */
function startCameraQuality(sender: RTCRtpSender) {
  if (cfg.videoRung !== undefined) {
    void applyCallVideoRung(sender, CALL_VIDEO_LADDER[cfg.videoRung], note);
    return;
  }
  ladder?.stop();
  ladder = new CallVideoQualityLoop({
    pc,
    sender,
    log: note,
    onReduced: (reduced) => note(`video send reduced=${reduced}`),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
  });
  ladder.start();
}

/** VIDEO: a camera switch - a NEW capture handed to the SAME sender (`replaceTrack`), no negotiation. */
async function switchCamera() {
  const sender = cameraTransceiver!.sender;
  sender.track?.stop();
  const cam = await navigator.mediaDevices.getUserMedia({ video: callVideoConstraints('user') });
  await sender.replaceTrack(cam.getVideoTracks()[0]);
  note('camera switched (replaceTrack on the same sender)');
}

/** VIDEO: the camera OFF as the app does it - capture stopped, sender emptied, direction recvonly. */
async function cameraOff() {
  const t = cameraTransceiver!;
  t.sender.track?.stop();
  await t.sender.replaceTrack(null);
  t.direction = 'recvonly';
  note('camera off (replaceTrack(null), recvonly)');
  await pc.setLocalDescription();
  return gathered();
}

/** VIDEO: the camera back ON - a new capture on the same sender, direction sendrecv again. */
async function cameraOn() {
  const t = cameraTransceiver!;
  const cam = await navigator.mediaDevices.getUserMedia({ video: callVideoConstraints('user') });
  await t.sender.replaceTrack(cam.getVideoTracks()[0]);
  t.direction = 'sendrecv';
  ladder?.resume();
  note('camera on (replaceTrack(track), sendrecv)');
  await pc.setLocalDescription();
  return gathered();
}

/**
 * Both pictures - this side's camera and the remote video - read WHILE both peers still send:
 * the driver asks both pages before either finishes (a closed peer leaves a frozen remote).
 */
async function pictures() {
  return {
    local: await pictureOf(cameraTransceiver?.sender.track),
    remote: await pictureOf(remoteVideoTrack),
  };
}

/** The app worker's report mid-call (frames so far), asked as `finish` asks it. */
async function report() {
  return worker ? askWorker(worker, { type: 'report', tag: 'mid' }, 'report') : null;
}

/** What the receiver knows of the remote video track right now. */
function remoteVideoState() {
  return {
    present: !!remoteVideoTrack,
    muted: remoteVideoTrack?.muted ?? null,
    readyState: remoteVideoTrack?.readyState ?? null,
    events: [...remoteVideoEvents],
  };
}

/**
 * The mean colour and the luma spread of a video track, read from a 32x24 canvas: enough to tell
 * the fake camera's picture from black, a frozen grey or decoded garbage, compared across the two
 * processes (the remote picture against the sender's own capture).
 */
async function pictureOf(track: MediaStreamTrack | null | undefined) {
  if (!track || track.readyState !== 'live') return null;
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.autoplay = true;
  document.body.append(el);
  el.srcObject = new MediaStream([track]);
  // Bounded: a `play()` on a stream that never yields a frame never settles.
  await Promise.race([
    el.play().catch((e: unknown) => note(`picture play failed: ${String(e)}`)),
    new Promise((r) => setTimeout(r, 2_000)),
  ]);
  await new Promise((r) => setTimeout(r, 300));
  if (!el.videoWidth) {
    el.remove();
    note(`picture of ${track.kind} track ${track.id.slice(0, 8)}: no frame`);
    return null;
  }
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 24;
  const g = c.getContext('2d')!;
  g.drawImage(el, 0, 0, 32, 24);
  const px = g.getImageData(0, 0, 32, 24).data;
  const sum = [0, 0, 0];
  const lumas: number[] = [];
  for (let i = 0; i < px.length; i += 4) {
    sum[0] += px[i];
    sum[1] += px[i + 1];
    sum[2] += px[i + 2];
    lumas.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
  }
  const n = px.length / 4;
  const mean = lumas.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(lumas.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
  const size = { w: el.videoWidth, h: el.videoHeight };
  el.srcObject = null;
  el.remove();
  return { ...size, rgb: sum.map((x) => Math.round(x / n)), lumaSd: Math.round(sd * 10) / 10 };
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
    if (v.type === 'inbound-rtp' && v.kind === 'video') {
      Object.assign(s, {
        vin_packetsReceived: v.packetsReceived,
        vin_framesDecoded: v.framesDecoded,
        vin_framesDropped: v.framesDropped,
        vin_keyFramesDecoded: v.keyFramesDecoded,
        vin_freezeCount: v.freezeCount,
        vin_totalFreezesDuration: v.totalFreezesDuration,
        vin_pliCount: v.pliCount,
        vin_nackCount: v.nackCount,
        vin_fps: v.framesPerSecond,
        vin_w: v.frameWidth,
        vin_h: v.frameHeight,
        vin_codec: (byId.get(v.codecId as string) ?? {}).mimeType,
        vin_decoder: v.decoderImplementation,
        vin_bytes: v.bytesReceived,
      });
    }
    if (v.type === 'outbound-rtp' && v.kind === 'video') {
      Object.assign(s, {
        vout_packetsSent: v.packetsSent,
        vout_framesEncoded: v.framesEncoded,
        vout_keyFramesEncoded: v.keyFramesEncoded,
        vout_fps: v.framesPerSecond,
        vout_w: v.frameWidth,
        vout_h: v.frameHeight,
        vout_limit: v.qualityLimitationReason,
        vout_totalEncodeTime: v.totalEncodeTime,
        vout_encoder: v.encoderImplementation,
        vout_targetBitrate: v.targetBitrate,
        vout_codec: (byId.get(v.codecId as string) ?? {}).mimeType,
        vout_bytes: v.bytesSent,
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
        availOut: v.availableOutgoingBitrate,
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
  const ladderOut = ladder
    ? {
        rung: ladder.rung === null ? 'none' : CALL_VIDEO_LADDER[ladder.rung].name,
        changes: ladder.changes.map((c) => ({
          from: CALL_VIDEO_LADDER[c.from].name,
          to: CALL_VIDEO_LADDER[c.to].name,
        })),
      }
    : cfg.videoRung !== undefined
      ? { rung: CALL_VIDEO_LADDER[cfg.videoRung].name, changes: [] }
      : null;
  ladder?.stop();
  ladder = null;
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
  const remoteVideo = remoteVideoState();
  pc.close();
  worker?.terminate();
  const engine = {
    ua: navigator.userAgent,
    senderAttr: transformAttribute(RTCRtpSender.prototype),
    receiverAttr: transformAttribute(RTCRtpReceiver.prototype),
  };
  return {
    b64,
    sampleRate,
    stats: statsLog,
    senderParams,
    log,
    tap,
    report,
    engine,
    remoteVideo,
    ladder: ladderOut,
  };
}

Object.assign(window, {
  rig: {
    setup,
    addLateTrack,
    addLateCamera,
    switchCamera,
    cameraOff,
    cameraOn,
    remoteVideoState,
    report,
    pictures,
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
