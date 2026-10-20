import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import {
  CallService,
  CALL_ICE_RESTART_ATTEMPTS,
  CALL_ICE_TRANSPORT_POLICY,
  CALL_SIGNALLING_RESUME_ATTEMPTS,
  CALL_SIGNALLING_RESUME_MAX_DELAY_MS,
  CALL_SIGNALLING_RESUME_TIMEOUT_MS,
} from './CallService';
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

vi.mock('$lib/features', () => ({ CALLS_ENABLED: true }));
vi.mock('$lib/users/blocks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/users/blocks')>()),
  isBlockedWith: vi.fn(async () => false),
}));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/utils/callPresence', () => ({ publishCallPresence: vi.fn(async () => {}) }));
vi.mock('$lib/utils/chat/callSystemMessages', () => ({
  getCallSystemMessageContext: () => null,
  recordCallMissed: vi.fn(),
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
    if (url.includes('/api/calls/ice-servers')) return json({ iceServers: ICE }, server.iceStatus);
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
};

/** The E2E worker: answers `setKey` with `keyReady` and `report` with counters, as the real one does. */
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
    postMessage(msg: { type: string; tag?: string }) {
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
      if (msg.type !== 'setKey') return;
      // A TASK, as a real worker's answer is (another thread posts it): an `addTrack` whose
      // transform waited for it would be one task late, which Chromium short-circuits.
      void flushMacrotask().then(() => {
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

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  senders: { track: { kind: string } | null; kind: string; transform: unknown; late?: boolean }[] =
    [];
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
  async getStats() {
    workerAnswers.reads.push('stats');
    const stats = new Map<string, unknown>();
    if (this.videoOutboundPackets !== null) {
      stats.set('out-v', {
        type: 'outbound-rtp',
        kind: 'video',
        packetsSent: this.videoOutboundPackets,
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
    const sender = withTransformSlot({ track, kind: track.kind } as {
      track: { kind: string } | null;
      kind: string;
    });
    this.senders.push(sender);
    this.receivers.push(withTransformSlot({}));
    return sender;
  }
  /** Always a NEW transceiver, created in this task. */
  addTransceiver(track: { kind: string }) {
    const sender = withTransformSlot({ track, kind: track.kind } as {
      track: { kind: string } | null;
      kind: string;
    });
    const receiver = withTransformSlot({});
    this.senders.push(sender);
    this.receivers.push(receiver);
    return { sender, receiver };
  }
  ontrackHandler() {
    return this.ontrack as unknown as ((e: unknown) => void) | null;
  }
  /**
   * The peer's offer carries a NEW m-line of `kind`: `setRemoteDescription` creates its
   * transceiver (a bare sender, a receiver) and fires `ontrack` in the same task, as the browser.
   */
  remoteOfferAdds(kind: string) {
    const sender = withTransformSlot({ track: null, kind } as {
      track: { kind: string } | null;
      kind: string;
    });
    const receiver = withTransformSlot({});
    this.senders.push(sender);
    this.receivers.push(receiver);
    const track = { kind, id: `remote-${kind}-1`, readyState: 'live', muted: false };
    this.ontrackHandler()?.({ track, receiver, transceiver: { sender, receiver } });
    return { sender, receiver };
  }
  removeTrack(sender: unknown) {
    const i = this.senders.indexOf(sender as (typeof this.senders)[number]);
    if (i >= 0) {
      this.senders.splice(i, 1);
      this.receivers.splice(i, 1);
    }
  }
  getTransceivers() {
    return this.senders.map((sender, i) => ({ sender, receiver: this.receivers[i] }));
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
    public options: { side: string; epoch?: number }
  ) {
    workerAnswers.epoch = options.epoch ?? 0;
  }
}

const fakeTrack = () => ({ kind: 'audio', stop: vi.fn(), enabled: true });
const fakeMls = {
  getDeviceId: () => 'device-1',
  exportSecret: vi.fn(async () => new Uint8Array(32).fill(7)),
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

beforeEach(() => {
  server.ringTimeoutMs = 60_000;
  server.initiateStatus = 200;
  server.iceStatus = 200;
  server.ringStatus = 200;
  server.roomTokenStatus = 200;
  server.ringHold = null;
  workerAnswers.report = { sender: 250, receiver: 251 };
  workerAnswers.terminated = 0;
  workerAnswers.video = { sender: 0, receiver: 0 };
  workerAnswers.reads = [];
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
  const stream = {
    getTracks: () => [fakeTrack()],
    getVideoTracks: () => [],
    getAudioTracks: () => [],
  };
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
  });
});

afterEach(() => {
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

    expect(lines()).toContain(
      '[Call] ERROR E2E path check (5 s after connected): media flowed AROUND the transform on sender:audio and receiver:audio (packets sent audio=250 video=0 received audio=248 video=0; frames sender:audio=0 receiver:audio=0)'
    );
    // The packets are read BEFORE the frames: a first packet between the two reads cannot look
    // like a bypass (frames read later can only be ahead).
    expect(workerAnswers.reads).toEqual(['stats', 'report']);
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
    const camTrack = { kind: 'video', stop: vi.fn(), enabled: true };
    const local = service as unknown as {
      localStream: { addTrack: () => void; getVideoTracks: () => unknown[] };
    };
    local.localStream.addTrack = () => {};
    local.localStream.getVideoTracks = () => [];
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getVideoTracks: () => [camTrack] })) },
    });
    await service.toggleVideo();
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

    const camTrack = { kind: 'video', stop: vi.fn(), enabled: true };
    const local = service as unknown as {
      localStream: { addTrack: () => void; getVideoTracks: () => unknown[] };
    };
    local.localStream.addTrack = () => {};
    local.localStream.getVideoTracks = () => [];
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getVideoTracks: () => [camTrack] })) },
    });
    await service.toggleVideo();
    pc.videoOutboundPackets = 120;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines()).toContain(
      '[Call] ERROR E2E path check (after the camera was added): media flowed AROUND the transform on sender:video (packets sent audio=250 video=120 received audio=251 video=0; frames sender:video=0)'
    );
    expect(get(service.callState)).toBe('ended');
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

describe('a second call while one is up', () => {
  it('does not ring over the call in progress, sends nothing for it, and says why', async () => {
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
    expect(fakeMls.sendMessage).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(appendLog)
        .mock.calls.map((c) => c[0])
        .join(' ')
    ).toContain('invite room-2 in group-2 not rung - busy');
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
    const { recordCallMissed } = await import('$lib/utils/chat/callSystemMessages');
    vi.mocked(recordCallMissed).mockClear();
    const service = new CallService(fakeMls);
    await callerJoined(service);

    await pastWindow();

    expect(['ended', 'idle']).toContain(get(service.callState));
    expect(recordCallMissed).toHaveBeenCalledTimes(1);
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

  it('stops ringing the callee when the window closes, and writes nothing', async () => {
    const { recordCallMissed } = await import('$lib/utils/chat/callSystemMessages');
    vi.mocked(recordCallMissed).mockClear();
    const service = new CallService(fakeMls);
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
    expect(recordCallMissed).not.toHaveBeenCalled();
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
    const { recordCallMissed } = await import('$lib/utils/chat/callSystemMessages');
    vi.mocked(recordCallMissed).mockClear();
    const service = new CallService(fakeMls);

    const started = service.startCall('group-1', false);
    await settle();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.deliver({ type: 'Joined', room_id: 'room-1' });

    await expect(started).rejects.toThrow('calls/ring failed (410)');
    // The server opens the window before it fans out: a refused ring rang nobody.
    expect(order).not.toContain('mls');
    expect(recordCallMissed).not.toHaveBeenCalled();
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

/** F7: a call that failed before its invite rang nobody, so nothing was missed. */
describe('no missed call for a call that never rang', () => {
  it.each([
    ['the ICE servers are refused', () => (server.iceStatus = 503)],
    ['the initiate is refused', () => (server.initiateStatus = 403)],
  ])('writes no missed call when %s', async (_, arrange) => {
    arrange();
    const { recordCallMissed } = await import('$lib/utils/chat/callSystemMessages');
    vi.mocked(recordCallMissed).mockClear();
    const service = new CallService(fakeMls);

    await expect(service.startCall('group-1', false)).rejects.toThrow();

    expect(recordCallMissed).not.toHaveBeenCalled();
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
