import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import { CallService, CALL_ICE_TRANSPORT_POLICY } from './CallService';
import { CallE2eUnsupportedError } from '$lib/utils/callFailure';
import { m } from '$lib/paraglide/messages';

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
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/utils/callPresence', () => ({ publishCallPresence: vi.fn(async () => {}) }));
vi.mock('$lib/utils/chat/callSystemMessages', () => ({
  getCallSystemMessageContext: () => null,
  recordCallMissed: vi.fn(),
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

/** The E2E worker: answers `setKey` with `keyReady`, as the real one does. */
vi.mock('../workers/encryption.worker?worker', () => ({
  default: class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    private listeners: ((e: MessageEvent) => void)[] = [];
    addEventListener(_: string, l: (e: MessageEvent) => void) {
      this.listeners.push(l);
    }
    removeEventListener(_: string, l: (e: MessageEvent) => void) {
      this.listeners = this.listeners.filter((x) => x !== l);
    }
    postMessage(msg: { type: string }) {
      if (msg.type !== 'setKey') return;
      queueMicrotask(() => {
        const e = { data: { type: 'keyReady' } } as MessageEvent;
        this.onmessage?.(e);
        // A copy: the service removes its listener from inside the callback.
        for (const l of this.listeners.slice()) l(e);
      });
    }
    terminate() {}
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
  framesOfType(type: string) {
    return this.sent.filter((f) => f.type === type);
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  senders: { track: { kind: string }; transform: unknown }[] = [];
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onicecandidate = null;
  ontrack = null;
  onconnectionstatechange = null;
  oniceconnectionstatechange = null;
  onicegatheringstatechange = null;
  onsignalingstatechange = null;
  closed = false;
  constructor(public config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }
  receivers: { transform: unknown }[] = [];
  addTrack(track: { kind: string }) {
    const sender = { track, transform: null as unknown };
    this.senders.push(sender);
    this.receivers.push({ transform: null });
    return sender;
  }
  getTransceivers() {
    return this.senders.map((sender, i) => ({ sender, receiver: this.receivers[i] }));
  }
  async setLocalDescription() {
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `v=0 ${type}` };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
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
    public options: { side: string }
  ) {}
}

const fakeTrack = () => ({ kind: 'audio', stop: vi.fn(), enabled: true });
const fakeMls = {
  getDeviceId: () => 'device-1',
  exportSecret: vi.fn(async () => new Uint8Array(32).fill(7)),
  sendMessage: vi.fn(async () => {
    order.push('mls');
  }),
} as unknown as IMlsService;

/** Lets every pending promise and microtask of the service settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  server.ringTimeoutMs = 60_000;
  server.initiateStatus = 200;
  server.iceStatus = 200;
  server.ringStatus = 200;
  server.roomTokenStatus = 200;
  server.ringHold = null;
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
    service.handleCallSignal(
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
describe('the ring window, both sides', () => {
  const pastWindow = () => new Promise((r) => setTimeout(r, 30));
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
    service.handleCallSignal(
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

  it('does not ring for an invite that carries no window', () => {
    const service = new CallService(fakeMls);
    service.handleCallSignal(
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
    service.handleCallSignal(
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
