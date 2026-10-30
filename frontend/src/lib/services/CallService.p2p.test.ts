// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import {
  CallService,
  CALL_E2E_PATH_RECHECKS,
  CALL_ICE_RESTART_ATTEMPTS,
  CALL_ICE_TRANSPORT_POLICY,
  CALL_REPORT_INTERVAL_MS,
  CALL_SIGNALLING_RESUME_ATTEMPTS,
  CALL_SIGNALLING_RESUME_MAX_DELAY_MS,
  CALL_SIGNALLING_RESUME_TIMEOUT_MS,
} from './CallService';
import { canari } from '$lib/proto/canari.js';
import { decodeAppMessage } from '$lib/proto/codec';
import { cappedReconnectDelayMs } from '$lib/utils/reconnectBackoff';
import { CallE2eUnsupportedError } from '$lib/utils/callFailure';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../test/flush';

/**
 * The client half of a PEER-TO-PEER 1:1 call (lot 1 of the revival, 2026-10-17), driven through
 * fakes of the three browser objects it talks to: the signalling WebSocket, the peer connection and
 * the E2E worker. The server half - pairing, roles, verbatim relay - is
 * `apps/call-service/tests/p2p_signalling.rs`; this file proves the client speaks that protocol.
 *
 * What it does NOT prove: that two real browsers connect. That is the by-hand call of
 * docs/wiki/frontend/modules/calls.md.
 */

/** Mutable: the audio-only describe turns video off; every other test runs a build that has it. */
const features = vi.hoisted(() => ({ CALLS_ENABLED: true, CALLS_VIDEO_ENABLED: true }));
vi.mock('$lib/features', () => features);
/** What the server's kill switch says and whether /api/version answered; mutable per test. */
const serverSwitch = vi.hoisted(() => ({
  mode: 'audio' as 'off' | 'audio' | 'audio_video',
  answered: true,
  refresh: async (): Promise<void> => {},
}));
vi.mock('$lib/stores/appVersionCheck.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverCallsMode: () => serverSwitch.mode,
  getAppVersionCheck: () => (serverSwitch.answered ? {} : null),
  refreshAppVersionCheck: () => serverSwitch.refresh(),
}));
vi.mock('$lib/users/blocks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/users/blocks')>()),
  isBlockedWith: vi.fn(async () => false),
}));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/utils/callPresence', () => ({ publishCallPresence: vi.fn(async () => {}) }));
vi.mock('$lib/utils/chat/callSystemMessages', () => ({
  getCallSystemMessageContext: () => null,
}));
vi.mock('$lib/stores/notificationPreferences.svelte', () => ({
  notificationPreferences: { callsAllowed: vi.fn(() => true) },
}));
vi.mock('$lib/stores/auth', () => ({ getToken: async () => 'session-token' }));
vi.mock('$lib/utils/callAudio', () => ({
  buildCallAudioConstraints: () => true,
  configureCallAudioSenders: async () => {},
  logCallAudioTrackSettings: () => {},
}));
vi.mock('$lib/mls-client/mlsDeliveryHttp', () => ({
  resolveMlsPublicUrls: () => ({ baseUrl: 'https://dev.test', historyUrl: 'https://dev.test' }),
}));

const ICE = [{ urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' }];
/** What the fake server answers; each test that needs another answer sets it, `beforeEach` resets. */
const server = {
  ringTimeoutMs: 60_000,
  initiateStatus: 200,
  iceStatus: 200,
  /** The `turn` field of the ICE answer: `available` unless a test withholds the relay (B7). */
  iceTurn: { status: 'available' } as { status: string; code?: string },
  ringStatus: 200,
  roomTokenStatus: 200,
  /** When set, the ring request waits for it: a test can act while the ring is in flight. */
  ringHold: null as Promise<void> | null,
};
/** The order in which the service talked to the server (`api:<path>`) and to the group (`mls`). */
const order: string[] = [];
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(async (url: string) => {
    order.push(`api:${new URL(url).pathname}`);
    if (url.includes('/api/calls/ring') && !url.includes('ring-end') && server.ringHold) {
      await server.ringHold;
    }
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('/api/calls/initiate'))
      return json(
        { roomId: 'room-1', roomToken: 'rt-1', ringTimeoutMs: server.ringTimeoutMs },
        server.initiateStatus
      );
    if (url.includes('/api/calls/room-token'))
      return json({ roomToken: 'rt-2' }, server.roomTokenStatus);
    if (url.includes('/api/calls/ice-servers'))
      return json({ iceServers: ICE, turn: server.iceTurn }, server.iceStatus);
    if (url.includes('/api/calls/ring-end')) return json({});
    if (url.includes('/api/calls/ring')) return json({ rang: 1 }, server.ringStatus);
    return json({});
  }),
}));

/** How the fake E2E worker answers a `report` request; `null` = it never answers. */
const workerAnswers = {
  report: { sender: 250, receiver: 251 } as { sender: number; receiver: number } | null,
  /** Video frames the worker reports for the CURRENT epoch (`framesInBy`). */
  video: { sender: 0, receiver: 0 },
  /** The epoch of the last transform the service made: the report counts its frames under it. */
  epoch: 0,
  /** The order the path check read its two counters in (`stats`, `report`). */
  reads: [] as string[],
  terminated: 0,
  /** The last worker the service created: a test posts the transforms' own messages through it. */
  last: null as { onmessage: ((e: MessageEvent) => void) | null } | null,
  /** The keys the service handed the last worker (`setKeys`). */
  keys: null as { send: ArrayBuffer; receive: ArrayBuffer } | null,
  /** When set, the worker answers `setKeys` only once it settles: a key import still running. */
  keysHold: null as Promise<void> | null,
};

/** The E2E worker: answers `setKeys` with `keyReady` and `report` with counters, as the real one does. */
vi.mock('../workers/encryption.worker?worker', () => ({
  default: class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    private listeners: ((e: MessageEvent) => void)[] = [];
    constructor() {
      workerAnswers.last = this;
    }
    addEventListener(_: string, l: (e: MessageEvent) => void) {
      this.listeners.push(l);
    }
    removeEventListener(_: string, l: (e: MessageEvent) => void) {
      this.listeners = this.listeners.filter((x) => x !== l);
    }
    postMessage(msg: { type: string; tag?: string; send?: ArrayBuffer; receive?: ArrayBuffer }) {
      if (msg.type === 'report') {
        const frames = workerAnswers.report;
        if (!frames) return;
        workerAnswers.reads.push('report');
        const e = workerAnswers.epoch;
        const video = workerAnswers.video;
        queueMicrotask(() => {
          const data = {
            type: 'report',
            tag: msg.tag,
            transformers: { sender: 1, receiver: 1 },
            framesIn: { ...frames },
            framesInBy: {
              [`${e}|sender|audio`]: frames.sender,
              [`${e}|receiver|audio`]: frames.receiver,
              [`${e}|sender|video`]: video.sender,
              [`${e}|receiver|video`]: video.receiver,
            },
            encrypted: { audio: frames.sender, video: 0 },
            decrypted: { audio: frames.receiver, video: 0 },
            decryptFailures: 0,
            tooShort: 0,
            tooShortEmpty: 0,
            droppedNoKey: 0,
            opusInvalid: { sender: 0, receiver: 0 },
            doubleEncrypted: 0,
          };
          for (const l of this.listeners.slice()) l({ data } as MessageEvent);
        });
        return;
      }
      if (msg.type !== 'setKeys') return;
      workerAnswers.keys = { send: msg.send!, receive: msg.receive! };
      const hold = workerAnswers.keysHold ?? Promise.resolve();
      // A TASK, as a real worker's answer is (another thread posts it): an `addTrack` whose
      // transform waited for it would be one task late, which Chromium short-circuits.
      void hold.then(flushMacrotask).then(() => {
        const e = { data: { type: 'keyReady' } } as MessageEvent;
        this.onmessage?.(e);
        // A copy: the service removes its listener from inside the callback.
        for (const l of this.listeners.slice()) l(e);
      });
    }
    terminate() {
      workerAnswers.terminated++;
    }
  },
}));

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The network drops the socket: no Close frame from either side, the browser reports 1006. */
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  framesOfType(type: string) {
    return this.sent.filter((f) => f.type === type);
  }
}

/**
 * A sender's or receiver's `transform` slot, as Chromium treats it: a transform assigned AFTER the
 * task that created the sender/transceiver is short-circuited for good - attached, never fed
 * (CALL-E2E-BYPASS-MI9T, measured on WebView 152 and Chrome 155, 2026-10-20). `late` records it.
 */
function withTransformSlot<T extends object>(o: T): T & { transform: unknown; late?: boolean } {
  let sameTask = true;
  void flushMacrotask().then(() => (sameTask = false));
  let value: unknown = null;
  const slot = o as T & { transform: unknown; late?: boolean };
  Object.defineProperty(slot, 'transform', {
    get: () => value,
    set: (v: unknown) => {
      if (!sameTask) slot.late = true;
      value = v;
    },
    enumerable: true,
  });
  return slot;
}

type FakeSender = {
  track: { kind: string } | null;
  kind: string;
  transform: unknown;
  late?: boolean;
  replaceTrack: (t: { kind: string } | null) => Promise<void>;
  /** What `setParameters` last set (the quality ladder's rung), as the browser keeps it. */
  params: { encodings: Record<string, unknown>[] };
  getParameters: () => { encodings: Record<string, unknown>[] };
  setParameters: (p: { encodings: Record<string, unknown>[] }) => Promise<void>;
};

/** A sender whose `replaceTrack` swaps its track in place, as the browser's (no negotiation). */
function fakeSender(track: { kind: string } | null, kind: string): FakeSender {
  const sender = withTransformSlot({ track, kind } as {
    track: { kind: string } | null;
    kind: string;
  }) as FakeSender;
  sender.replaceTrack = async (t) => {
    sender.track = t;
  };
  sender.params = { encodings: [{}] };
  sender.getParameters = () => structuredClone(sender.params);
  sender.setParameters = async (p) => {
    sender.params = p;
  };
  return sender;
}

/** A transceiver: its `direction` is what this side asks, `codecs` what `setCodecPreferences` set. */
type FakeTransceiver = {
  sender: FakeSender;
  receiver: { transform: unknown; late?: boolean };
  direction: RTCRtpTransceiverDirection;
  readonly currentDirection: RTCRtpTransceiverDirection | null | undefined;
  codecs: { mimeType: string }[] | null;
  setCodecPreferences: (c: { mimeType: string }[]) => void;
};

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  senders: FakeSender[] = [];
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onicecandidate = null;
  ontrack = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange = null;
  onsignalingstatechange = null;
  closed = false;
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  /** ICE restart offers created (`createOffer({ iceRestart: true })`). */
  restarts = 0;
  /** Unanswered local offers rolled back. */
  rollbacks = 0;
  /** Inbound audio RTP packets the stats report; `null` = no inbound stream yet. */
  inboundPackets: number | null = null;
  /** Outbound RTP packets the stats report; `null` = no outbound stream yet. */
  outboundPackets: number | null = null;
  /** Video RTP packets sent; `null` = no outbound video stream. */
  videoOutboundPackets: number | null = null;
  /** Video RTP packets received; `null` = no inbound video stream. */
  videoInboundPackets: number | null = null;
  /** `addTrack` calls that REUSED a transceiver the peer's offer created. */
  reusedByAddTrack = 0;
  /**
   * Microtask turns each description operation takes before it completes. 0 = at once; above it,
   * an operation started beside another one INTERLEAVES with it, as the browser's can - the only
   * way a race between the frame chain and an offer made outside it shows up here.
   */
  latency = 0;
  /** When set, `createOffer` refuses with it (an engine that cannot make the offer). */
  offerError: Error | null = null;
  private async lag() {
    for (let i = 0; i < this.latency; i++) await Promise.resolve();
  }
  async createOffer(options?: RTCOfferOptions) {
    await this.lag();
    if (this.offerError) throw this.offerError;
    if (options?.iceRestart) this.restarts += 1;
    return { type: 'offer' as const, sdp: `v=0 offer${options?.iceRestart ? ' ice-restart' : ''}` };
  }
  /** When set, `getStats` refuses with it. */
  statsError: Error | null = null;
  /** More fields of the outbound video entry (the quality ladder's sample); `null` = none. */
  videoSend: Record<string, unknown> | null = null;
  /** When set, `getStats` answers only once it settles: a reading still in flight. */
  statsGate: Promise<void> | null = null;
  /**
   * More entries of every reading, keyed by their `id` (`remote-inbound-rtp`, `candidate-pair`,
   * `[CALL_REPORT]` byte totals and timestamps, ...).
   */
  extraStats: Record<string, unknown>[] = [];
  async getStats() {
    workerAnswers.reads.push('stats');
    if (this.statsGate) await this.statsGate;
    if (this.statsError) throw this.statsError;
    const stats = new Map<string, unknown>();
    if (this.videoOutboundPackets !== null || this.videoSend) {
      stats.set('out-v', {
        type: 'outbound-rtp',
        kind: 'video',
        packetsSent: this.videoOutboundPackets ?? 0,
        ...this.videoSend,
      });
    }
    for (const e of this.extraStats) stats.set(String(e.id), e);
    if (this.videoInboundPackets !== null) {
      stats.set('in-v', {
        type: 'inbound-rtp',
        kind: 'video',
        packetsReceived: this.videoInboundPackets,
      });
    }
    if (this.inboundPackets !== null) {
      stats.set('in-1', {
        type: 'inbound-rtp',
        kind: 'audio',
        packetsReceived: this.inboundPackets,
      });
    }
    if (this.outboundPackets !== null) {
      stats.set('out-1', {
        type: 'outbound-rtp',
        kind: 'audio',
        packetsSent: this.outboundPackets,
      });
    }
    return stats;
  }
  /** The ICE agent moves: the state, then its event, as the browser orders them. */
  setIce(state: RTCIceConnectionState) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
  setConnection(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  constructor(public config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }
  receivers: { transform: unknown; late?: boolean }[] = [];
  /**
   * As the browser: `addTrack` REUSES a transceiver of the same kind whose sender never had a
   * track - one the peer's offer created (`remoteOfferAdds`). Its sender slot was created back
   * then, so a transform assigned now is `late`, as Chromium measured (2026-10-20).
   */
  addTrack(track: { kind: string }) {
    const free = this.senders.find((x) => x.track === null && x.kind === track.kind);
    if (free) {
      free.track = track;
      this.reusedByAddTrack += 1;
      return free;
    }
    const sender = fakeSender(track, track.kind);
    this.senders.push(sender);
    this.receivers.push(withTransformSlot({}));
    return sender;
  }
  /** Always a NEW transceiver, created in this task. */
  addTransceiver(track: { kind: string }) {
    const sender = fakeSender(track, track.kind);
    const receiver = withTransformSlot({});
    this.senders.push(sender);
    this.receivers.push(receiver);
    return this.transceiverOf(sender);
  }
  ontrackHandler() {
    return this.ontrack as unknown as ((e: unknown) => void) | null;
  }
  /**
   * The peer's offer carries a NEW m-line of `kind`: `setRemoteDescription` creates its
   * transceiver (a bare sender, a receiver) and fires `ontrack` in the same task, as the browser.
   */
  remoteOfferAdds(kind: string) {
    const sender = fakeSender(null, kind);
    const receiver = withTransformSlot({});
    this.senders.push(sender);
    this.receivers.push(receiver);
    const track = { kind, id: `remote-${kind}-1`, readyState: 'live', muted: false };
    const transceiver = this.transceiverOf(sender);
    this.ontrackHandler()?.({ track, receiver, transceiver });
    return transceiver;
  }
  removeTrack(sender: unknown) {
    const i = this.senders.indexOf(sender as (typeof this.senders)[number]);
    if (i >= 0) {
      this.senders.splice(i, 1);
      this.receivers.splice(i, 1);
    }
  }
  /**
   * The NEGOTIATED direction of the transceiver at that sender index; `null` = not negotiated yet.
   * Unset entries read `sendrecv`, a call whose offer/answer completed.
   */
  directions = new Map<number, RTCRtpTransceiverDirection | null>();
  /** One transceiver object per sender, as the browser: identity holds across `getTransceivers`. */
  private transceivers = new Map<FakeSender, FakeTransceiver>();
  transceiverOf(sender: FakeSender): FakeTransceiver {
    let t = this.transceivers.get(sender);
    if (!t) {
      const negotiated = () => {
        const i = this.senders.indexOf(sender);
        return this.directions.has(i) ? this.directions.get(i) : 'sendrecv';
      };
      t = {
        sender,
        receiver: this.receivers[this.senders.indexOf(sender)],
        direction: 'sendrecv',
        get currentDirection() {
          return negotiated();
        },
        codecs: null,
        setCodecPreferences(c) {
          this.codecs = c;
        },
      };
      this.transceivers.set(sender, t);
    }
    return t;
  }
  getTransceivers() {
    return this.senders.map((sender) => this.transceiverOf(sender));
  }
  async setLocalDescription(desc?: RTCSessionDescriptionInit) {
    await this.lag();
    if (desc?.type === 'rollback') {
      if (this.signalingState !== 'have-local-offer')
        throw new Error('InvalidStateError: rollback');
      this.rollbacks += 1;
      this.localDescription = null;
      this.signalingState = 'stable';
      return;
    }
    if (desc?.type === 'offer') {
      this.localDescription = desc;
      this.signalingState = 'have-local-offer';
      return;
    }
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `v=0 ${type}` };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
    await this.lag();
    // As the browser: an answer applies only to an offer of ours that is pending.
    if (sdp.type === 'answer' && this.signalingState !== 'have-local-offer') {
      throw new Error(`InvalidStateError: answer in ${this.signalingState}`);
    }
    this.remoteDescription = sdp;
    this.signalingState = sdp.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  close() {
    this.closed = true;
  }
}

class FakeTransform {
  constructor(
    public worker: unknown,
    public options: { side: string; kind: string; epoch?: number }
  ) {
    workerAnswers.epoch = options.epoch ?? 0;
  }
}

/** The microphone track: an `EventTarget`, since the service watches its `mute` / `unmute` (WP-C-BG-I). */
const fakeTrack = () =>
  Object.assign(new EventTarget(), { kind: 'audio', stop: vi.fn(), enabled: true, muted: false });
const fakeMls = {
  getDeviceId: () => 'device-1',
  // A key filled with the context's LAST byte: `...|caller` and `...|callee` give different keys.
  exportSecret: vi.fn(async (_g: string, _l: string, context: Uint8Array) =>
    new Uint8Array(32).fill(context[context.length - 1])
  ),
  sendMessage: vi.fn(async () => {
    order.push('mls');
  }),
} as unknown as IMlsService;

/**
 * Lets every pending promise and microtask of the service settle - TWO tasks: the fake worker
 * answers `keyReady` in a task of its own, as a real worker does.
 */
const settle = async () => {
  await flushMacrotask();
  await flushMacrotask();
};

// EVERY test runs on a fake clock, never the real one (2026-10-20). A call a test leaves up has a
// 5 s path check armed on `window.setTimeout`: on the real clock it FIRED seconds later, inside
// whichever test happened to be running, ended its service and wrote a "call end" worker report
// into a neighbour's `appendLog` (1 run in ~15 failed 'owes no report for a call that never
// connected'). A fake clock is thrown away with its test, so nothing outlives it. `setTimeout` only:
// the harness's own yields (`flushMacrotask`) hold the real one.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  server.ringTimeoutMs = 60_000;
  server.initiateStatus = 200;
  server.iceStatus = 200;
  server.iceTurn = { status: 'available' };
  server.ringStatus = 200;
  server.roomTokenStatus = 200;
  server.ringHold = null;
  workerAnswers.report = { sender: 250, receiver: 251 };
  workerAnswers.terminated = 0;
  workerAnswers.video = { sender: 0, receiver: 0 };
  workerAnswers.reads = [];
  workerAnswers.keys = null;
  workerAnswers.keysHold = null;
  order.length = 0;
  FakeSocket.instances = [];
  FakePeerConnection.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('RTCRtpScriptTransform', FakeTransform);
  vi.stubGlobal('RTCIceCandidate', class {});
  vi.stubGlobal(
    'MediaStream',
    class {
      tracks: unknown[] = [];
      getTracks() {
        return this.tracks;
      }
      addTrack(t: unknown) {
        this.tracks.push(t);
      }
    }
  );
  cameras.length = 0;
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: VIDEO_CODECS }) });
  vi.stubGlobal(
    'RTCRtpTransceiver',
    class {
      setCodecPreferences() {}
    }
  );
  stubMedia();
});

/** The engine's video codecs: H.264 FIRST, as WebKit lists them - VP8 must be chosen, not found. */
const VIDEO_CODECS = [
  { mimeType: 'video/H264', clockRate: 90000 },
  { mimeType: 'video/VP8', clockRate: 90000 },
  { mimeType: 'video/rtx', clockRate: 90000 },
];

type FakeCam = {
  kind: 'video';
  id: string;
  stop: ReturnType<typeof vi.fn>;
  enabled: boolean;
  readyState: string;
  muted: boolean;
  facing: string;
  getSettings: () => { facingMode: string };
  onended?: (() => void) | null;
  onunmute?: (() => void) | null;
};
/** Every camera capture the service opened, in order. */
const cameras: FakeCam[] = [];

/** The microphone stream; the service ADDS the camera track to it, as to the browser's. */
function fakeMicStream() {
  const tracks: { kind: string }[] = [fakeTrack()];
  return {
    getTracks: () => tracks.slice(),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    addTrack: (t: { kind: string }) => tracks.push(t),
    removeTrack: (t: { kind: string }) => {
      const i = tracks.indexOf(t);
      if (i >= 0) tracks.splice(i, 1);
    },
  };
}

/**
 * `getUserMedia`: the microphone, or a camera of the facing asked (`exact` refused when
 * `refuseFacing` names it); `cameraCount` video inputs listed.
 */
function stubMedia(opts: { refuseFacing?: string; cameraCount?: number } = {}) {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia: vi.fn(async (c: MediaStreamConstraints) => {
        if (!c.video) return fakeMicStream();
        const fm = (c.video as MediaTrackConstraints).facingMode as {
          exact?: string;
          ideal?: string;
        };
        const facing = fm.exact ?? fm.ideal ?? 'user';
        if (fm.exact && fm.exact === opts.refuseFacing) throw new Error('OverconstrainedError');
        const cam: FakeCam = {
          kind: 'video',
          id: `cam-${cameras.length + 1}`,
          stop: vi.fn(),
          enabled: true,
          readyState: 'live',
          muted: false,
          facing,
          getSettings: () => ({ facingMode: facing }),
        };
        cameras.push(cam);
        return { getVideoTracks: () => [cam] };
      }),
      enumerateDevices: vi.fn(async () =>
        Array.from({ length: opts.cameraCount ?? 2 }, () => ({ kind: 'videoinput' }))
      ),
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Starts a call as the caller and returns its signalling socket, opened and joined. */
async function callerJoined(service: CallService) {
  const started = service.startCall('group-1', false);
  await settle();
  const ws = FakeSocket.instances[0];
  ws.open();
  ws.deliver({ type: 'Joined', room_id: 'room-1' });
  await started;
  return ws;
}

describe('a peer-to-peer call, client side', () => {
  it('refuses on an engine that cannot encrypt, before any request', async () => {
    vi.stubGlobal('RTCRtpScriptTransform', undefined);
    const service = new CallService(fakeMls);
    const { apiFetch } = await import('$lib/utils/apiFetch');
    vi.mocked(apiFetch).mockClear();

    await expect(service.startCall('group-1', false)).rejects.toBeInstanceOf(
      CallE2eUnsupportedError
    );
    expect(apiFetch).not.toHaveBeenCalled();
    expect(get(service.callState)).toBe('idle');
  });

  it('joins a p2p room with its room token, and builds no peer connection before PeerReady', async () => {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);

    expect(ws.sent[0]).toEqual({
      type: 'Join',
      room_id: 'room-1',
      room_token: 'rt-1',
      mode: 'p2p',
    });
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(get(service.callState)).toBe('calling');
  });

  it('as initiator, goes direct-first with the TURN servers and offers on negotiationneeded', async () => {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);

    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    const pc = FakePeerConnection.instances[0];
    expect(pc.config.iceTransportPolicy).toBe('all');
    expect(CALL_ICE_TRANSPORT_POLICY).toBe('all');
    expect(pc.config.iceServers).toEqual(ICE);
    // The E2E transform is on every sender before any offer exists.
    expect(pc.senders).toHaveLength(1);
    expect(pc.senders[0].transform).toBeInstanceOf(FakeTransform);
    expect((pc.senders[0].transform as FakeTransform).options.side).toBe('sender');
    // And on the RECEIVER of the same transceiver, before negotiation: Chrome 155 delivers no
    // frame to a receiver transform attached later, in `ontrack` (measured 2026-10-17).
    expect((pc.receivers[0].transform as FakeTransform).options.side).toBe('receiver');
    // Both in the TASK that created them: one task later Chromium short-circuits them for good.
    expect(pc.senders[0].late).toBeUndefined();
    expect(pc.receivers[0].late).toBeUndefined();

    await pc.onnegotiationneeded!();
    const offers = ws.framesOfType('Offer');
    expect(offers).toHaveLength(1);
    expect(JSON.parse(offers[0].sdp as string).type).toBe('offer');

    ws.deliver({ type: 'Answer', sdp: JSON.stringify({ type: 'answer', sdp: 'v=0 answer' }) });
    await settle();
    expect(pc.remoteDescription?.type).toBe('answer');
  });

  it('as the polite side, never opens and answers the initiator offer', async () => {
    const service = new CallService(fakeMls);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      {
        callId: 'room-1',
        offerSdp: 'START',
        hasVideo: false,
        deviceId: 'device-2',
        ringTimeoutMs: 60_000,
      },
      'me@example.org',
      'device-1'
    );
    const accepted = service.acceptCall('group-1', 'room-1');
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1' });
    await accepted;
    expect(ws.sent[0]).toMatchObject({ type: 'Join', room_token: 'rt-2', mode: 'p2p' });

    ws.deliver({ type: 'PeerReady', initiator: false });
    await settle();
    const pc = FakePeerConnection.instances[0];
    await pc.onnegotiationneeded!();
    expect(ws.framesOfType('Offer')).toHaveLength(0);

    ws.deliver({ type: 'Offer', sdp: JSON.stringify({ type: 'offer', sdp: 'v=0 offer' }) });
    await settle();
    const answers = ws.framesOfType('Answer');
    expect(answers).toHaveLength(1);
    expect(JSON.parse(answers[0].sdp as string).type).toBe('answer');
  });

  it('ends the call when the other party leaves the room', async () => {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();

    ws.deliver({ type: 'PeerLeft' });
    await settle();
    expect(['ended', 'idle']).toContain(get(service.callState));
  });

  it('fails at once on a refused join instead of waiting out the timeout', async () => {
    const service = new CallService(fakeMls);
    const started = service.startCall('group-1', false);
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Refused', reason: 'room-full' });
    await expect(started).rejects.toThrow('room-full');
  });

  it('rebuilds the peer connection when the other device is replaced', async () => {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();

    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[0].closed).toBe(true);
  });
});

/**
 * The ring window (F2). Its length comes from the server's `initiate` answer and travels to the
 * callee inside the invite; these tests shrink it to a few milliseconds and wait for the timer as
 * an EVENT - registered before the wait, shorter than it - never asserting a wall clock.
 */
describe('what the call UI reads: the connected moment', () => {
  it('stamps connectedAt once, on the first connected, and a recovery does not restart it', async () => {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    const pc = FakePeerConnection.instances[0];
    expect(get(service.connectedAt)).toBeNull();

    pc.setConnection('connected');
    const first = get(service.connectedAt);
    expect(first).not.toBeNull();
    expect(get(service.callState)).toBe('incall');

    pc.setConnection('disconnected');
    pc.setConnection('connected');
    // A recovery does not restart the timer.
    expect(get(service.connectedAt)).toBe(first);

    service.endCall();
    expect(get(service.callState)).toBe('ended');
    expect(get(service.endedAt)).not.toBeNull();
  });
});

describe('the E2E worker report (2026-10-19)', () => {
  // An engine whose sender and receiver define `transform` natively, as Chromium and WebKit do.
  class WithTransform {
    get transform() {
      return null;
    }
    /** The receiver's codec list (`RTCRtpReceiver.getCapabilities`), H.264 first as on WebKit. */
    static getCapabilities() {
      return { codecs: VIDEO_CODECS };
    }
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('RTCRtpSender', WithTransform);
    vi.stubGlobal('RTCRtpReceiver', WithTransform);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The worker's evidence that a transform of `epoch` is in the path (its first good frame). */
  function inPath(side: 'sender' | 'receiver', epoch: number) {
    const data = { type: 'inPath', side, epoch, mediaKind: 'audio' };
    workerAnswers.last?.onmessage?.({ data } as MessageEvent);
  }

  /** Our camera goes on (`toggleVideo`), with a fake capture; returns its track. */
  async function turnCameraOn(service: CallService) {
    await service.toggleVideo();
    return cameras[cameras.length - 1];
  }

  async function connectedCall() {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.mocked(appendLog).mockClear();
    FakePeerConnection.instances[0].setConnection('connected');
    const lines = () => vi.mocked(appendLog).mock.calls.map(([l]) => String(l));
    return { service, pc: FakePeerConnection.instances[0], lines };
  }

  it('logs ONE report 5 s after connected and one at the end, then stops the worker', async () => {
    const { service, pc, lines } = await connectedCall();
    // Audio flows both ways: the check is conclusive and does not re-arm.
    pc.inboundPackets = 300;
    pc.outboundPackets = 300;
    await vi.advanceTimersByTimeAsync(5_000);
    // A recovery does not schedule a second one.
    pc.setConnection('disconnected');
    pc.setConnection('connected');
    await vi.advanceTimersByTimeAsync(10_000);
    const reports = () => lines().filter((l) => l.includes('E2E worker report'));
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toContain('(5 s after connected)');
    expect(reports()[0]).toContain('frames in sender=250 receiver=251');
    expect(reports()[0]).not.toContain('ERROR');

    service.endCall();
    // The call summary stays 1.5 s; the cleanup after it asks the worker, THEN stops it.
    await vi.advanceTimersByTimeAsync(1_499);
    expect(workerAnswers.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports()).toHaveLength(2);
    expect(reports()[1]).toContain('(call end, call=room-1)');
    expect(workerAnswers.terminated).toBe(1);
  });

  it('accuses the bridge when the worker never answers, and still stops it', async () => {
    workerAnswers.report = null;
    const { service, lines } = await connectedCall();
    await vi.advanceTimersByTimeAsync(5_000 + 1_500);
    expect(lines()).toContain(
      '[Call] ERROR E2E worker report (5 s after connected): the worker did not answer in 1500 ms - its messages do not reach this thread'
    );
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500 + 1_500);
    expect(workerAnswers.terminated).toBe(1);
  });

  it('names a receiver transform that was never fed a frame', async () => {
    workerAnswers.report = { sender: 250, receiver: 0 };
    const { lines } = await connectedCall();
    await vi.advanceTimersByTimeAsync(5_000);
    const line = lines().find((l) => l.includes('E2E worker report'));
    expect(line?.startsWith('[Call] ERROR E2E worker report')).toBe(true);
    expect(line).toContain('no frame reached the RECEIVER transform');
  });

  it('ENDS a call whose media flowed around the transform, typed, and never claims E2E (CALL-E2E-BYPASS-MI9T)', async () => {
    // The Mi 9T's reading of 2026-10-20: transformers on both sides, not one frame, packets flowing.
    workerAnswers.report = { sender: 0, receiver: 0 };
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 248;
    const { showToast } = await import('$lib/stores/toast.svelte');
    vi.mocked(showToast).mockClear();
    // The codec read (3 s) also reads stats: only the path check's own reads are compared.
    await vi.advanceTimersByTimeAsync(4_999);
    workerAnswers.reads = [];
    await vi.advanceTimersByTimeAsync(1);
    // The first reading is the proof's baseline: packets with no frame YET are too young to judge.
    expect(workerAnswers.reads).toEqual(['stats', 'report']);
    expect(get(service.callState)).toBe('incall');
    expect(
      lines().some((l) =>
        l.startsWith(
          '[Call] E2E path check (5 s after connected): not yet judged: sender:audio carried packets, no frame yet, receiver:audio carried packets, no frame yet'
        )
      )
    ).toBe(true);

    pc.outboundPackets = 500;
    pc.inboundPackets = 496;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] ERROR E2E path check (re-check): media flowed AROUND the transform on sender:audio and receiver:audio (previous check packets sent audio=250 video=0 received audio=248 video=0; now packets sent audio=500 video=0 received audio=496 video=0; frames sender:audio=0 receiver:audio=0)'
    );
    expect(lines()).toContain('[Call] terminal failure: E2E transform bypassed - ending call');
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(m.call_e2e_bypassed(), 'error');
    expect(get(service.callState)).toBe('ended');
    expect(get(service.e2eProven)).toBe(false);
  });

  it('keeps a call whose transforms carry the media, and proves E2E from the worker alone', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    const epoch = workerAnswers.epoch;
    inPath('sender', epoch);
    // One side seen is not the claim: the peer's frames must decrypt too.
    expect(get(service.e2eProven)).toBe(false);
    inPath('receiver', epoch);
    expect(get(service.e2eProven)).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] E2E path check (5 s after connected): no media around the transform (packets sent audio=250 video=0 received audio=251 video=0)'
    );
    expect(get(service.callState)).toBe('incall');

    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    // The claim belongs to ONE call.
    expect(get(service.e2eProven)).toBe(false);
  });

  it('ignores evidence from a stale transform: an old epoch never proves the current call', async () => {
    const { service, lines } = await connectedCall();
    const epoch = workerAnswers.epoch;
    inPath('sender', epoch - 1);
    inPath('receiver', epoch - 1);
    expect(get(service.e2eProven)).toBe(false);
    expect(lines().some((l) => l.includes('from a stale transform'))).toBe(true);
  });

  it('a REBUILT peer connection loses the claim and gets its own path check', async () => {
    const { service, pc, lines } = await connectedCall();
    const first = workerAnswers.epoch;
    inPath('sender', first);
    inPath('receiver', first);
    expect(get(service.e2eProven)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    // The other device was replaced: the relay pairs us again, a new peer connection is built.
    const ws = FakeSocket.instances[0];
    ws.deliver({ type: 'PeerReady', initiator: true });
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(pc.closed).toBe(true);
    expect(get(service.e2eProven)).toBe(false);
    const rebuilt = FakePeerConnection.instances[1];
    expect(workerAnswers.epoch).toBeGreaterThan(first);
    // The dead one's evidence lends nothing; the new one is checked on its own frames.
    inPath('sender', first);
    expect(get(service.e2eProven)).toBe(false);
    rebuilt.setConnection('connected');
    rebuilt.outboundPackets = 120;
    await vi.advanceTimersByTimeAsync(5_000);
    const checks = lines().filter((l) => l.includes('E2E path check (5 s after connected)'));
    expect(checks).toHaveLength(2);
  });

  it('a transceiver the peer created gets BOTH transforms in ontrack, and the camera goes on a FRESH one', async () => {
    const { service, pc, lines } = await connectedCall();
    // The peer turns its camera on: its offer carries a new video m-line.
    const created = pc.remoteOfferAdds('video');
    expect((created.receiver.transform as FakeTransform).options.side).toBe('receiver');
    // Its SENDER too, in the same task: reused bare later, Chromium would have short-circuited it.
    expect((created.sender.transform as FakeTransform).options.side).toBe('sender');
    expect(created.sender.late).toBeUndefined();
    expect(created.receiver.late).toBeUndefined();
    expect(lines().filter((l) => l.includes('receiver transform attached'))).toHaveLength(1);

    // Our camera: a NEW transceiver, both transforms in its creating task - never the reused one.
    const camTrack = await turnCameraOn(service);
    expect(pc.reusedByAddTrack).toBe(0);
    const cam = pc.senders.find((x) => x.track === camTrack)!;
    expect(cam).not.toBe(created.sender);
    expect((cam.transform as FakeTransform).options.side).toBe('sender');
    expect(cam.late).toBeUndefined();
  });

  it('checks the camera on its own: a video sender that carried packets and no frame ends the call', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(get(service.callState)).toBe('incall');

    await turnCameraOn(service);
    pc.videoOutboundPackets = 120;
    // The peer's camera is off: our video m-line receives nothing.
    pc.directions.set(pc.senders.length - 1, 'sendonly');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(get(service.callState)).toBe('incall');
    pc.videoOutboundPackets = 240;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] ERROR E2E path check (re-check): media flowed AROUND the transform on sender:video (previous check packets sent audio=250 video=120 received audio=251 video=0; now packets sent audio=250 video=240 received audio=251 video=0; frames sender:video=0)'
    );
    expect(get(service.callState)).toBe('ended');
  });

  it('never ends a healthy call for a peer camera whose first frame is still in flight (review of #2159)', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    // The peer turns its camera on 3 s after connected: its check JOINS the pending one.
    await vi.advanceTimersByTimeAsync(3_000);
    pc.remoteOfferAdds('video');
    // Its first packets are counted, its first frame is not complete yet.
    pc.videoInboundPackets = 12;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      lines().some((l) =>
        l.startsWith(
          '[Call] E2E path check (5 s after connected, after a new video m-line): not yet judged: receiver:video carried packets, no frame yet'
        )
      )
    ).toBe(true);
    expect(get(service.callState)).toBe('incall');

    // The frame went through the receiver transform: conclusive, nothing ended.
    workerAnswers.video = { sender: 0, receiver: 30 };
    pc.videoInboundPackets = 400;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] E2E path check (re-check): no media around the transform (packets sent audio=250 video=0 received audio=251 video=400)'
    );
    expect(get(service.callState)).toBe('incall');
  });

  describe("an audio-only build judges the peer's HIDDEN video like any other (B0 of the calls plan)", () => {
    // The fakes say what the worker counts; whether WebKit and Chromium FEED a receiver transform
    // whose track has no sink is a phone reading (calls.md, B0; device-verification CALL-L1 row 13).
    beforeEach(() => {
      features.CALLS_VIDEO_ENABLED = false;
    });
    afterEach(() => {
      features.CALLS_VIDEO_ENABLED = true;
    });

    it('frames through the receiver transform: conclusive, the call goes on, nothing is shown', async () => {
      const { service, pc, lines } = await connectedCall();
      pc.outboundPackets = 250;
      pc.inboundPackets = 251;
      await vi.advanceTimersByTimeAsync(5_000);
      pc.remoteOfferAdds('video');
      workerAnswers.video = { sender: 0, receiver: 30 };
      pc.videoInboundPackets = 400;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(lines()).toContain(
        '[Call] E2E path check (after a new video m-line): no media around the transform (packets sent audio=250 video=0 received audio=251 video=400)'
      );
      expect(get(service.callState)).toBe('incall');
      const shown = get(service.remoteStream)?.getTracks() ?? [];
      expect(shown.some((t) => (t as MediaStreamTrack).kind === 'video')).toBe(false);
    });

    it('packets and never a frame: still ENDED as media around the transform, hidden or not', async () => {
      const { service, pc, lines } = await connectedCall();
      pc.outboundPackets = 250;
      pc.inboundPackets = 251;
      await vi.advanceTimersByTimeAsync(5_000);
      pc.remoteOfferAdds('video');
      pc.videoInboundPackets = 120;
      await vi.advanceTimersByTimeAsync(5_000);
      pc.videoInboundPackets = 240;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(
        lines().some(
          (l) =>
            l.startsWith('[Call] ERROR E2E path check') &&
            l.includes('AROUND the transform on receiver:video')
        )
      ).toBe(true);
      expect(get(service.callState)).not.toBe('incall');
    });
  });

  it('re-checks a camera whose negotiation outlasted the check, and catches its bypass then (review S1)', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    await vi.advanceTimersByTimeAsync(5_000);
    const camTrack = await turnCameraOn(service);
    const cam = pc.senders.findIndex((x) => x.track === camTrack);
    // The answer has not come back when the check runs: zero video packets proves nothing.
    pc.directions.set(cam, null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] E2E path check (after the camera was added): not yet judged: video m-line not negotiated yet (packets sent audio=250 video=0 received audio=251 video=0) - re-checking, at most 6 times'
    );
    expect(get(service.callState)).toBe('incall');

    // Negotiated, sending only (the peer's camera is off), packets and no frame through its
    // transform: too young once, then a bypass against that reading.
    pc.directions.set(cam, 'sendonly');
    pc.videoOutboundPackets = 120;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(get(service.callState)).toBe('incall');
    pc.videoOutboundPackets = 240;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      lines().some((l) =>
        l.startsWith(
          '[Call] ERROR E2E path check (re-check): media flowed AROUND the transform on sender:video'
        )
      )
    ).toBe(true);
    expect(get(service.callState)).toBe('ended');
  });

  it('stops re-checking after its budget, withdraws the claim, and re-checks when media starts (review of #2159)', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    const epoch = workerAnswers.epoch;
    inPath('sender', epoch);
    inPath('receiver', epoch);
    await vi.advanceTimersByTimeAsync(5_000);
    const camTrack = (await turnCameraOn(service)) as { onunmute?: (() => void) | null };
    pc.directions.set(pc.senders.length - 1, null);
    await vi.advanceTimersByTimeAsync(5_000 * (CALL_E2E_PATH_RECHECKS + 1));
    // ONE line for an unchanged verdict, not one per re-check.
    expect(lines().filter((l) => l.includes('not yet judged'))).toHaveLength(1);
    expect(lines()).toContain(
      `[Call] WARN E2E path check (re-check): still not judged after ${CALL_E2E_PATH_RECHECKS} re-checks (video m-line not negotiated yet; packets sent audio=250 video=0 received audio=251 video=0) - waiting for media to start`
    );
    expect(get(service.e2eProven)).toBe(false);
    // The re-checks' reports are not logged: a report per re-check is noise.
    expect(lines().filter((l) => l.includes('E2E worker report (re-check)'))).toHaveLength(0);
    // Nothing more until something starts media.
    const before = lines().length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(
      lines()
        .slice(before)
        .some((l) => l.includes('E2E path check'))
    ).toBe(false);

    // The camera unmutes, negotiated now: conclusive, and the claim comes back.
    pc.directions.delete(pc.senders.length - 1);
    pc.videoOutboundPackets = 100;
    pc.videoInboundPackets = 100;
    workerAnswers.video = { sender: 90, receiver: 90 };
    camTrack.onunmute?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] E2E path check (after the camera unmuted): no media around the transform (packets sent audio=250 video=100 received audio=251 video=100)'
    );
    expect(get(service.e2eProven)).toBe(true);
  });

  it('a verdict one check away is never dropped by a spent budget (delta review of #2159)', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    await vi.advanceTimersByTimeAsync(5_000);
    await turnCameraOn(service);
    pc.directions.set(pc.senders.length - 1, null);
    // Six re-checks spend the budget on the camera's m-line...
    await vi.advanceTimersByTimeAsync(5_000 * CALL_E2E_PATH_RECHECKS);
    // ...and the check that would exhaust it sees video packets with no frame through the transform.
    pc.videoInboundPackets = 50;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines().some((l) => l.includes('still not judged after'))).toBe(false);
    pc.videoInboundPackets = 300;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      lines().some((l) =>
        l.startsWith(
          '[Call] ERROR E2E path check (re-check): media flowed AROUND the transform on receiver:video'
        )
      )
    ).toBe(true);
    expect(get(service.callState)).toBe('ended');
  });

  it('an INITIAL local track unmuting re-checks, as the mid-call camera does (delta review of #2159)', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    await vi.advanceTimersByTimeAsync(5_000);
    await turnCameraOn(service);
    pc.directions.set(pc.senders.length - 1, null);
    await vi.advanceTimersByTimeAsync(5_000 * (CALL_E2E_PATH_RECHECKS + 1));
    pc.directions.delete(pc.senders.length - 1);
    pc.videoOutboundPackets = 100;
    pc.videoInboundPackets = 100;
    workerAnswers.video = { sender: 90, receiver: 90 };
    const mic = pc.senders[0].track as { onunmute?: (() => void) | null };
    expect(typeof mic.onunmute).toBe('function');
    mic.onunmute?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] E2E path check (after the local audio unmuted): no media around the transform (packets sent audio=250 video=100 received audio=251 video=100)'
    );
  });

  it('unreadable stats withdraw the claim and re-check, as a silent worker does (delta review of #2159)', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    const epoch = workerAnswers.epoch;
    inPath('sender', epoch);
    inPath('receiver', epoch);
    pc.statsError = new Error('boom');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] WARN E2E claim withdrawn (5 s after connected): the stats cannot be read'
    );
    expect(lines()).toContain(
      '[Call] E2E path check (5 s after connected): not yet judged: getStats failed (Error: boom) (no packet counts) - re-checking, at most 6 times'
    );
    expect(get(service.e2eProven)).toBe(false);
    pc.statsError = null;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(get(service.e2eProven)).toBe(true);
  });

  it('accuses a silent worker ONCE per silence, and says when it answers again (delta review of #2159)', async () => {
    const { pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    workerAnswers.report = null;
    await vi.advanceTimersByTimeAsync(3 * (5_000 + 1_500));
    expect(lines().filter((l) => l.includes('the worker did not answer in'))).toHaveLength(1);
    workerAnswers.report = { sender: 250, receiver: 251 };
    await vi.advanceTimersByTimeAsync(5_000);
    // Said ONCE, by whichever request it answers first: a path re-check or a `[CALL_REPORT]` tick
    // (both ask the same worker, and the silence is the worker's, not one asker's).
    expect(
      lines().filter((l) => /^\[Call\] E2E worker report \(.+\): the worker answers again$/.test(l))
    ).toHaveLength(1);
  });

  it('a negotiation reaching stable re-checks media the last check could not judge', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    await vi.advanceTimersByTimeAsync(5_000);
    await turnCameraOn(service);
    pc.directions.set(pc.senders.length - 1, null);
    await vi.advanceTimersByTimeAsync(5_000 * (CALL_E2E_PATH_RECHECKS + 1));
    // The answer lands: the m-line is negotiated and the camera's frames go through its transform.
    pc.directions.delete(pc.senders.length - 1);
    pc.videoOutboundPackets = 100;
    pc.videoInboundPackets = 100;
    workerAnswers.video = { sender: 90, receiver: 90 };
    pc.signalingState = 'stable';
    (pc.onsignalingstatechange as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] E2E path check (after signalling reached stable): no media around the transform (packets sent audio=250 video=100 received audio=251 video=100)'
    );
    expect(get(service.callState)).toBe('incall');
  });

  it('keeps the EARLIEST deadline: a later trigger joins the pending check, never postpones it (review S2)', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    await vi.advanceTimersByTimeAsync(3_000);
    await turnCameraOn(service);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      lines().some((l) =>
        l.startsWith('[Call] E2E path check (5 s after connected, after the camera was added)')
      )
    ).toBe(true);
  });

  it('names the SENDER when the sender transform is the one that fails in ontrack (review L1)', async () => {
    const { service, pc, lines } = await connectedCall();
    vi.stubGlobal(
      'RTCRtpScriptTransform',
      class extends FakeTransform {
        constructor(worker: unknown, options: { side: string; kind: string; epoch?: number }) {
          if (options.side === 'sender') throw new Error('NotSupportedError');
          super(worker, options);
        }
      }
    );
    pc.remoteOfferAdds('video');
    expect(lines()).toContain(
      '[Call] E2E sender transform failed in ontrack (video): Error: NotSupportedError'
    );
    expect(get(service.callState)).toBe('ended');
  });

  describe('the camera (video, lot 2)', () => {
    const mimes = (t: { codecs: { mimeType: string }[] | null }) =>
      t.codecs?.map((c) => c.mimeType);

    it("holds EVERY video transceiver to VP8, the camera's and the one the peer's offer made", async () => {
      const { service, pc } = await connectedCall();
      const theirs = pc.remoteOfferAdds('video');
      expect(mimes(theirs)).toEqual(['video/VP8', 'video/rtx']);
      const cam = await turnCameraOn(service);
      const mine = pc.getTransceivers().find((t) => t.sender.track === cam)!;
      expect(mimes(mine)).toEqual(['video/VP8', 'video/rtx']);
    });

    it('OFF stops the capture, empties the SAME sender and goes recvonly; ON hands it a new capture, sendrecv', async () => {
      const { service, pc, lines } = await connectedCall();
      const first = await turnCameraOn(service);
      const t = pc.getTransceivers().find((x) => x.sender.track === first)!;
      const count = pc.senders.length;

      await service.toggleVideo();
      expect(first.stop).toHaveBeenCalled();
      expect(t.sender.track).toBeNull();
      expect(t.direction).toBe('recvonly');
      expect(get(service.isVideoOff)).toBe(true);
      expect(lines()).toContain(
        '[Call] camera off (turned off) - sender emptied, recvonly (renegotiating)'
      );

      const second = await turnCameraOn(service);
      expect(second).not.toBe(first);
      // The same transceiver and its transform: no new m-line, no transform to attach late.
      expect(pc.senders.length).toBe(count);
      expect(t.sender.track).toBe(second);
      expect(t.direction).toBe('sendrecv');
      expect(t.sender.late).toBeUndefined();
      expect(get(service.isVideoOff)).toBe(false);
    });

    it('switches to the other camera on the same sender, the old capture stopped first', async () => {
      const { service, pc } = await connectedCall();
      const front = await turnCameraOn(service);
      const t = pc.getTransceivers().find((x) => x.sender.track === front)!;
      expect(get(service.canSwitchCamera)).toBe(true);

      await service.switchCamera();
      const back = cameras[cameras.length - 1];
      expect(front.stop).toHaveBeenCalled();
      expect(back.facing).toBe('environment');
      expect(t.sender.track).toBe(back);
      expect(get(service.cameraFacing)).toBe('environment');
    });

    it('a switch that cannot open the other camera leaves the camera OFF, said and logged', async () => {
      const { service, pc, lines } = await connectedCall();
      const front = await turnCameraOn(service);
      const t = pc.getTransceivers().find((x) => x.sender.track === front)!;
      stubMedia({ refuseFacing: 'environment' });
      const { showToast } = await import('$lib/stores/toast.svelte');
      vi.mocked(showToast).mockClear();

      await service.switchCamera();
      expect(front.stop).toHaveBeenCalled();
      expect(t.sender.track).toBeNull();
      expect(t.direction).toBe('recvonly');
      expect(get(service.isVideoOff)).toBe(true);
      expect(showToast).toHaveBeenCalledWith(m.call_camera_switch_failed(), 'warning');
      expect(
        lines().some((l) => l.startsWith('[Call] ERROR camera switch to environment failed'))
      ).toBe(true);
    });

    it('offers no switch on a device with one camera', async () => {
      stubMedia({ cameraCount: 1 });
      const { service } = await connectedCall();
      await turnCameraOn(service);
      expect(get(service.canSwitchCamera)).toBe(false);
    });

    it('never opens the camera on an engine that cannot hold video to VP8', async () => {
      vi.stubGlobal('RTCRtpReceiver', {
        getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264', clockRate: 90000 }] }),
      });
      const { service, pc, lines } = await connectedCall();
      const before = pc.senders.length;
      const { showToast } = await import('$lib/stores/toast.svelte');
      vi.mocked(showToast).mockClear();

      await service.toggleVideo();
      expect(cameras).toHaveLength(0);
      expect(pc.senders.length).toBe(before);
      expect(get(service.isVideoOff)).toBe(true);
      expect(showToast).toHaveBeenCalledWith(m.call_camera_unavailable(), 'warning');
      expect(lines()).toContain(
        '[Call] ERROR this engine cannot hold video to VP8 - the camera stays off'
      );
    });

    /** The next camera capture waits for `release()`: a permission prompt still up. */
    function holdNextCapture() {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const md = navigator.mediaDevices as unknown as {
        getUserMedia: (c: MediaStreamConstraints) => Promise<unknown>;
      };
      const real = md.getUserMedia;
      md.getUserMedia = async (c) => {
        md.getUserMedia = real;
        await gate;
        return real(c);
      };
      return release;
    }

    it('never adopts a capture that resolves after its call ended - not into the NEXT call', async () => {
      const { service, lines } = await connectedCall();
      const release = holdNextCapture();
      const pending = service.toggleVideo();
      service.endCall();
      await vi.advanceTimersByTimeAsync(1_500);
      // Another call is up before the old prompt answers.
      const next = service.startCall('group-1', false);
      await settle();
      const ws = FakeSocket.instances[FakeSocket.instances.length - 1];
      ws.open();
      ws.deliver({ type: 'Joined', room_id: 'room-2' });
      await next;
      release();
      await pending;
      const cam = cameras[cameras.length - 1];
      expect(cam.stop).toHaveBeenCalled();
      expect(get(service.isVideoOff)).toBe(true);
      expect(
        (
          service as unknown as { localStream: { getVideoTracks: () => unknown[] } }
        ).localStream.getVideoTracks()
      ).toEqual([]);
      expect(lines().some((l) => l.includes('resolved after it ended - capture stopped'))).toBe(
        true
      );
    });

    it('an OFF tapped while the camera is still opening wins: the camera ends OFF', async () => {
      const { service, pc, lines } = await connectedCall();
      const release = holdNextCapture();
      const opening = service.toggleVideo();
      // The button already shows ON's destination; this tap means OFF and is queued, not dropped.
      await service.toggleVideo();
      expect(lines()).toContain(
        '[Call] camera off queued - applied once the running camera operation ends'
      );
      release();
      await opening;
      await settle();
      const cam = cameras[cameras.length - 1];
      expect(cam.stop).toHaveBeenCalled();
      expect(get(service.isVideoOff)).toBe(true);
      const t = pc.getTransceivers().find((x) => x.sender.kind === 'video');
      expect(t?.sender.track ?? null).toBeNull();
    });

    it('the background turns the camera OFF for real and the return turns it ON again - never black frames', async () => {
      const { service, pc } = await connectedCall();
      const first = await turnCameraOn(service);
      const t = pc.getTransceivers().find((x) => x.sender.track === first)!;
      let hidden = true;
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
      });
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        await settle();
        expect(first.stop).toHaveBeenCalled();
        expect(first.enabled).toBe(true); // never the black-frame pause
        expect(t.sender.track).toBeNull();
        expect(t.direction).toBe('recvonly');

        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        await settle();
        const back = cameras[cameras.length - 1];
        expect(back).not.toBe(first);
        expect(t.sender.track).toBe(back);
        expect(t.direction).toBe('sendrecv');
        expect(get(service.isVideoOff)).toBe(false);
      } finally {
        delete (document as unknown as { visibilityState?: string }).visibilityState;
      }
    });

    describe('on Android, where the WebView stays "visible" in the background', () => {
      // MainActivity writes `window.__canariForeground` and dispatches `canari:foreground`; the
      // document never changes (utils/appForeground.ts). The camera must follow THAT signal.
      const win = window as unknown as { __canariForeground?: boolean };
      const announce = (foreground: boolean) => {
        win.__canariForeground = foreground;
        window.dispatchEvent(new CustomEvent('canari:foreground', { detail: { foreground } }));
      };
      afterEach(() => {
        delete win.__canariForeground;
      });

      it('canari:foreground false turns the camera OFF, true turns it ON again', async () => {
        const { service, pc, lines } = await connectedCall();
        const first = await turnCameraOn(service);
        const t = pc.getTransceivers().find((x) => x.sender.track === first)!;

        announce(false);
        await settle();
        expect(first.stop).toHaveBeenCalled();
        expect(t.sender.track).toBeNull();
        expect(lines()).toContain(
          '[Call] backgrounded - camera off until the app returns (audio continues)'
        );

        announce(true);
        await settle();
        const back = cameras[cameras.length - 1];
        expect(back).not.toBe(first);
        expect(t.sender.track).toBe(back);
        expect(get(service.isVideoOff)).toBe(false);
      });

      it('a camera the OS ends while the app is off screen comes back at the return', async () => {
        const { service, pc, lines } = await connectedCall();
        const first = await turnCameraOn(service);
        const t = pc.getTransceivers().find((x) => x.sender.track === first)!;

        // The OS wins the race: the flag is already false, the event not yet delivered.
        win.__canariForeground = false;
        first.onended?.();
        await settle();
        expect(t.sender.track).toBeNull();
        expect(lines()).toContain(
          '[Call] the system ended the camera of a backgrounded app - on again at return'
        );

        announce(false); // the late event finds the camera off and changes nothing
        await settle();
        announce(true);
        await settle();
        const back = cameras[cameras.length - 1];
        expect(back).not.toBe(first);
        expect(t.sender.track).toBe(back);
      });

      it('a camera the OS ends ON screen stays off (another app took it)', async () => {
        const { service, pc } = await connectedCall();
        const first = await turnCameraOn(service);
        const t = pc.getTransceivers().find((x) => x.sender.track === first)!;
        first.onended?.();
        await settle();
        announce(false);
        await settle();
        announce(true);
        await settle();
        expect(t.sender.track).toBeNull();
        expect(get(service.isVideoOff)).toBe(true);
      });
    });

    describe('the quality ladder (utils/callVideoQuality.ts)', () => {
      /** The camera sender's link as `getStats` reports it, advanced by one 2 s sample. */
      function linkReporter(pc: FakePeerConnection) {
        let frames = 0;
        let sent = 0;
        let lost = 0;
        let reports = 0;
        return async (o: { loss?: number; limit?: string; available?: number } = {}) => {
          frames += 60;
          reports += 1;
          sent += 400;
          lost += Math.round(400 * (o.loss ?? 0));
          pc.videoSend = {
            framesEncoded: frames,
            packetsSent: sent,
            qualityLimitationReason: o.limit ?? 'none',
          };
          pc.extraStats = [
            {
              id: 'rv',
              type: 'remote-inbound-rtp',
              kind: 'video',
              localId: 'out-v',
              packetsLost: lost,
              roundTripTime: 0.05,
              reportsReceived: reports,
            },
            { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
            {
              id: 'p',
              type: 'candidate-pair',
              availableOutgoingBitrate: o.available ?? 5_000_000,
            },
          ];
          await vi.advanceTimersByTimeAsync(2_000);
        };
      }

      async function cameraCall() {
        const call = await connectedCall();
        call.pc.outboundPackets = 250;
        call.pc.inboundPackets = 251;
        workerAnswers.video = { sender: 100, receiver: 0 };
        const cam = await turnCameraOn(call.service);
        await vi.advanceTimersByTimeAsync(0);
        const sender = call.pc.getTransceivers().find((x) => x.sender.track === cam)!.sender;
        return { ...call, sender, sample: linkReporter(call.pc) };
      }

      it('starts the camera on 480p, climbs to 720p on clean samples, drops on a starved encoder and says it', async () => {
        const { service, sender, sample, lines } = await cameraCall();
        expect(sender.params.encodings[0]).toEqual({
          maxBitrate: 1_200_000,
          maxFramerate: 30,
          scaleResolutionDownBy: 1.5,
        });

        expect(lines()).toContain(
          '[Call] video quality ladder starts on 480p30 (degradationPreference=unset)'
        );
        await sample(); // the baseline
        await sample();
        await sample();
        await sample();
        expect(lines()).toContain(
          '[Call] video quality up 480p30 -> 720p30 after 3 clean samples (loss=0% rtt=50ms limit=none avail=5000kbps sent=? enc=?)'
        );
        expect(sender.params.encodings[0]).toEqual({
          maxBitrate: 2_500_000,
          maxFramerate: 30,
          scaleResolutionDownBy: 1,
        });
        expect(get(service.videoSendReduced)).toBe(false);

        await sample(); // read across the change, never judged
        await sample({ limit: 'bandwidth', available: 190_000 });
        expect(lines()).toContain(
          '[Call] video quality down 720p30 -> 360p15 after a severe sample, the climb into 720p30 failed - the next one needs 6 clean samples (loss=0% rtt=50ms limit=bandwidth avail=190kbps sent=? enc=?)'
        );
        expect(sender.params.encodings[0]).toEqual({
          maxBitrate: 400_000,
          maxFramerate: 15,
          scaleResolutionDownBy: 2,
        });
        expect(get(service.videoSendReduced)).toBe(true);
        expect(get(service.callState)).toBe('incall');

        // The call ends: the ladder stops with it and reads nothing more.
        service.endCall();
        expect(get(service.videoSendReduced)).toBe(false);
        workerAnswers.reads = [];
        await vi.advanceTimersByTimeAsync(10_000);
        expect(workerAnswers.reads).not.toContain('stats');
      });

      it('a camera that is off is no evidence: the ladder waits and moves nothing', async () => {
        const { service, sender, sample, lines } = await cameraCall();
        await service.toggleVideo();
        expect(sender.track).toBeNull();
        for (let i = 0; i < 6; i++) await sample({ loss: 0.5 });
        expect(lines().some((l) => /video quality (up|down)/.test(l))).toBe(false);
        expect(sender.params.encodings[0]).toMatchObject({ scaleResolutionDownBy: 1.5 });
        // The camera back on: the ladder samples again, from a new baseline.
        await service.toggleVideo();
        await vi.advanceTimersByTimeAsync(0);
        expect(sender.track).not.toBeNull();
        for (let i = 0; i < 3; i++) await sample({ loss: 0.5 });
        expect(lines()).toContain(
          '[Call] video quality down 480p30 -> 360p30 after a severe sample (loss=50% rtt=50ms limit=none avail=5000kbps sent=? enc=?)'
        );
      });

      it('stops, at ERROR, when the engine refuses a rung - never keeps proposing it', async () => {
        const { service, sender, sample, lines } = await cameraCall();
        sender.setParameters = async () => {
          throw new Error('InvalidModificationError');
        };
        await sample();
        await sample({ loss: 0.3 });
        expect(lines()).toContain(
          '[Call] ERROR video sender setParameters(360p30) refused: Error: InvalidModificationError'
        );
        expect(lines()).toContain(
          '[Call] ERROR video quality ladder stopped: the sender refused a rung'
        );
        const before = lines().length;
        for (let i = 0; i < 5; i++) await sample({ loss: 0.3 });
        expect(
          lines()
            .slice(before)
            .some((l) => l.includes('video quality') || l.includes('setParameters'))
        ).toBe(false);
        expect(get(service.videoSendReduced)).toBe(false);
      });
    });

    it('names a non-VP8 video frame ONCE per call at ERROR, and the kind of a failed decrypt', async () => {
      const { lines } = await connectedCall();
      const post = (data: Record<string, unknown>) =>
        workerAnswers.last?.onmessage?.({ data } as MessageEvent);
      post({ type: 'videoCodecUnexpected', mimeType: 'video/H264', count: 1 });
      post({ type: 'videoCodecUnexpected', mimeType: 'video/H264', count: 2 });
      post({ type: 'decryptError', detail: 'OperationError', count: 1, mediaKind: 'video' });
      expect(lines().filter((l) => l.includes('not VP8'))).toEqual([
        '[Call] ERROR E2E: video frames of video/H264, not VP8, crossed the transform - encrypted whole, they cannot decode (1 so far)',
      ]);
      expect(lines()).toContain('[Call] E2E decrypt failed (video, 1): OperationError');
    });

    it("republishes the remote stream when the peer's camera goes off (its track mutes)", async () => {
      const { service, pc } = await connectedCall();
      pc.remoteOfferAdds('video');
      let published = 0;
      const unsub = service.remoteStreams.subscribe(() => (published += 1));
      const before = published;
      const remote = (
        service as unknown as { mergedRemoteStream: { tracks: { onmute?: () => void }[] } }
      ).mergedRemoteStream.tracks.find((x) => x)!;
      remote.onmute?.();
      expect(published).toBe(before + 1);
      unsub();
    });
  });

  it('arms the sender of a peer-created transceiver as armed, not attached (review L1)', async () => {
    const { pc, lines } = await connectedCall();
    pc.remoteOfferAdds('video');
    expect(lines()).toContain('[Call] E2E sender transform armed, no track yet (video)');
  });

  it('WITHDRAWS the claim when the worker can no longer be asked, re-checks, and only an answered check returns it (review of #2159)', async () => {
    const { service, pc, lines } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    const epoch = workerAnswers.epoch;
    inPath('sender', epoch);
    inPath('receiver', epoch);
    expect(get(service.e2eProven)).toBe(true);
    workerAnswers.report = null;
    await vi.advanceTimersByTimeAsync(5_000 + 1_500);
    expect(lines()).toContain(
      '[Call] WARN E2E claim withdrawn (5 s after connected): the worker cannot be asked'
    );
    expect(get(service.e2eProven)).toBe(false);
    // Frame evidence alone does not bring it back while withdrawn.
    inPath('sender', epoch);
    inPath('receiver', epoch);
    expect(get(service.e2eProven)).toBe(false);
    // The worker answers again: the scheduled re-check concludes, and the claim returns.
    workerAnswers.report = { sender: 500, receiver: 501 };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] E2E path check (re-check): no media around the transform (packets sent audio=250 video=0 received audio=251 video=0)'
    );
    expect(get(service.e2eProven)).toBe(true);
  });

  it("a check of a REPLACED peer connection cannot withdraw the new one's claim", async () => {
    const { service, lines } = await connectedCall();
    workerAnswers.report = null;
    // The check of the first peer connection is in flight (waiting for its answer)...
    await vi.advanceTimersByTimeAsync(5_000);
    // ...when the relay pairs us again and the new peer connection proves its transforms.
    FakeSocket.instances[0].deliver({ type: 'PeerReady', initiator: true });
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    const epoch = workerAnswers.epoch;
    inPath('sender', epoch);
    inPath('receiver', epoch);
    expect(get(service.e2eProven)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(lines().some((l) => l.includes('dropped: its peer connection was replaced'))).toBe(true);
    expect(get(service.e2eProven)).toBe(true);
  });

  it('the end report after a REBUILT peer connection does not accuse a side its own check never judged', async () => {
    workerAnswers.report = { sender: 250, receiver: 251 };
    const { service, pc } = await connectedCall();
    pc.outboundPackets = 250;
    pc.inboundPackets = 251;
    await vi.advanceTimersByTimeAsync(5_000);
    FakeSocket.instances[0].deliver({ type: 'PeerReady', initiator: true });
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    // The new peer connection's transforms have no frame yet when the call ends.
    workerAnswers.report = { sender: 0, receiver: 0 };
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.mocked(appendLog).mockClear();
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    const end = vi
      .mocked(appendLog)
      .mock.calls.map(([l]) => String(l))
      .find((l) => l.includes('E2E worker report (call end'));
    expect(end).toBeDefined();
    expect(end).not.toContain('ERROR');
  });

  it('does not accuse an empty side at the end of a call shorter than the 5 s report', async () => {
    workerAnswers.report = { sender: 40, receiver: 0 };
    const { service, lines } = await connectedCall();
    await vi.advanceTimersByTimeAsync(1_000);
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    const line = lines().find((l) => l.includes('E2E worker report'));
    expect(line).toContain('(call end, call=room-1)');
    expect(line).toContain('frames in sender=40 receiver=0');
    expect(line).not.toContain('ERROR');
  });

  it('owes no report for a call that never connected', async () => {
    const service = new CallService(fakeMls);
    await callerJoined(service);
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.mocked(appendLog).mockClear();
    service.endCall();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(vi.mocked(appendLog).mock.calls.some(([l]) => String(l).includes('worker report'))).toBe(
      false
    );
  });
});

/** The CallMsg frames this device sent over MLS since the last `mockClear`. */
const sentCallFrames = () =>
  vi
    .mocked(fakeMls.sendMessage)
    .mock.calls.map((c) => decodeAppMessage((c as unknown as [string, Uint8Array])[1])?.call)
    .filter((c) => !!c);

describe('a second call while one is up', () => {
  it('does not ring over the call in progress, answers it with a typed BUSY frame, and says why', async () => {
    const service = new CallService(fakeMls);
    await callerJoined(service);
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.mocked(appendLog).mockClear();
    vi.mocked(fakeMls.sendMessage).mockClear();

    await service.handleCallSignal(
      'other@example.org',
      'group-2',
      {
        callId: 'room-2',
        offerSdp: 'START',
        hasVideo: false,
        deviceId: 'device-9',
        ringTimeoutMs: 60_000,
      },
      'me@example.org',
      'device-1'
    );

    expect(get(service.callState)).toBe('calling');
    expect(service.currentCallId).toBe('room-1');
    expect(service.incomingCallerId).toBeNull();
    // B16: the caller is ANSWERED (one typed busy frame for the second call, no hangup), so it does
    // not ring out the server's window. The call in progress is untouched.
    const frames = sentCallFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.callId).toBe('room-2');
    expect(frames[0]?.busy).toBe(true);
    expect(frames[0]?.hangup).toBeFalsy();
    expect(
      vi
        .mocked(appendLog)
        .mock.calls.map((c) => c[0])
        .join(' ')
    ).toContain('invite room-2 in group-2 meets state=calling call=room-1');
  });
});

describe('when a busy answer is, and is not, given', () => {
  const inviteOf = (callId: string, ringTimeoutMs = 60_000) => ({
    callId,
    offerSdp: 'START',
    hasVideo: false,
    deviceId: 'device-9',
    ringTimeoutMs,
  });
  const ring = (
    service: CallService,
    callId: string,
    group = 'group-2',
    from = 'other@example.org'
  ) => service.handleCallSignal(from, group, inviteOf(callId), 'me@example.org', 'device-1');

  it('an invite during the ended summary rings, with no busy', async () => {
    const service = new CallService(fakeMls);
    await callerJoined(service);
    service.endCall();
    expect(get(service.callState)).toBe('ended');
    vi.mocked(fakeMls.sendMessage).mockClear();

    await ring(service, 'room-2', 'group-1');

    expect(sentCallFrames()).toHaveLength(0);
    expect(get(service.callState)).toBe('incoming');
    expect(service.currentCallId).toBe('room-2');
    // The summary's old timer must not cut the new ring short.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(get(service.callState)).toBe('incoming');
  });

  it('a call still in its setup (no id yet) loses a glare and rings the invite', async () => {
    const service = new CallService(fakeMls);
    const internals = service as unknown as { currentGroupId: string | null };
    service.callState.set('calling');
    internals.currentGroupId = 'group-1';
    expect(service.currentCallId).toBeNull();

    await ring(service, 'room-2', 'group-1');

    expect(sentCallFrames().some((c) => c?.busy)).toBe(false);
    expect(get(service.callState)).toBe('incoming');
    expect(service.currentCallId).toBe('room-2');
  });

  it('answers no busy to a sender it has blocked', async () => {
    const { isBlockedWith } = await import('$lib/users/blocks');
    vi.mocked(isBlockedWith).mockResolvedValueOnce(true);
    const service = new CallService(fakeMls);
    await callerJoined(service);
    vi.mocked(fakeMls.sendMessage).mockClear();

    await ring(service, 'room-2');

    expect(sentCallFrames()).toHaveLength(0);
  });

  it('answers no busy to an invite with no ring window', async () => {
    const service = new CallService(fakeMls);
    await callerJoined(service);
    vi.mocked(fakeMls.sendMessage).mockClear();

    await service.handleCallSignal(
      'other@example.org',
      'group-2',
      inviteOf('room-2', 0),
      'me@example.org',
      'device-1'
    );

    expect(sentCallFrames()).toHaveLength(0);
  });

  it('answers no busy to a redelivery of the invite of the call it is already in', async () => {
    const service = new CallService(fakeMls);
    await ring(service, 'room-1', 'group-1', 'peer@example.org');
    vi.mocked(fakeMls.sendMessage).mockClear();

    await ring(service, 'room-1', 'group-1', 'peer@example.org');

    expect(sentCallFrames()).toHaveLength(0);
    expect(get(service.callState)).toBe('incoming');
  });

  it('glare: the LOWER callId wins, ignoring the other invite and sending no busy', async () => {
    const service = new CallService(fakeMls);
    await callerJoined(service);
    vi.mocked(fakeMls.sendMessage).mockClear();

    await ring(service, 'room-9', 'group-1');

    expect(sentCallFrames()).toHaveLength(0);
    expect(get(service.callState)).toBe('calling');
    expect(service.currentCallId).toBe('room-1');
  });

  it('glare: the HIGHER callId yields, cancels its call and rings the winner', async () => {
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    await callerJoined(service);
    vi.mocked(fakeMls.sendMessage).mockClear();

    await ring(service, 'room-0', 'group-1');

    expect(get(service.callState)).toBe('incoming');
    expect(service.currentCallId).toBe('room-0');
    expect(chat.onCallEnded).toHaveBeenCalledWith('group-1', 'room-1', 'cancelled', undefined);
    expect(sentCallFrames().some((c) => c?.busy)).toBe(false);
  });

  it('a busy answer only ends the caller own call, never another one', async () => {
    const service = new CallService(fakeMls);
    await callerJoined(service);

    await service.handleCallSignal(
      'callee@example.org',
      'group-1',
      { callId: 'room-0', busy: true },
      'me@example.org',
      'device-1'
    );

    expect(get(service.callState)).toBe('calling');
  });
});

describe('a call whose callee reached the room is ANSWERED (B15)', () => {
  const asked = async () => {
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    vi.mocked(fakeMls.sendMessage).mockClear();
    return { chat, service, ws };
  };
  const failCall = (service: CallService, why: string) =>
    (service as unknown as { failCall: (r: string) => void }).failCall(why);

  it('the callee leaves before any media: PeerLeft writes a duration, not an unanswered call', async () => {
    const { chat, service, ws } = await asked();
    ws.deliver({ type: 'PeerLeft' });
    await settle();

    expect(['ended', 'idle']).toContain(get(service.callState));
    expect(chat.onCallEnded).toHaveBeenCalledTimes(1);
    expect(chat.onCallEnded.mock.calls[0][2]).toBeUndefined();
  });

  it('the callee MLS hangup first: the same fact, written by the signal path alone', async () => {
    const { chat, service } = await asked();
    await service.handleCallSignal(
      'callee@example.org',
      'group-1',
      { callId: 'room-1', hangup: true },
      'me@example.org',
      'device-1'
    );
    expect(['ended', 'idle']).toContain(get(service.callState));
    expect(chat.onCallEnded).not.toHaveBeenCalled();
  });

  it('a hang-up by the caller after the callee arrived sends no unanswered reason', async () => {
    const { chat, service } = await asked();
    service.endCall();

    expect(chat.onCallEnded.mock.calls[0][2]).toBeUndefined();
    const hangup = sentCallFrames().find((c) => c?.hangup);
    expect(hangup?.endReason ?? 0).toBe(canari.CallEndReason.CALL_END_REASON_UNSPECIFIED);
  });

  it('a stalled media path after the callee joined fails an answered call, with a hangup', async () => {
    const { chat, service } = await asked();
    failCall(service, 'ice failed');

    expect(chat.onCallEnded.mock.calls[0][2]).toBeUndefined();
    expect(sentCallFrames().some((c) => c?.hangup)).toBe(true);
  });
});

describe('a call that fails after its invite left (B15)', () => {
  it('is NOT ANSWERED, never cancelled, and its hangup says so', async () => {
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    await callerJoined(service);
    vi.mocked(fakeMls.sendMessage).mockClear();

    (service as unknown as { failCall: (r: string) => void }).failCall('signalling closed');

    expect(chat.onCallEnded).toHaveBeenCalledWith('group-1', 'room-1', 'not-answered', undefined);
    const hangup = sentCallFrames().find((c) => c?.hangup);
    expect(hangup?.endReason).toBe(canari.CallEndReason.CALL_END_REASON_NOT_ANSWERED);
  });
});

describe('a busy answer, caller side (B16)', () => {
  const busyFrame = { callId: 'room-1', busy: true, deviceId: 'device-9' };

  it('ends the ringing call at once, tells the user, and records it as busy', async () => {
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    await callerJoined(service);
    vi.mocked(fakeMls.sendMessage).mockClear();
    const { showToast } = await import('$lib/stores/toast.svelte');

    await service.handleCallSignal(
      'callee@example.org',
      'group-1',
      busyFrame,
      'me@example.org',
      'device-1'
    );

    expect(['ended', 'idle']).toContain(get(service.callState));
    expect(showToast).toHaveBeenCalledWith(m.call_busy(), 'info');
    expect(chat.onCallEnded).toHaveBeenCalledTimes(1);
    expect(chat.onCallEnded).toHaveBeenCalledWith('group-1', 'room-1', 'busy', undefined);
    // The hangup stops the callee's other devices ringing, and says why.
    const hangup = sentCallFrames().find((c) => c?.hangup);
    expect(hangup?.endReason).toBe(canari.CallEndReason.CALL_END_REASON_BUSY);
  });

  it('ignores a busy frame from the own account, for another call, or once connected', async () => {
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    await callerJoined(service);

    await service.handleCallSignal(
      'me@example.org',
      'group-1',
      busyFrame,
      'me@example.org',
      'device-1'
    );
    await service.handleCallSignal(
      'callee@example.org',
      'group-1',
      { ...busyFrame, callId: 'other-call' },
      'me@example.org',
      'device-1'
    );

    expect(get(service.callState)).toBe('calling');
    expect(chat.onCallEnded).not.toHaveBeenCalled();
  });
});

describe('the typed end reason of an unanswered call (B15)', () => {
  const incoming = { callId: 'room-1', offerSdp: 'START', ringTimeoutMs: 60_000, deviceId: 'd-2' };

  it('says CANCELLED when the caller hangs up a ring', async () => {
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    await callerJoined(service);
    vi.mocked(fakeMls.sendMessage).mockClear();

    service.endCall();

    expect(chat.onCallEnded).toHaveBeenCalledWith('group-1', 'room-1', 'cancelled', undefined);
    const hangup = sentCallFrames().find((c) => c?.hangup);
    expect(hangup?.endReason).toBe(canari.CallEndReason.CALL_END_REASON_CANCELLED);
  });

  it('says DECLINED, naming the caller, when the callee refuses a ring', async () => {
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      incoming,
      'me@example.org',
      'device-1'
    );
    vi.mocked(fakeMls.sendMessage).mockClear();

    service.endCall();

    expect(chat.onCallEnded).toHaveBeenCalledWith(
      'group-1',
      'room-1',
      'declined',
      'peer@example.org'
    );
    const hangup = sentCallFrames().find((c) => c?.hangup);
    expect(hangup?.endReason).toBe(canari.CallEndReason.CALL_END_REASON_DECLINED);
  });

  it('writes nothing for a hangup the OTHER party sent: the signal path is the writer', async () => {
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      incoming,
      'me@example.org',
      'device-1'
    );

    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      { callId: 'room-1', hangup: true, endReason: canari.CallEndReason.CALL_END_REASON_CANCELLED },
      'me@example.org',
      'device-1'
    );

    expect(get(service.callState)).toBe('idle');
    expect(chat.onCallEnded).not.toHaveBeenCalled();
  });
});

describe('the ring window, both sides', () => {
  // The window is a timer: fake it, and step past it. `setTimeout` only, so the harness's own
  // microtask and macrotask yields still run.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const pastWindow = () => vi.advanceTimersByTimeAsync(30);
  const invite = (ringTimeoutMs?: number) => ({
    callId: 'room-1',
    offerSdp: 'START',
    hasVideo: false,
    deviceId: 'device-2',
    ringTimeoutMs,
  });

  it('relays the server window in the invite, and ends an unanswered call as missed', async () => {
    server.ringTimeoutMs = 5;
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    await callerJoined(service);

    await pastWindow();

    expect(['ended', 'idle']).toContain(get(service.callState));
    // The typed reason, sent on the hangup and handed to the ONE record writer.
    expect(chat.onCallEnded).toHaveBeenCalledTimes(1);
    expect(chat.onCallEnded).toHaveBeenCalledWith('group-1', 'room-1', 'not-answered', undefined);
    const hangup = sentCallFrames().find((c) => c?.hangup);
    expect(hangup?.endReason).toBe(canari.CallEndReason.CALL_END_REASON_NOT_ANSWERED);
  });

  it('keeps the call once the other party has arrived', async () => {
    server.ringTimeoutMs = 5;
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();

    await pastWindow();

    expect(get(service.callState)).toBe('calling');
  });

  it('rings as a VIDEO call only when the invite says so, and an audio one opens no camera', async () => {
    const video = new CallService(fakeMls);
    await video.handleCallSignal(
      'peer@example.org',
      'group-1',
      { ...invite(5), hasVideo: true },
      'me@example.org',
      'device-1'
    );
    expect(video.incomingHasVideo).toBe(true);

    const audio = new CallService(fakeMls);
    await audio.handleCallSignal(
      'peer@example.org',
      'group-2',
      { ...invite(5), hasVideo: undefined },
      'me@example.org',
      'device-1'
    );
    expect(audio.incomingHasVideo).toBe(false);
    expect(cameras).toHaveLength(0);
  });

  it('stops ringing the callee when the window closes, and writes nothing', async () => {
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      invite(5),
      'me@example.org',
      'device-1'
    );
    expect(get(service.callState)).toBe('incoming');

    await pastWindow();

    expect(get(service.callState)).toBe('idle');
    expect(chat.onCallEnded).not.toHaveBeenCalled();
  });

  it('does not ring in a conversation whose call permission refuses it', async () => {
    const { notificationPreferences } = await import('$lib/stores/notificationPreferences.svelte');
    vi.mocked(notificationPreferences.callsAllowed).mockReturnValueOnce(false);
    const service = new CallService(fakeMls);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      invite(5),
      'me@example.org',
      'device-1'
    );
    expect(notificationPreferences.callsAllowed).toHaveBeenCalledWith('group-1');
    expect(get(service.callState)).toBe('idle');
  });

  it('does not ring while the server kill switch reads off', async () => {
    serverSwitch.mode = 'off';
    try {
      const service = new CallService(fakeMls);
      await service.handleCallSignal(
        'peer@example.org',
        'group-1',
        invite(5),
        'me@example.org',
        'device-1'
      );
      expect(get(service.callState)).toBe('idle');
    } finally {
      serverSwitch.mode = 'audio';
    }
  });

  it('waits for a pending version check, then rings on audio and not on off', async () => {
    for (const answer of ['audio', 'off'] as const) {
      serverSwitch.mode = 'off';
      serverSwitch.answered = false;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      serverSwitch.refresh = async () => {
        await gate;
        serverSwitch.mode = answer;
        serverSwitch.answered = true;
      };
      try {
        const service = new CallService(fakeMls);
        const handled = service.handleCallSignal(
          'peer@example.org',
          'group-1',
          invite(5),
          'me@example.org',
          'device-1'
        );
        await Promise.resolve();
        expect(get(service.callState)).toBe('idle');
        release();
        await handled;
        expect(get(service.callState)).toBe(answer === 'audio' ? 'incoming' : 'idle');
      } finally {
        serverSwitch.mode = 'audio';
        serverSwitch.answered = true;
        serverSwitch.refresh = async () => {};
      }
    }
  });

  it('does not ring for an invite that carries no window', async () => {
    const service = new CallService(fakeMls);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      invite(undefined),
      'me@example.org',
      'device-1'
    );
    expect(get(service.callState)).toBe('idle');
  });
});

/**
 * G1: the server's answer window opens at `POST /calls/ring`, so that request is load-bearing - a
 * refused ring leaves a callee nothing it could ever answer, and it is already ringing in-app.
 */
describe('the ring opens the server window', () => {
  /**
   * The window opens BEFORE anyone can learn of the call: a callee answering at once (a quick tap,
   * an auto-accept) must find the window open, never a 410 whose hangup would end a sound call.
   */
  it('opens the window before the invite leaves', async () => {
    const service = new CallService(fakeMls);
    await callerJoined(service);

    const ring = order.indexOf('api:/api/calls/ring');
    expect(ring).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('mls')).toBeGreaterThan(ring);
  });

  it('sends no invite, and writes no missed call, when the ring is refused', async () => {
    server.ringStatus = 410;
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);

    const started = service.startCall('group-1', false);
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1' });

    await expect(started).rejects.toThrow('calls/ring failed (410)');
    // The server opens the window before it fans out: a refused ring rang nobody.
    expect(order).not.toContain('mls');
    // Nobody was rung: the end carries no outcome, so no record is written.
    expect(chat.onCallEnded.mock.calls.every((c) => c[2] === undefined)).toBe(true);
  });

  it('does not invite, arm or publish presence for a call hung up while the ring was in flight', async () => {
    let releaseRing!: () => void;
    server.ringHold = new Promise((r) => (releaseRing = r));
    const { publishCallPresence } = await import('$lib/utils/callPresence');
    vi.mocked(publishCallPresence).mockClear();
    const service = new CallService(fakeMls);

    const started = service.startCall('group-1', false);
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1' });
    await vi.waitFor(() => expect(order).toContain('api:/api/calls/ring'));

    service.endCall();
    releaseRing();
    await started;

    // The hangup told the group (the ring may have reached devices); no invite followed it.
    expect(order.filter((o) => o === 'mls')).toHaveLength(1);
    expect(vi.mocked(publishCallPresence).mock.calls.some(([p]) => p.active)).toBe(false);
  });
});

/** G2: a callee answering after the window closed is told the call is over, not that it failed. */
describe('a late answer', () => {
  it('reads the room-token 410 as "this call is over"', async () => {
    server.roomTokenStatus = 410;
    const { showToast } = await import('$lib/stores/toast.svelte');
    vi.mocked(showToast).mockClear();
    const service = new CallService(fakeMls);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      {
        callId: 'room-1',
        offerSdp: 'START',
        hasVideo: false,
        deviceId: 'device-2',
        ringTimeoutMs: 60_000,
      },
      'me@example.org',
      'device-1'
    );

    await service.acceptCall('group-1', 'room-1');

    expect(showToast).toHaveBeenCalledWith(m.call_over(), 'warning');
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

/** A refused answer (a block set while the call rang) told nobody it was answered. */
describe('a refused answer', () => {
  it('asks for the token before sending the answered frame, so a refusal sends only the hangup', async () => {
    server.roomTokenStatus = 403;
    const service = new CallService(fakeMls);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      {
        callId: 'room-1',
        offerSdp: 'START',
        hasVideo: false,
        deviceId: 'device-2',
        ringTimeoutMs: 60_000,
      },
      'me@example.org',
      'device-1'
    );
    order.length = 0;

    await service.acceptCall('group-1', 'room-1');
    await settle();

    expect(order[0]).toBe('api:/api/calls/room-token');
    // The one MLS frame is the hangup; the answered frame never left.
    expect(order.filter((o) => o === 'mls')).toHaveLength(1);
    expect(order).not.toContain('api:/api/calls/ice-servers');
  });
});

/**
 * B7: a spent relay budget or an unreadable meter withholds TURN, never the call. The server answers
 * STUN only, typed; the client goes on with the direct path and says so at error.
 */
describe('a call whose TURN relay the server withheld', () => {
  it.each(['TURN_BUDGET_REACHED', 'TURN_METER_UNAVAILABLE'])(
    'still starts on the direct path, and logs %s at error',
    async (code) => {
      server.iceTurn = { status: 'unavailable', code };
      const { appendLog } = await import('$lib/utils/sessionLog');
      vi.mocked(appendLog).mockClear();
      const service = new CallService(fakeMls);

      await callerJoined(service);

      expect(order).toContain('api:/api/calls/ring');
      expect(vi.mocked(appendLog).mock.calls.map(([l]) => String(l))).toContain(
        `[Call] ERROR: TURN relay withheld by the server (${code}) - direct path only`
      );
      service.endCall();
    }
  );

  it('logs TURN off by configuration at info, never as an ERROR', async () => {
    server.iceTurn = { status: 'unavailable', code: 'TURN_DISABLED' };
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.mocked(appendLog).mockClear();
    const service = new CallService(fakeMls);

    await callerJoined(service);

    const lines = vi.mocked(appendLog).mock.calls.map(([l]) => String(l));
    expect(lines).toContain(
      '[Call] TURN relay disabled by the server (TURN_DISABLED) - direct path only'
    );
    expect(lines.some((l) => l.includes('ERROR') && l.includes('TURN'))).toBe(false);
    service.endCall();
  });

  it.each([
    [
      'withheld',
      { status: 'unavailable', code: 'TURN_BUDGET_REACHED' },
      () => m.call_relay_withheld(),
    ],
    ['disabled', { status: 'unavailable', code: 'TURN_DISABLED' }, () => m.call_relay_disabled()],
    ['available', { status: 'available' }, () => m.call_connection_lost()],
  ])('a call that never connects with the relay %s says so', async (_n, turn, sentence) => {
    server.iceTurn = turn;
    const { showToast } = await import('$lib/stores/toast.svelte');
    vi.mocked(showToast).mockClear();
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();

    FakePeerConnection.instances[0].setIce('failed');
    await settle();

    expect(showToast).toHaveBeenCalledWith(sentence(), 'error');
    expect(get(service.callState)).not.toBe('incall');
  });

  it('logs nothing of the kind when the relay is available', async () => {
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.mocked(appendLog).mockClear();
    const service = new CallService(fakeMls);

    await callerJoined(service);

    expect(
      vi.mocked(appendLog).mock.calls.some(([l]) => String(l).includes('TURN relay withheld'))
    ).toBe(false);
    service.endCall();
  });
});

/** F7: a call that failed before its invite rang nobody, so nothing was missed. */
describe('no missed call for a call that never rang', () => {
  it.each([
    ['the ICE servers are refused', () => (server.iceStatus = 503)],
    ['the initiate is refused', () => (server.initiateStatus = 403)],
  ])('writes no missed call when %s', async (_, arrange) => {
    arrange();
    const chat = { onCallStarted: vi.fn(), onCallEnded: vi.fn() };
    const service = new CallService(fakeMls);
    service.setChatNotifier(chat);

    await expect(service.startCall('group-1', false)).rejects.toThrow();

    expect(chat.onCallEnded.mock.calls.every((c) => c[2] === undefined)).toBe(true);
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

/**
 * CALL-WIFI (measured 2026-10-19 on the Mi 9T): a 6 s and a 14 s Wi-Fi outage each ended the call
 * on the first signalling close (`terminal failure: signalling WebSocket closed code=1006`). A
 * network blip is a TRANSPORT failure, so it is resumed; only an answer (a refused resume,
 * `PeerLeft`, the MLS hangup) or the attempt budget ends the call. The ladder is a timer by
 * nature: it is faked and stepped, never waited for.
 */
describe('a network blip does not end the call', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A caller whose call CONNECTED: joined with a resume token, paired, ICE connected, in call. */
  async function connectedCaller(service: CallService) {
    const started = service.startCall('group-1', false);
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-1' });
    await started;
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    const pc = FakePeerConnection.instances[0];
    pc.setIce('connected');
    pc.setConnection('connected');
    expect(get(service.callState)).toBe('incall');
    expect(get(service.reconnecting)).toBe(false);
    return { ws, pc };
  }

  /** The delay before resume attempt `n` (1-based), on the call's CAPPED ladder. */
  const resumeDelay = (n: number) =>
    cappedReconnectDelayMs(n - 1, CALL_SIGNALLING_RESUME_MAX_DELAY_MS);

  /** Steps the ladder to resume attempt `n` (1-based) and returns the socket it opened. */
  async function resumeAttempt(n: number) {
    const before = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(resumeDelay(n));
    await settle();
    expect(FakeSocket.instances).toHaveLength(before + 1);
    return FakeSocket.instances[before];
  }

  /** The other party's answer to this side's latest offer, through the relay. */
  async function answer(ws: FakeSocket) {
    ws.deliver({ type: 'Answer', sdp: JSON.stringify({ type: 'answer', sdp: 'v=0 answer' }) });
    await settle();
  }

  /** Moves ICE and lets the restart it may trigger (an async offer) be sent. */
  async function ice(pc: FakePeerConnection, state: RTCIceConnectionState) {
    pc.setIce(state);
    await settle();
  }

  it('resumes the seat with its token, keeps the peer connection, and the initiator restarts ICE', async () => {
    const service = new CallService(fakeMls);
    const { pc } = await connectedCaller(service);

    FakeSocket.instances[0].drop();
    expect(get(service.callState)).toBe('incall');
    expect(get(service.reconnecting)).toBe(true);
    // The media path goes down with the network; no restart while the relay cannot carry it.
    await ice(pc, 'disconnected');
    expect(pc.restarts).toBe(0);

    const ws2 = await resumeAttempt(1);
    ws2.open();
    expect(ws2.sent[0]).toEqual({
      type: 'Join',
      room_id: 'room-1',
      room_token: 'resume-1',
      mode: 'p2p',
    });
    ws2.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-2' });
    ws2.deliver({ type: 'PeerReady', initiator: true, resumed: true });
    await settle();

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(pc.closed).toBe(false);
    expect(pc.restarts).toBe(1);
    // The restart's offer goes out at once, on the NEW socket.
    expect(ws2.framesOfType('Offer')).toHaveLength(1);
    expect(get(service.reconnecting)).toBe(true);

    await answer(ws2);
    await ice(pc, 'connected');
    expect(get(service.reconnecting)).toBe(false);
    expect(get(service.callState)).toBe('incall');

    // The NEXT drop resumes with the token of the latest Joined.
    ws2.drop();
    const ws3 = await resumeAttempt(1);
    ws3.open();
    expect(ws3.sent[0]).toMatchObject({ type: 'Join', room_token: 'resume-2' });
  });

  it('caps the resume ladder at 4 s: a call cannot wait 8 or 16 s for a network that is back', () => {
    const delays = Array.from({ length: CALL_SIGNALLING_RESUME_ATTEMPTS }, (_, i) =>
      resumeDelay(i + 1)
    );
    expect(delays.slice(0, 5)).toEqual([1000, 2000, 4000, 4000, 4000]);
    expect(Math.max(...delays)).toBe(CALL_SIGNALLING_RESUME_MAX_DELAY_MS);
    // The last attempt still starts inside the relay's 60 s seat grace.
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThan(60_000);
  });

  it('retries a resume that fails in transport, on the capped ladder, and ends only when the attempt budget is spent', async () => {
    const { showToast } = await import('$lib/stores/toast.svelte');
    vi.mocked(showToast).mockClear();
    const service = new CallService(fakeMls);
    await connectedCaller(service);

    FakeSocket.instances[0].drop();
    for (let n = 1; n <= CALL_SIGNALLING_RESUME_ATTEMPTS; n++) {
      const ws = await resumeAttempt(n);
      // Still offline: the socket never opens.
      ws.drop();
      await settle();
      if (n < CALL_SIGNALLING_RESUME_ATTEMPTS) {
        expect(get(service.callState)).toBe('incall');
        expect(get(service.reconnecting)).toBe(true);
      }
    }

    expect(get(service.callState)).toBe('ended');
    expect(get(service.reconnecting)).toBe(false);
    expect(showToast).toHaveBeenCalledWith(m.call_connection_lost(), 'error');
    // One socket per attempt, and no more once the budget is spent.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1 + CALL_SIGNALLING_RESUME_ATTEMPTS);
  });

  it('ends the call at once when the relay ANSWERS that the seat is gone', async () => {
    const service = new CallService(fakeMls);
    await connectedCaller(service);

    FakeSocket.instances[0].drop();
    const ws2 = await resumeAttempt(1);
    ws2.open();
    ws2.deliver({ type: 'Refused', reason: 'call-over' });
    await settle();

    expect(['ended', 'idle']).toContain(get(service.callState));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('a relay without the resume protocol (no token) still ends the call on a drop, and says why', async () => {
    const { appendLog } = await import('$lib/utils/sessionLog');
    const service = new CallService(fakeMls);
    const started = service.startCall('group-1', false);
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1' });
    await started;

    ws.drop();

    expect(get(service.callState)).toBe('ended');
    expect(vi.mocked(appendLog).mock.calls.map(([l]) => l)).toContain(
      '[Call] terminal failure: signalling WebSocket closed code=1006 and the relay gave no resume token - ending call'
    );
  });

  it('shows the other party reconnecting on PeerAway, and ends only on PeerLeft', async () => {
    const service = new CallService(fakeMls);
    const { ws } = await connectedCaller(service);

    ws.deliver({ type: 'PeerAway' });
    await settle();
    expect(get(service.callState)).toBe('incall');
    expect(get(service.reconnecting)).toBe(true);

    ws.deliver({ type: 'PeerLeft' });
    await settle();
    expect(get(service.callState)).toBe('ended');
    expect(get(service.reconnecting)).toBe(false);
  });

  it('defers the ICE restart while the other party is away, and makes it when it comes back', async () => {
    const service = new CallService(fakeMls);
    const { ws, pc } = await connectedCaller(service);

    ws.deliver({ type: 'PeerAway' });
    await settle();
    await ice(pc, 'failed');
    expect(pc.restarts).toBe(0);
    expect(get(service.callState)).toBe('incall');

    ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
    await settle();
    expect(pc.restarts).toBe(1);
    expect(ws.framesOfType('Offer')).toHaveLength(1);
    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it('restarts ICE on a lost media path while signalling holds, one offer at a time, and ends after the restart budget', async () => {
    const service = new CallService(fakeMls);
    const { ws, pc } = await connectedCaller(service);

    // `disconnected` triggers the first restart; each later one needs the path to report `failed`
    // AFTER the previous offer was answered - one offer in flight, its answer a relay away.
    await ice(pc, 'disconnected');
    expect(pc.restarts).toBe(1);
    await ice(pc, 'disconnected');
    await ice(pc, 'failed');
    expect(pc.restarts).toBe(1);
    for (let n = 2; n <= CALL_ICE_RESTART_ATTEMPTS; n++) {
      await answer(ws);
      await ice(pc, 'failed');
      expect(pc.restarts).toBe(n);
      expect(get(service.callState)).toBe('incall');
    }
    await answer(ws);
    await ice(pc, 'failed');
    expect(pc.restarts).toBe(CALL_ICE_RESTART_ATTEMPTS);
    expect(get(service.callState)).toBe('ended');
  });

  it('acts on connectionState=failed when ICE itself stays disconnected (Android Chromium)', async () => {
    const service = new CallService(fakeMls);
    const { ws, pc } = await connectedCaller(service);

    await ice(pc, 'disconnected');
    expect(pc.restarts).toBe(1);
    await answer(ws);
    pc.setConnection('failed');
    await settle();
    expect(pc.iceConnectionState).toBe('disconnected');
    expect(pc.restarts).toBe(2);
    expect(ws.framesOfType('Offer')).toHaveLength(2);
  });

  it('a reconnected media path resets the restart budget', async () => {
    const service = new CallService(fakeMls);
    const { ws, pc } = await connectedCaller(service);

    for (let loss = 0; loss < CALL_ICE_RESTART_ATTEMPTS + 2; loss++) {
      await ice(pc, 'failed');
      await answer(ws);
      await ice(pc, 'connected');
    }
    expect(get(service.callState)).toBe('incall');
    expect(pc.restarts).toBe(CALL_ICE_RESTART_ATTEMPTS + 2);
  });

  /** The callee of a connected call: polite, joined with a resume token, ICE connected. */
  async function connectedCallee(service: CallService) {
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      {
        callId: 'room-1',
        offerSdp: 'START',
        hasVideo: false,
        deviceId: 'device-2',
        ringTimeoutMs: 60_000,
      },
      'me@example.org',
      'device-1'
    );
    const accepted = service.acceptCall('group-1', 'room-1');
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-b' });
    await accepted;
    ws.deliver({ type: 'PeerReady', initiator: false });
    await settle();
    const pc = FakePeerConnection.instances[0];
    pc.setIce('connected');
    pc.setConnection('connected');
    return { ws, pc };
  }

  /** The initiator's (restart) offer reaching the polite side. */
  async function offer(ws: FakeSocket) {
    ws.deliver({ type: 'Offer', sdp: JSON.stringify({ type: 'offer', sdp: 'v=0 ice-restart' }) });
    await settle();
  }

  it('the polite side never restarts ICE itself: it ASKS the initiator, one request at a time, on its own budget', async () => {
    const service = new CallService(fakeMls);
    const { ws, pc } = await connectedCallee(service);

    await ice(pc, 'disconnected');
    expect(ws.framesOfType('IceRestartRequest')).toHaveLength(1);
    // Until the initiator's offer arrives, a second loss event asks nothing more.
    await ice(pc, 'failed');
    expect(ws.framesOfType('IceRestartRequest')).toHaveLength(1);
    for (let n = 2; n <= CALL_ICE_RESTART_ATTEMPTS; n++) {
      await offer(ws);
      await ice(pc, 'failed');
      expect(ws.framesOfType('IceRestartRequest')).toHaveLength(n);
      expect(get(service.callState)).toBe('incall');
    }
    expect(pc.restarts).toBe(0);
    expect(ws.framesOfType('Offer')).toHaveLength(0);
    expect(get(service.reconnecting)).toBe(true);

    // The initiator never brought the path back: the polite side's budget ends the call.
    await offer(ws);
    await ice(pc, 'failed');
    expect(ws.framesOfType('IceRestartRequest')).toHaveLength(CALL_ICE_RESTART_ATTEMPTS);
    expect(get(service.callState)).toBe('ended');
  });

  it('the initiator honours a restart request even while its own path looks connected', async () => {
    const service = new CallService(fakeMls);
    const { ws, pc } = await connectedCaller(service);

    ws.deliver({ type: 'IceRestartRequest' });
    await settle();
    expect(pc.restarts).toBe(1);

    // Both sides saw the loss: a request arriving while this pairing's offer is in flight adds none.
    ws.deliver({ type: 'IceRestartRequest' });
    await settle();
    expect(pc.restarts).toBe(1);

    // Answered, and still not healed: the next request is honoured, and the budget ends a loop.
    await answer(ws);
    ws.deliver({ type: 'IceRestartRequest' });
    await settle();
    expect(pc.restarts).toBe(2);
    await answer(ws);
    await ice(pc, 'failed');
    expect(pc.restarts).toBe(CALL_ICE_RESTART_ATTEMPTS);
    await answer(ws);
    await ice(pc, 'failed');
    expect(get(service.callState)).toBe('ended');
  });

  it('a resume attempt stuck before its Joined counts as ONE failed attempt at its deadline', async () => {
    const service = new CallService(fakeMls);
    await connectedCaller(service);

    FakeSocket.instances[0].drop();
    const stuck = await resumeAttempt(1);
    // Never opens (a black-holed network): the deadline fails the attempt and arms the next.
    await vi.advanceTimersByTimeAsync(CALL_SIGNALLING_RESUME_TIMEOUT_MS);
    await settle();
    expect(stuck.readyState).toBe(3);
    expect(get(service.callState)).toBe('incall');
    // Opened but never joined: the SAME deadline covers it.
    const opened = await resumeAttempt(2);
    opened.open();
    await vi.advanceTimersByTimeAsync(CALL_SIGNALLING_RESUME_TIMEOUT_MS);
    await settle();
    expect(opened.readyState).toBe(3);
    // The third attempt joins: the call goes on.
    const ws = await resumeAttempt(3);
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-3' });
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(get(service.callState)).toBe('incall');
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('a path that NEVER connected still ends the call on ICE failed - there is nothing to restore', async () => {
    const service = new CallService(fakeMls);
    const started = service.startCall('group-1', false);
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-1' });
    await started;
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    const pc = FakePeerConnection.instances[0];

    await ice(pc, 'failed');

    expect(pc.restarts).toBe(0);
    expect(['ended', 'idle']).toContain(get(service.callState));
  });

  /** CALL-GATHER-0: a gathering cut short by a working direct pair is not a TURN fault. */
  describe('the no-relay WARN accuses only a call that settled with no working pair', () => {
    async function callWithRelayGap() {
      const service = new CallService(fakeMls);
      const started = service.startCall('group-1', false);
      await settle();
      const ws = FakeSocket.instances[0];
      ws.open();
      ws.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-1' });
      await started;
      ws.deliver({ type: 'PeerReady', initiator: true });
      await settle();
      const pc = FakePeerConnection.instances[0];
      const { appendLog } = await import('$lib/utils/sessionLog');
      vi.mocked(appendLog).mockClear();
      // Gathering ends with host candidates only, ICE still checking.
      pc.iceConnectionState = 'checking';
      const onCandidate = pc.onicecandidate as unknown as (e: {
        candidate: RTCIceCandidate | null;
      }) => void;
      onCandidate({ candidate: { type: 'host' } as RTCIceCandidate });
      onCandidate({ candidate: null });
      const warned = () =>
        vi
          .mocked(appendLog)
          .mock.calls.some(([l]) => String(l).includes('WARN no TURN relay candidate'));
      return { pc, warned };
    }

    it('is silent when the direct pair then connects', async () => {
      const { pc, warned } = await callWithRelayGap();
      expect(warned()).toBe(false);
      await ice(pc, 'connected');
      expect(warned()).toBe(false);
    });

    it('warns when ICE then fails without ever connecting', async () => {
      const { pc, warned } = await callWithRelayGap();
      await ice(pc, 'failed');
      expect(warned()).toBe(true);
    });
  });

  /**
   * The three outages of the 2026-10-19 bench reading of `1.3.1-alpha.2`, replayed. The Mi 9T is
   * the POLITE callee whose Wi-Fi goes off; the iPhone is the INITIATOR, whose own socket never
   * drops. Each side is driven alone, with the frames the relay sends it in that outage.
   */
  describe('the bench outages of 2026-10-19, replayed', () => {
    /** Steps attempts `from..to`, each refused at once by a network that is still off. */
    async function failAttempts(from: number, to: number) {
      for (let n = from; n <= to; n++) {
        const ws = await resumeAttempt(n);
        ws.drop();
        await settle();
      }
    }

    it('6 s (PASS on alpha.2, kept): the media came back on its own, so nothing is restarted', async () => {
      const service = new CallService(fakeMls);
      const { pc } = await connectedCallee(service);
      pc.inboundPackets = 300;

      FakeSocket.instances[0].drop();
      await ice(pc, 'disconnected');
      await failAttempts(1, 2); // +1 s, +3 s: still off
      // The network is back at +6 s: ICE heals on its own and audio flows again.
      pc.inboundPackets = 420;
      await ice(pc, 'connected');
      const ws = await resumeAttempt(3); // +7 s
      ws.open();
      ws.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-c' });
      ws.deliver({ type: 'PeerReady', initiator: false, resumed: true });
      await settle();

      expect(ws.framesOfType('IceRestartRequest')).toHaveLength(0);
      expect(get(service.reconnecting)).toBe(false);
      expect(get(service.callState)).toBe('incall');
    });

    it('14 s, the Mi (polite): resumed at +15 s, finds no packet since the break, and ASKS for the restart that brings the audio back', async () => {
      const service = new CallService(fakeMls);
      const { pc } = await connectedCallee(service);
      pc.inboundPackets = 300;

      FakeSocket.instances[0].drop();
      await ice(pc, 'disconnected');
      pc.setConnection('failed');
      await settle();
      expect(get(service.callState)).toBe('incall');

      await failAttempts(1, 4); // +1, +3, +7, +11 s
      const ws = await resumeAttempt(5); // +15 s - was +31 s on the uncapped ladder
      expect([1, 2, 3, 4, 5].reduce((t, n) => t + resumeDelay(n), 0)).toBe(15_000);
      ws.open();
      ws.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-c' });
      ws.deliver({ type: 'PeerReady', initiator: false, resumed: true });
      await settle();

      // Not one packet arrived across the outage: the polite side asks, on the NEW socket.
      expect(ws.framesOfType('IceRestartRequest')).toHaveLength(1);
      expect(get(service.reconnecting)).toBe(true);
      // The initiator's restart offer arrives and is answered; ICE reconnects; audio is back.
      await offer(ws);
      expect(ws.framesOfType('Answer')).toHaveLength(1);
      pc.inboundPackets = 360;
      pc.setConnection('connected');
      await ice(pc, 'connected');
      expect(get(service.reconnecting)).toBe(false);
      expect(get(service.callState)).toBe('incall');
    });

    it('14 s, the iPhone (initiator): its first restart offer died in the dead socket; on the resume it rolls it back and offers again', async () => {
      const service = new CallService(fakeMls);
      const { ws, pc } = await connectedCaller(service);
      pc.inboundPackets = 500;

      // The path drops; the restart offer goes to the relay, which hands it to the Mi's DEAD
      // socket. Nothing answers it: the connection is left in `have-local-offer`.
      await ice(pc, 'disconnected');
      await ice(pc, 'failed');
      expect(pc.restarts).toBe(1);
      expect(pc.signalingState).toBe('have-local-offer');

      // The Mi resumes before the relay held its old socket dead: no PeerAway, straight PeerReady.
      ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
      await settle();
      expect(pc.rollbacks).toBe(1);
      expect(pc.restarts).toBe(2);
      expect(ws.framesOfType('Offer')).toHaveLength(2);

      // The Mi's own request crosses that offer: it is not a second restart.
      ws.deliver({ type: 'IceRestartRequest' });
      await settle();
      expect(pc.restarts).toBe(2);

      await answer(ws);
      expect(pc.signalingState).toBe('stable');
      await ice(pc, 'connected');
      expect(get(service.reconnecting)).toBe(false);
      expect(get(service.callState)).toBe('incall');
    });

    it('a stale answer to a rolled-back offer is dropped, never a call failure', async () => {
      const service = new CallService(fakeMls);
      const { ws, pc } = await connectedCaller(service);

      await ice(pc, 'disconnected');
      await answer(ws);
      await answer(ws); // a second answer: nothing of ours is pending
      expect(get(service.callState)).toBe('incall');
      expect(pc.signalingState).toBe('stable');
    });

    it('90 s, the Mi: gives up by its attempt budget, inside the relay grace', async () => {
      const service = new CallService(fakeMls);
      await connectedCallee(service);

      FakeSocket.instances[0].drop();
      await failAttempts(1, CALL_SIGNALLING_RESUME_ATTEMPTS);

      expect(get(service.callState)).toBe('ended');
      expect(get(service.reconnecting)).toBe(false);
    });

    it('90 s, the iPhone: told PeerAway once the relay holds the Mi dead, then PeerLeft at the grace - and the call ENDS', async () => {
      const service = new CallService(fakeMls);
      const { ws, pc } = await connectedCaller(service);

      await ice(pc, 'disconnected');
      await ice(pc, 'failed');
      // Within 30 s: the Mi answered no keepalive ping (`keepalive-lost`), its seat goes away.
      ws.deliver({ type: 'PeerAway' });
      await settle();
      expect(get(service.reconnecting)).toBe(true);
      await ice(pc, 'failed');
      expect(pc.restarts).toBe(1);

      // 60 s later the seat's grace runs out: the relay ANSWERS, and the screen leaves "Reconnexion...".
      ws.deliver({ type: 'PeerLeft' });
      await settle();
      expect(get(service.callState)).toBe('ended');
      expect(get(service.reconnecting)).toBe(false);
    });

    /** The number the latest offer this side sent carries. */
    const lastOfferSeq = (ws: FakeSocket) =>
      (JSON.parse(ws.framesOfType('Offer').at(-1)!.sdp as string) as { seq: number }).seq;
    /** The peer's answer to offer `seq`, numbered as a current client numbers it. */
    const answerTo = (seq: number) => ({
      type: 'Answer',
      sdp: JSON.stringify({ type: 'answer', sdp: `v=0 answer #${seq}`, seq }),
    });

    it('with every description operation ASYNCHRONOUS, a late answer to the rolled-back offer never fails the call nor pairs with its replacement, whenever it lands', async () => {
      // The answer to the offer that went into the dead socket is delivered at EVERY point of the
      // resume: before, during and after the rollback and the new offer. Only the queue and the
      // offer number keep it from an InvalidStateError or from being applied to the new offer.
      for (let turns = 0; turns <= 24; turns += 2) {
        FakeSocket.instances = [];
        FakePeerConnection.instances = [];
        const service = new CallService(fakeMls);
        const { ws, pc } = await connectedCaller(service);
        await ice(pc, 'disconnected');
        const lost = lastOfferSeq(ws);
        // Longer than the queue's hand-off between two steps, so a step run BESIDE the queue
        // overlaps the rollback (measured: at 3 turns a bypass of the queue went unnoticed; at 8,
        // turning `enqueueIceRestartOffer` into a direct call fails this test, as does removing
        // the offer-number check).
        pc.latency = 8;

        ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
        for (let i = 0; i < turns; i++) await Promise.resolve();
        ws.deliver(answerTo(lost));
        await settle();

        expect(get(service.callState), `turns=${turns}`).toBe('incall');
        const latest = lastOfferSeq(ws);
        expect(latest, `turns=${turns}`).toBeGreaterThan(lost);
        expect(pc.signalingState, `turns=${turns}`).toBe('have-local-offer');
        ws.deliver(answerTo(latest));
        await settle();
        expect(pc.signalingState, `turns=${turns}`).toBe('stable');
        expect(pc.remoteDescription?.sdp, `turns=${turns}`).toBe(`v=0 answer #${latest}`);
        service.endCall();
      }
    });

    it('an answer to an earlier offer is dropped while a later one is pending', async () => {
      const service = new CallService(fakeMls);
      const { ws, pc } = await connectedCaller(service);
      await ice(pc, 'disconnected');
      const lost = lastOfferSeq(ws);
      ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
      await settle();
      expect(pc.rollbacks).toBe(1);

      ws.deliver(answerTo(lost));
      await settle();
      expect(pc.signalingState).toBe('have-local-offer');
      expect(get(service.callState)).toBe('incall');
    });

    it('the polite side answers with the number of the offer it answers', async () => {
      const service = new CallService(fakeMls);
      const { ws } = await connectedCallee(service);
      ws.deliver({
        type: 'Offer',
        sdp: JSON.stringify({ type: 'offer', sdp: 'v=0 ice-restart', seq: 7 }),
      });
      await settle();
      const answer = JSON.parse(ws.framesOfType('Answer').at(-1)!.sdp as string);
      expect(answer).toMatchObject({ type: 'answer', seq: 7 });
    });

    it('an engine that cannot CREATE the restart offer ends the call, and says why', async () => {
      const { appendLog } = await import('$lib/utils/sessionLog');
      const service = new CallService(fakeMls);
      const { pc } = await connectedCaller(service);
      pc.offerError = new Error('OperationError: refused');

      await ice(pc, 'disconnected');

      expect(get(service.callState)).toBe('ended');
      expect(vi.mocked(appendLog).mock.calls.map(([l]) => l)).toContain(
        '[Call] terminal failure: ICE restart offer could not be made: Error: OperationError: refused - ending call'
      );
    });

    it('a peer that keeps dropping its signalling cannot restart for ever: the budget counts per media loss, across pairings', async () => {
      const service = new CallService(fakeMls);
      const { ws, pc } = await connectedCaller(service);

      await ice(pc, 'failed');
      expect(pc.restarts).toBe(1);
      for (let flap = 2; flap <= CALL_ICE_RESTART_ATTEMPTS; flap++) {
        ws.deliver({ type: 'PeerAway' });
        ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
        await settle();
        expect(pc.restarts).toBe(flap);
        expect(get(service.callState)).toBe('incall');
      }
      // The path never came back across three pairings: the next one ends the call.
      ws.deliver({ type: 'PeerAway' });
      ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
      await settle();
      expect(pc.restarts).toBe(CALL_ICE_RESTART_ATTEMPTS);
      expect(get(service.callState)).toBe('ended');
    });

    it('a restart that WORKED is refunded on packet evidence, even when ICE never left connected: four blips do not end a call', async () => {
      const service = new CallService(fakeMls);
      const { ws, pc } = await connectedCaller(service);
      pc.inboundPackets = 100;

      for (let blip = 1; blip <= CALL_ICE_RESTART_ATTEMPTS + 1; blip++) {
        // The Mi drops its signalling; ICE on this side never leaves `connected`.
        ws.deliver({ type: 'PeerAway' });
        await settle();
        ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
        await settle();
        // No packet across the outage: the evidence forces a restart.
        expect(pc.restarts, `blip ${blip}`).toBe(blip);
        await answer(ws);
        // The restart worked: audio flows again, ICE still reads `connected` throughout.
        pc.inboundPackets += 50;
        expect(pc.iceConnectionState).toBe('connected');
        expect(get(service.callState), `blip ${blip}`).toBe('incall');
      }
    });

    it('a restart dropped before it was sent (its pairing broke while it queued) costs no budget', async () => {
      const service = new CallService(fakeMls);
      const { ws, pc } = await connectedCaller(service);

      // The request is decided, then queued behind the PeerAway that arrived in the same tick:
      // when its turn comes the pairing is gone, and it is dropped unsent.
      ws.deliver({ type: 'IceRestartRequest' });
      ws.deliver({ type: 'PeerAway' });
      await settle();
      expect(pc.restarts).toBe(0);
      ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
      await settle();

      // The WHOLE budget is still there: three restarts go out before the fourth loss ends it.
      for (let n = 1; n <= CALL_ICE_RESTART_ATTEMPTS; n++) {
        await ice(pc, 'failed');
        expect(pc.restarts).toBe(n);
        expect(get(service.callState)).toBe('incall');
        await answer(ws);
      }
      await ice(pc, 'failed');
      expect(get(service.callState)).toBe('ended');
    });

    it('steps queued for the SAME call, arriving after its hangup, are dropped SILENTLY and fail nothing', async () => {
      const { appendLog } = await import('$lib/utils/sessionLog');
      const service = new CallService(fakeMls);
      const { ws, pc } = await connectedCaller(service);
      pc.latency = 8;

      // An ordinary hangup: the MLS hangup ends the call, and the relay's frames - a PeerLeft
      // among them - still arrive. They are expected, so no line names them.
      ws.deliver({ type: 'IceRestartRequest' });
      ws.deliver({ type: 'IceRestartRequest' });
      ws.deliver({ type: 'PeerLeft' });
      vi.mocked(appendLog).mockClear();
      service.endCall();
      await settle();

      const lines = vi.mocked(appendLog).mock.calls.map(([l]) => l as string);
      expect(lines.filter((l) => l.includes('dropped - the call is now'))).toHaveLength(0);
      expect(lines.some((l) => l.includes('terminal failure'))).toBe(false);
      expect(get(service.callState)).toBe('ended');
    });

    it('steps that outlived their call into the next state (cleaned up) are dropped and logged ONCE', async () => {
      const { appendLog } = await import('$lib/utils/sessionLog');
      const service = new CallService(fakeMls);
      const { ws } = await connectedCaller(service);

      ws.deliver({ type: 'IceRestartRequest' });
      ws.deliver({ type: 'PeerLeft' });
      vi.mocked(appendLog).mockClear();
      service.endCall();
      // The ended summary's 1.5 s passes BEFORE the queued steps get their turn (synchronous
      // advance: no microtask runs), so they meet a different call - none.
      vi.advanceTimersByTime(2_000);
      expect(get(service.callState)).toBe('idle');
      await settle();

      const lines = vi.mocked(appendLog).mock.calls.map(([l]) => l as string);
      expect(lines.filter((l) => l.includes('dropped - the call is now none'))).toHaveLength(1);
      expect(lines.some((l) => l.includes('terminal failure'))).toBe(false);
    });

    it('no refund without evidence: unreadable stats across a resume give nothing back', async () => {
      const service = new CallService(fakeMls);
      const { ws, pc } = await connectedCaller(service);
      expect(pc.inboundPackets).toBeNull();

      await ice(pc, 'disconnected');
      expect(pc.restarts).toBe(1);
      await answer(ws);
      // ICE recovers without the browser saying so (no transition event): only evidence refunds.
      pc.iceConnectionState = 'connected';
      ws.deliver({ type: 'PeerAway' });
      ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
      await settle();
      expect(pc.restarts).toBe(1);

      // The first restart is still charged: two more, then the call ends.
      for (let n = 2; n <= CALL_ICE_RESTART_ATTEMPTS; n++) {
        await ice(pc, 'failed');
        expect(pc.restarts).toBe(n);
        await answer(ws);
      }
      await ice(pc, 'failed');
      expect(get(service.callState)).toBe('ended');
    });
  });
});

/**
 * THE OS TAKING THE MICROPHONE (WP-C-BG-I, CALL-IOS-MIC-HIDDEN): measured on the iPhone, locked or in
 * the background, the capture track goes `muted` while the call and its WebRTC stack keep running -
 * the partner hears nothing and, before this, nothing said why. The sender tells the partner over
 * the relay; each pairing rebuilds that state from the sender's own truth.
 */
describe('a microphone the system took', () => {
  /** A capture track whose `mute` / `unmute` the OS fires - an EventTarget, as the real one is. */
  class FakeMic extends EventTarget {
    kind = 'audio';
    enabled = true;
    muted = false;
    readyState = 'live';
    stop = vi.fn();
    systemTakes() {
      this.muted = true;
      this.dispatchEvent(new Event('mute'));
    }
    systemGivesBack() {
      this.muted = false;
      this.dispatchEvent(new Event('unmute'));
    }
  }

  let mic: FakeMic;
  beforeEach(() => {
    mic = new FakeMic();
    const stream = {
      getTracks: () => [mic],
      getVideoTracks: () => [],
      getAudioTracks: () => [mic],
    };
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });
  });

  async function pairedCaller(service: CallService) {
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    return ws;
  }

  it('tells the other party when the system takes the microphone and when it gives it back', async () => {
    const { showToast } = await import('$lib/stores/toast.svelte');
    vi.mocked(showToast).mockClear();
    const service = new CallService(fakeMls);
    const ws = await pairedCaller(service);

    mic.systemTakes();
    expect(get(service.localMicSuspended)).toBe(true);
    expect(ws.framesOfType('MicSuspended')).toEqual([{ type: 'MicSuspended', suspended: true }]);
    // Not the user's mute: the button state is untouched.
    expect(get(service.isMuted)).toBe(false);

    mic.systemGivesBack();
    expect(get(service.localMicSuspended)).toBe(false);
    expect(ws.framesOfType('MicSuspended').at(-1)).toEqual({
      type: 'MicSuspended',
      suspended: false,
    });
    // The screen was hidden while it lasted: the user is told on the way back.
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('shows what the other party said, and clears it when it says the microphone is back', async () => {
    const service = new CallService(fakeMls);
    const ws = await pairedCaller(service);

    ws.deliver({ type: 'MicSuspended', suspended: true });
    await settle();
    expect(get(service.peerMicSuspended)).toBe(true);
    ws.deliver({ type: 'MicSuspended', suspended: false });
    await settle();
    expect(get(service.peerMicSuspended)).toBe(false);
  });

  it('says nothing before the pairing, and announces a microphone still held when the pair forms', async () => {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);

    mic.systemTakes();
    expect(get(service.localMicSuspended)).toBe(true);
    expect(ws.framesOfType('MicSuspended')).toHaveLength(0);

    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    expect(ws.framesOfType('MicSuspended')).toEqual([{ type: 'MicSuspended', suspended: true }]);
  });

  it("forgets the other party's report at a new pairing: a `false` lost with a socket cannot leave it stuck", async () => {
    const service = new CallService(fakeMls);
    const ws = await pairedCaller(service);
    ws.deliver({ type: 'MicSuspended', suspended: true });
    await settle();
    expect(get(service.peerMicSuspended)).toBe(true);

    ws.deliver({ type: 'PeerReady', initiator: true, resumed: true });
    await settle();
    expect(get(service.peerMicSuspended)).toBe(false);
  });

  it("clears the other party's report when it goes away: no fresh evidence, no claim", async () => {
    const service = new CallService(fakeMls);
    const ws = await pairedCaller(service);
    ws.deliver({ type: 'MicSuspended', suspended: true });
    await settle();
    expect(get(service.peerMicSuspended)).toBe(true);

    ws.deliver({ type: 'PeerAway' });
    await settle();
    expect(get(service.peerMicSuspended)).toBe(false);
  });

  it('names the state a dead socket could not carry, and re-announces it after a RESUMED pairing', async () => {
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const service = new CallService(fakeMls);
      const started = service.startCall('group-1', false);
      await settle();
      const ws = FakeSocket.instances[0];
      ws.open();
      ws.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-1' });
      await started;
      ws.deliver({ type: 'PeerReady', initiator: true });
      await settle();
      const pc = FakePeerConnection.instances[0];
      pc.setIce('connected');
      pc.setConnection('connected');

      ws.drop();
      vi.mocked(appendLog).mockClear();
      mic.systemTakes();
      expect(get(service.localMicSuspended)).toBe(true);
      expect(ws.framesOfType('MicSuspended')).toHaveLength(0);
      expect(
        vi
          .mocked(appendLog)
          .mock.calls.some(([line]) =>
            /\[Call\] signalling MicSuspended NOT sent - socket/.test(String(line))
          )
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(
        cappedReconnectDelayMs(0, CALL_SIGNALLING_RESUME_MAX_DELAY_MS)
      );
      await settle();
      const ws2 = FakeSocket.instances[1];
      ws2.open();
      ws2.deliver({ type: 'Joined', room_id: 'room-1', resume_token: 'resume-2' });
      ws2.deliver({ type: 'PeerReady', initiator: true, resumed: true });
      await settle();
      expect(ws2.framesOfType('MicSuspended')).toEqual([{ type: 'MicSuspended', suspended: true }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a track handed over already muted counts from the start', async () => {
    mic.muted = true;
    const service = new CallService(fakeMls);
    await callerJoined(service);
    expect(get(service.localMicSuspended)).toBe(true);
  });

  it('leaves no state and no listener behind when the call ends', async () => {
    const service = new CallService(fakeMls);
    const ws = await pairedCaller(service);
    mic.systemTakes();
    ws.deliver({ type: 'MicSuspended', suspended: true });
    await settle();

    service.endCall();
    await settle();
    expect(get(service.localMicSuspended)).toBe(false);
    expect(get(service.peerMicSuspended)).toBe(false);
    const sentBefore = ws.sent.length;
    mic.systemGivesBack();
    expect(ws.sent.length).toBe(sentBefore);
  });
});

/**
 * THE FIRST PRODUCTION CALLS ARE AUDIO ONLY (owner, 2026-10-21), and hiding the video button is not
 * what holds that: an invite with `hasVideo: true` - from a modified client, or later from a build
 * with video - reaches an audio-only build too, and accepting it used to open the camera with no
 * control on screen to close it. Every camera open is refused at the service.
 */
describe('an audio-only build (CALLS_VIDEO_ENABLED off)', () => {
  beforeEach(() => {
    features.CALLS_VIDEO_ENABLED = false;
  });
  afterEach(() => {
    features.CALLS_VIDEO_ENABLED = true;
  });

  const videoAsked = () =>
    vi
      .mocked(navigator.mediaDevices.getUserMedia)
      .mock.calls.filter(([c]) => !!(c as MediaStreamConstraints).video);

  it('accepts a VIDEO invite as an audio call and never asks for a camera', async () => {
    const service = new CallService(fakeMls);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      {
        callId: 'room-1',
        offerSdp: 'START',
        hasVideo: true,
        deviceId: 'device-2',
        ringTimeoutMs: 60_000,
      },
      'me@example.org',
      'device-1'
    );
    expect(service.incomingHasVideo).toBe(false);

    // Even an explicit `video: true` from a caller of the API.
    const accepted = service.acceptCall('group-1', 'room-1', true);
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1' });
    await accepted;

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    expect(videoAsked()).toHaveLength(0);
    expect(cameras).toHaveLength(0);
  });

  it('places an audio call when asked for video, and the invite says no video', async () => {
    const service = new CallService(fakeMls);
    const started = service.startCall('group-1', true);
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1' });
    await started;

    expect(videoAsked()).toHaveLength(0);
    const { apiFetch } = await import('$lib/utils/apiFetch');
    const ring = vi
      .mocked(apiFetch)
      .mock.calls.find(([url]) => String(url).includes('/calls/ring'));
    expect(JSON.parse(String((ring![1] as RequestInit).body)).hasVideo).toBe(false);
  });

  it('never opens the camera from the call screen', async () => {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();

    await service.toggleVideo();
    expect(videoAsked()).toHaveLength(0);
    expect(FakePeerConnection.instances[0].senders.filter((x) => x.track)).toHaveLength(1);
  });

  it("receives the peer's video under its transforms and never shows it", async () => {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    const pc = FakePeerConnection.instances[0];

    const created = pc.remoteOfferAdds('video');
    // Decrypted, so the E2E path check still judges this m-line rather than ending the call.
    expect((created.receiver.transform as FakeTransform).options.side).toBe('receiver');
    const shown = get(service.remoteStream)?.getTracks() ?? [];
    expect(shown.some((t) => (t as MediaStreamTrack).kind === 'video')).toBe(false);
  });
});

/** The media keys: one per direction, logged as a hash, and a mismatch the user SEES (F5 of #1997). */
describe('the call keys (port of #2013, 2026-10-21)', () => {
  const byte = (b: ArrayBuffer) => new Uint8Array(b)[0];
  const CALLER = 'r'.charCodeAt(0); // the last byte of `room-1|caller`
  const CALLEE = 'e'.charCodeAt(0); // the last byte of `room-1|callee`
  const logLines = async () => {
    const { appendLog } = await import('$lib/utils/sessionLog');
    return vi.mocked(appendLog).mock.calls.map(([l]) => String(l));
  };
  /** A message the worker's transforms post, delivered to the service's handler. */
  const fromWorker = (data: Record<string, unknown>) =>
    workerAnswers.last?.onmessage?.({ data } as MessageEvent);

  it('the caller sends with the caller key and decrypts with the callee key', async () => {
    const service = new CallService(fakeMls);
    await callerJoined(service);
    expect(byte(workerAnswers.keys!.send)).toBe(CALLER);
    expect(byte(workerAnswers.keys!.receive)).toBe(CALLEE);
    expect(fakeMls.exportSecret).toHaveBeenCalledWith(
      'group-1',
      'mls-webrtc-media-v2',
      new TextEncoder().encode('room-1|caller'),
      32
    );
  });

  it('the callee holds the same two keys, the other way round', async () => {
    const service = new CallService(fakeMls);
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      {
        callId: 'room-1',
        offerSdp: 'START',
        hasVideo: false,
        deviceId: 'device-2',
        ringTimeoutMs: 60_000,
      },
      'me@example.org',
      'device-1'
    );
    const accepted = service.acceptCall('group-1', 'room-1');
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1' });
    await accepted;
    expect(byte(workerAnswers.keys!.send)).toBe(CALLEE);
    expect(byte(workerAnswers.keys!.receive)).toBe(CALLER);
  });

  it('hangup during the mic prompt, then a second call: the keys of call 2 reach the worker', async () => {
    const { showToast } = await import('$lib/stores/toast.svelte');
    vi.mocked(showToast).mockClear();
    // The microphone prompt of call 1 stays up until `release()`.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const md = navigator.mediaDevices as unknown as {
      getUserMedia: (c: MediaStreamConstraints) => Promise<ReturnType<typeof fakeMicStream>>;
    };
    const real = md.getUserMedia;
    let lateStream: ReturnType<typeof fakeMicStream> | null = null;
    md.getUserMedia = async (c) => {
      md.getUserMedia = real;
      await gate;
      lateStream = await real(c);
      return lateStream;
    };

    const service = new CallService(fakeMls);
    const first = service.startCall('group-1', false);
    await settle();
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(get(service.callState)).toBe('idle');
    // The prompt is answered after the call was cleaned up.
    release();
    await first;
    await settle();
    const lateTracks = lateStream!.getTracks() as unknown as ReturnType<typeof fakeTrack>[];
    expect(lateTracks).toHaveLength(1);
    for (const t of lateTracks) expect(t.stop).toHaveBeenCalledTimes(1);
    expect(workerAnswers.keys).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(await logLines()).toContain(
      '[Call] the call ended during its setup (after the microphone prompt, state=idle) - setup abandoned'
    );

    // Call 2 keys ITS worker; nothing of call 1 is left to stand in for it.
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    expect(byte(workerAnswers.keys!.send)).toBe(CALLER);
    expect(byte(workerAnswers.keys!.receive)).toBe(CALLEE);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('never keys a worker for a call that ended while its keys were exported', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(fakeMls.exportSecret).mockImplementationOnce(async (_g, _l, context) => {
      await gate;
      return new Uint8Array(32).fill(context[context.length - 1]);
    });
    const service = new CallService(fakeMls);
    const first = service.startCall('group-1', false);
    await settle();
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    release();
    await first;
    await settle();
    expect(workerAnswers.keys).toBeNull();
    expect(await logLines()).toContain(
      '[Call] the call ended during its setup (after the key export, state=idle) - setup abandoned'
    );
  });

  /** The next microphone prompt waits for `release()` (or fails with `refuse(e)`). */
  function holdNextMicrophone() {
    let release!: () => void;
    let refuse!: (e: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      release = resolve;
      refuse = reject;
    });
    const md = navigator.mediaDevices as unknown as {
      getUserMedia: (c: MediaStreamConstraints) => Promise<ReturnType<typeof fakeMicStream>>;
    };
    const real = md.getUserMedia;
    const got: ReturnType<typeof fakeMicStream>[] = [];
    md.getUserMedia = async (c) => {
      md.getUserMedia = real;
      await gate;
      const stream = await real(c);
      got.push(stream);
      return stream;
    };
    return { release, refuse, got };
  }

  /** An incoming call, ringing on this device. */
  async function ringing(service: CallService) {
    await service.handleCallSignal(
      'peer@example.org',
      'group-1',
      {
        callId: 'room-1',
        offerSdp: 'START',
        hasVideo: false,
        deviceId: 'device-2',
        ringTimeoutMs: 60_000,
      },
      'me@example.org',
      'device-1'
    );
  }

  it('acceptCall: a hangup during the ended SUMMARY (same sequence, state ended) abandons the setup', async () => {
    const { showToast } = await import('$lib/stores/toast.svelte');
    vi.mocked(showToast).mockClear();
    const mic = holdNextMicrophone();
    const service = new CallService(fakeMls);
    await ringing(service);
    const accepted = service.acceptCall('group-1', 'room-1');
    await settle();
    service.endCall();
    expect(get(service.callState)).toBe('ended');
    // The prompt is answered INSIDE the 1.5 s summary: cleanup has not run yet.
    mic.release();
    await accepted;
    await settle();
    expect(mic.got[0].getTracks()).toHaveLength(1);
    for (const t of mic.got[0].getTracks() as unknown as ReturnType<typeof fakeTrack>[]) {
      expect(t.stop).toHaveBeenCalledTimes(1);
    }
    expect(workerAnswers.keys).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(showToast).not.toHaveBeenCalled();
    expect(await logLines()).toContain(
      '[Call] the call ended during its setup (after the microphone prompt, state=ended) - setup abandoned'
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(get(service.callState)).toBe('idle');
  });

  it('acceptCall: a step that FAILS after its call ended is logged, not shown as a call failure', async () => {
    const { showToast } = await import('$lib/stores/toast.svelte');
    vi.mocked(showToast).mockClear();
    const mic = holdNextMicrophone();
    const service = new CallService(fakeMls);
    await ringing(service);
    const accepted = service.acceptCall('group-1', 'room-1');
    await settle();
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    mic.refuse(new Error('NotAllowedError'));
    await accepted;
    await settle();
    expect(showToast).not.toHaveBeenCalled();
    expect(await logLines()).toContain(
      '[Call] a setup step failed after its call ended: Error: NotAllowedError - not reported'
    );
  });

  it('a key wait the cleanup interrupts is settled, and its timer never touches the NEXT call', async () => {
    let release!: () => void;
    workerAnswers.keysHold = new Promise<void>((r) => (release = r));
    const service = new CallService(fakeMls);
    const first = service.startCall('group-1', false);
    await settle();
    expect(workerAnswers.keys).not.toBeNull();
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    await first;
    expect(await logLines()).toContain(
      '[Call] the call ended while the worker took its keys - the wait is settled'
    );

    // Call 2, keyed at once; then the first wait's 3 s would have passed.
    workerAnswers.keysHold = null;
    workerAnswers.keys = null;
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    expect(byte(workerAnswers.keys!.send)).toBe(CALLER);
    await vi.advanceTimersByTimeAsync(3_000);
    release();
    await settle();
    const lines = await logLines();
    expect(lines.some((l) => l.includes('encryption worker key timeout'))).toBe(false);
    // Call 2's transforms still find their worker keyed.
    expect(get(service.callState)).not.toBe('idle');
    expect(lines.some((l) => l.includes('the worker holds no call key'))).toBe(false);
  });

  it("hands every transform its track's kind, authenticated by the worker in each frame", async () => {
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    const pc = FakePeerConnection.instances[0];
    expect((pc.senders[0].transform as FakeTransform).options).toMatchObject({
      side: 'sender',
      kind: 'audio',
    });
    expect((pc.receivers[0].transform as FakeTransform).options).toMatchObject({
      side: 'receiver',
      kind: 'audio',
    });
  });

  it('logs a SHA-256 fingerprint of each key, never key bytes', async () => {
    const service = new CallService(fakeMls);
    await callerJoined(service);
    await vi.waitFor(async () =>
      expect((await logLines()).some((l) => l.includes('media keys derived'))).toBe(true)
    );
    const line = (await logLines()).find((l) => l.includes('media keys derived'))!;
    expect(line).toMatch(/\(role=caller send_fp=[0-9a-f]{8} recv_fp=[0-9a-f]{8}, sha256\)$/);
    const keyHex = (b: number) => b.toString(16).repeat(4);
    expect(line).not.toContain(keyHex(CALLER));
    expect(line).not.toContain(keyHex(CALLEE));
  });

  describe('a receiver that decrypts nothing', () => {
    async function inCall() {
      const { showToast } = await import('$lib/stores/toast.svelte');
      vi.mocked(showToast).mockClear();
      const service = new CallService(fakeMls);
      const ws = await callerJoined(service);
      ws.deliver({ type: 'PeerReady', initiator: true });
      await settle();
      return { showToast, epoch: workerAnswers.epoch, ws };
    }
    const undecryptable = (epoch: number, mediaKind = 'audio') =>
      fromWorker({ type: 'undecryptable', epoch, mediaKind, failures: 100 });

    it('is a key mismatch when NO receiver decrypted: said at ERROR and shown ONCE per call', async () => {
      const { showToast, epoch } = await inCall();
      undecryptable(epoch);
      undecryptable(epoch, 'video');
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledWith(m.call_e2e_key_mismatch(), 'error');
      expect(
        (await logLines()).filter((l) => l.startsWith('[Call] ERROR E2E key mismatch - 100 '))
      ).toHaveLength(2);
    });

    it('is NOT a key mismatch when another receiver of the call decrypts: ERROR, no notice', async () => {
      const { showToast, epoch } = await inCall();
      fromWorker({ type: 'inPath', side: 'receiver', epoch, mediaKind: 'audio' });
      undecryptable(epoch, 'video');
      expect(showToast).not.toHaveBeenCalled();
      expect((await logLines()).some((l) => l.endsWith('- not a key mismatch'))).toBe(true);
    });

    it("ignores a replaced peer connection's receiver: its epoch proves nothing about this one", async () => {
      const { showToast, epoch } = await inCall();
      undecryptable(epoch - 1);
      expect(showToast).not.toHaveBeenCalled();
    });

    it("judges a REPLACED device on its own frames: the old one's decrypts do not silence it", async () => {
      const { showToast, epoch, ws } = await inCall();
      fromWorker({ type: 'inPath', side: 'receiver', epoch, mediaKind: 'audio' });
      // The other party's device is replaced: a new peer connection, a new epoch.
      ws.deliver({ type: 'PeerReady', initiator: true });
      await settle();
      expect(workerAnswers.epoch).toBe(epoch + 1);
      undecryptable(epoch + 1);
      expect(showToast).toHaveBeenCalledWith(m.call_e2e_key_mismatch(), 'error');
    });
  });
});

/** WP-C2 (port of #2011): the `[CALL_REPORT]` line, every 10 s of a live call and once at its end. */
describe('the call report (port of #2011, 2026-10-21)', () => {
  const reports = async (phase: string) => {
    const { appendLog } = await import('$lib/utils/sessionLog');
    return vi
      .mocked(appendLog)
      .mock.calls.map(([l]) => String(l))
      .filter((l) => l.startsWith('[CALL_REPORT]') && l.includes(`phase=${phase}`));
  };

  async function liveCall() {
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.mocked(appendLog).mockClear();
    const service = new CallService(fakeMls);
    const ws = await callerJoined(service);
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    return { service, ws, pc: FakePeerConnection.instances[0] };
  }

  it('ticks every 10 s while in a call - never before - and stops at its end', async () => {
    const { service, pc } = await liveCall();
    // Not in a call yet (still ringing): nothing to report on.
    await vi.advanceTimersByTimeAsync(CALL_REPORT_INTERVAL_MS);
    expect(await reports('tick')).toHaveLength(0);

    pc.setConnection('connected');
    await vi.advanceTimersByTimeAsync(CALL_REPORT_INTERVAL_MS);
    expect(await reports('tick')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CALL_REPORT_INTERVAL_MS);
    expect(await reports('tick')).toHaveLength(2);

    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await reports('end')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * CALL_REPORT_INTERVAL_MS);
    expect(await reports('tick')).toHaveLength(2);
  });

  it("writes the end report from a peer connection still open, with the worker's counts", async () => {
    const { service, pc } = await liveCall();
    pc.setConnection('connected');
    service.endCall();
    // The reading starts at the hangup; the summary keeps the peer connection 1.5 s.
    await settle();
    expect(pc.closed).toBe(false);
    const [end] = await reports('end');
    expect(end).toContain('call=room-1 phase=end');
    // The fake worker's report: 250 encrypted, 251 decrypted, no failure.
    expect(end).toContain('e2e=on enc_frames=250 dec_frames=251 dec_fail=0');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(pc.closed).toBe(true);
  });

  it('never rates the end line against a tick of a peer connection the call no longer has', async () => {
    const { service, ws, pc } = await liveCall();
    pc.setConnection('connected');
    // The old peer connection's tick is held in flight with LARGE totals.
    let release!: () => void;
    pc.statsGate = new Promise<void>((resolve) => (release = resolve));
    pc.extraStats = [
      { id: 'o', type: 'outbound-rtp', kind: 'audio', bytesSent: 9_000_000, timestamp: 10_000 },
    ];
    await vi.advanceTimersByTimeAsync(CALL_REPORT_INTERVAL_MS);
    // The other device is replaced: a new peer connection, counting its bytes from zero.
    ws.deliver({ type: 'PeerReady', initiator: true });
    await settle();
    const fresh = FakePeerConnection.instances[1];
    fresh.extraStats = [
      { id: 'o', type: 'outbound-rtp', kind: 'audio', bytesSent: 40_000, timestamp: 20_000 },
    ];
    // The call ends while the old tick is STILL in flight, then that tick lands.
    service.endCall();
    release();
    await vi.advanceTimersByTimeAsync(1_500);
    const [end] = await reports('end');
    // No `previous` from the dead peer connection: no rate at all, never a negative or a bogus one.
    expect(end).toContain('out_kbps=- in_kbps=-');
  });

  it('ICE connecting during the 1.5 s summary does not reopen the call: cleanup runs, the mic stops', async () => {
    const { service, pc } = await liveCall();
    const mic = get(service.localStreamStore)!.getTracks() as unknown as ReturnType<
      typeof fakeTrack
    >[];
    service.endCall();
    expect(get(service.callState)).toBe('ended');
    pc.setConnection('connected');
    expect(get(service.callState)).toBe('ended');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(get(service.callState)).toBe('idle');
    for (const t of mic) expect(t.stop).toHaveBeenCalled();
  });

  it('zeroes the call keys at the end of the call', async () => {
    const { service } = await liveCall();
    const keys = (service as unknown as { callKeys: { send: Uint8Array; receive: Uint8Array } })
      .callKeys;
    expect(keys.send.some((b) => b !== 0)).toBe(true);
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(keys.send.every((b) => b === 0)).toBe(true);
    expect(keys.receive.every((b) => b === 0)).toBe(true);
  });

  it('says e2e=- when the worker does not answer, rather than vouching for it', async () => {
    const { service, pc } = await liveCall();
    pc.setConnection('connected');
    workerAnswers.report = null;
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    const [end] = await reports('end');
    expect(end).toContain('e2e=- enc_frames=-');
  });

  it('says so when the stats cannot be read, and still ends the call', async () => {
    const { service, pc } = await liveCall();
    pc.setConnection('connected');
    pc.statsError = new Error('getStats failed');
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    const { appendLog } = await import('$lib/utils/sessionLog');
    const lines = vi.mocked(appendLog).mock.calls.map(([l]) => String(l));
    expect(lines).toContain('[Call] WARN call report (end) not written: Error: getStats failed');
    expect(pc.closed).toBe(true);
    expect(get(service.callState)).toBe('idle');
  });

  it('writes no end report for a call that never built a peer connection', async () => {
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.mocked(appendLog).mockClear();
    const service = new CallService(fakeMls);
    await callerJoined(service);
    service.endCall();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await reports('end')).toHaveLength(0);
  });

  it('writes a refused line on an engine that cannot encrypt', async () => {
    vi.stubGlobal('RTCRtpScriptTransform', undefined);
    const { appendLog } = await import('$lib/utils/sessionLog');
    vi.mocked(appendLog).mockClear();
    await expect(new CallService(fakeMls).startCall('group-1', false)).rejects.toBeInstanceOf(
      CallE2eUnsupportedError
    );
    expect(await reports('refused')).toEqual([
      expect.stringMatching(
        /^\[CALL_REPORT\] call=- phase=refused engine=\S+ e2e=refused reason=no-rtp-script-transform$/
      ),
    ]);
  });
});
