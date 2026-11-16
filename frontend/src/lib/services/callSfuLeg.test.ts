import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs: string[] = [];
vi.mock('../utils/sessionLog', () => ({ appendLog: (l: string) => logs.push(l) }));

import {
  CallSfuLeg,
  CallSfuNegotiationError,
  CallSfuTrackUnattributedError,
  sfuJoinFrame,
  type CallSfuLegHooks,
  type SfuClientFrame,
} from './callSfuLeg';

/** Every step the leg takes through its hooks or its connection, in order. */
let steps: string[] = [];

class FakeSender {
  transform: unknown = null;
  constructor(public track: { kind: string; id: string } | null) {}
  getParameters() {
    return { encodings: [{}] } as RTCRtpSendParameters;
  }
  async setParameters() {}
}

class FakeTransceiver {
  mid: string | null = null;
  readonly sender: FakeSender;
  readonly receiver = { transform: null as unknown };
  constructor(
    track: { kind: string; id: string } | null,
    public direction: RTCRtpTransceiverDirection,
    public readonly kind: string
  ) {
    this.sender = new FakeSender(track);
  }
}

/**
 * A peer connection that keeps the signalling state as the browser does: an offer, then an answer,
 * rolls back, and places (`mid`) the transceivers an applied answer or offer covered.
 */
class FakePc {
  signalingState: RTCSignalingState = 'stable';
  localDescription: { type: RTCSdpType; sdp: string } | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  transceivers: FakeTransceiver[] = [];
  candidates: RTCIceCandidateInit[] = [];
  closed = false;
  /** Microtask turns each description step takes: frames racing each other show up above 0. */
  latency = 0;
  ontrack: ((e: unknown) => void) | null = null;
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  /** The transceivers the pending local offer covered. */
  private offered: FakeTransceiver[] = [];
  private nextMid = 0;

  private async lag() {
    for (let i = 0; i < this.latency; i++) await Promise.resolve();
  }
  addTransceiver(track: { kind: string; id: string }, init: RTCRtpTransceiverInit) {
    steps.push(`addTransceiver ${track.kind} ${init.direction}`);
    const t = new FakeTransceiver(track, init.direction ?? 'sendrecv', track.kind);
    this.transceivers.push(t);
    return t;
  }
  removeTrack(sender: FakeSender) {
    steps.push('removeTrack');
    sender.track = null;
  }
  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }
  getTransceivers() {
    return this.transceivers;
  }
  async createOffer() {
    await this.lag();
    return { type: 'offer' as const, sdp: `offer-${this.transceivers.length}` };
  }
  async createAnswer() {
    await this.lag();
    return { type: 'answer' as const, sdp: 'answer' };
  }
  async setLocalDescription(desc: { type: RTCSdpType; sdp?: string }) {
    await this.lag();
    steps.push(`setLocal ${desc.type}`);
    if (desc.type === 'rollback') {
      this.signalingState = 'stable';
      this.localDescription = null;
      this.offered = [];
      return;
    }
    this.localDescription = { type: desc.type, sdp: desc.sdp ?? '' };
    if (desc.type === 'offer') {
      this.signalingState = 'have-local-offer';
      this.offered = [...this.transceivers];
    } else {
      this.signalingState = 'stable';
    }
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    await this.lag();
    steps.push(`setRemote ${desc.type}`);
    if (desc.type === 'offer' && this.signalingState !== 'stable') {
      throw new Error(`InvalidStateError: offer in ${this.signalingState}`);
    }
    this.remoteDescription = desc;
    if (desc.type === 'answer') {
      for (const t of this.offered) t.mid ??= String(this.nextMid++);
      this.offered = [];
      this.signalingState = 'stable';
    } else {
      this.signalingState = 'have-remote-offer';
    }
  }
  async addIceCandidate(init: RTCIceCandidateInit) {
    steps.push(`addIce ${init.candidate}`);
    this.candidates.push(init);
  }
  close() {
    this.closed = true;
  }

  /** The relay's offer forwarded a track of `streamId` (null: a track with no stream). */
  forward(kind: string, streamId: string | null, trackId = `t-${kind}-${streamId}`) {
    const t = new FakeTransceiver(null, 'recvonly', kind);
    t.mid = String(this.nextMid++);
    this.transceivers.push(t);
    const track = { kind, id: trackId };
    const streams = streamId === null ? [] : [{ id: streamId }];
    this.ontrack?.({ track, receiver: t.receiver, transceiver: t, streams });
    return { track, transceiver: t };
  }
}

const SELF = 'aaaa1111-self';
const BOB = 'BBBB2222-bob';

let pc: FakePc;
let sent: SfuClientFrame[];
let failures: Error[];
let joinedOthers: (number | null)[];
let remote: { peer: string; trackId: string }[];
let refusedCamera: string[];
let hookOverrides: Partial<CallSfuLegHooks>;

function hooks(): CallSfuLegHooks {
  return {
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
    holdVideoCodec: (_t, kind) => (kind === 'video' ? 'video/VP8' : undefined),
    attachSenderTransform: (sender, kind, codec, how) => {
      steps.push(`sender transform ${kind} ${how}`);
      (sender as unknown as FakeSender).transform = { side: 'sender', kind, codec };
    },
    attachReceiverTransform: (receiver, kind, peer, codec) => {
      steps.push(`receiver transform ${kind} ${peer}`);
      (receiver as unknown as { transform: unknown }).transform = {
        side: 'receiver',
        kind,
        peer,
        codec,
      };
    },
    senderCreated: (_s, track) => steps.push(`senderCreated ${track.kind}`),
    cameraRefused: (track) => refusedCamera.push(track.id),
    sendSignal: (frame) => {
      steps.push(`send ${frame.type}`);
      sent.push(frame);
    },
    onJoined: (others) => joinedOthers.push(others),
    onRemoteTrack: (peer, track) => {
      steps.push(`remote ${track.kind} ${peer}`);
      remote.push({ peer, trackId: track.id });
    },
    onConnectionState: (state) => steps.push(`state ${state}`),
    onFailed: (e) => failures.push(e),
    ...hookOverrides,
  };
}

function track(kind: string) {
  return { kind, id: `local-${kind}` } as MediaStreamTrack;
}

function leg(kinds: string[] = ['audio']) {
  const l = new CallSfuLeg(
    SELF,
    { stream: { id: 'local' } as MediaStream, tracks: kinds.map(track) },
    hooks()
  );
  l.open();
  return l;
}

function sdp(type: RTCSdpType, body: string = type) {
  return JSON.stringify({ type, sdp: body });
}

beforeEach(() => {
  logs.length = 0;
  steps = [];
  pc = new FakePc();
  sent = [];
  failures = [];
  joinedOthers = [];
  remote = [];
  refusedCamera = [];
  hookOverrides = {};
});

describe('CallSfuLeg - one connection to the relay (WP-GC4 client)', () => {
  it("joins in the relay's mode, which the room token must sign", () => {
    expect(sfuJoinFrame('room-1', 'rt')).toEqual({
      type: 'Join',
      room_id: 'room-1',
      room_token: 'rt',
      mode: 'sfu',
    });
  });

  it('sends each local track on a SEND-ONLY transceiver whose transform is attached in the same task', () => {
    leg(['audio', 'video']);
    // `open` is synchronous: everything below happened before any await could split the task.
    expect(steps).toEqual([
      'addTransceiver audio sendonly',
      'sender transform audio attached',
      'senderCreated audio',
      'addTransceiver video sendonly',
      'sender transform video attached',
      'senderCreated video',
    ]);
    expect(pc.transceivers.map((t) => t.sender.transform)).toEqual([
      { side: 'sender', kind: 'audio', codec: undefined },
      { side: 'sender', kind: 'video', codec: 'video/VP8' },
    ]);
    expect(sent).toEqual([]);
  });

  it('never sends a camera its transceiver would not hold to VP8', () => {
    hookOverrides = { holdVideoCodec: () => undefined };
    leg(['audio', 'video']);
    expect(steps).toContain('removeTrack');
    expect(steps).not.toContain('sender transform video attached');
    expect(refusedCamera).toEqual(['local-video']);
    expect(logs.some((l) => l.includes('ERROR the camera is not sent'))).toBe(true);
  });

  it('a transform that cannot be attached at open closes the leg and throws to its caller', () => {
    hookOverrides = {
      attachSenderTransform: () => {
        throw new Error('the worker holds no call key');
      },
    };
    const l = new CallSfuLeg(
      SELF,
      { stream: { id: 'local' } as MediaStream, tracks: [track('audio')] },
      hooks()
    );
    expect(() => l.open()).toThrow('the worker holds no call key');
    expect(pc.closed).toBe(true);
    expect(l.connection).toBeNull();
  });

  it('offers once on Joined, and hands the seats other users hold to its owner', async () => {
    const l = leg();
    await l.handle({ type: 'Joined', room_id: 'r', others: 2 });
    expect(joinedOthers).toEqual([2]);
    expect(sent).toEqual([{ type: 'Offer', sdp: sdp('offer', 'offer-1') }]);
    await l.handle({ type: 'Joined', room_id: 'r', others: 2 });
    expect(sent).toHaveLength(1);
  });

  it('reads a relay older than `others` as unstated, never as an empty room', async () => {
    const l = leg();
    await l.handle({ type: 'Joined', room_id: 'r' });
    expect(joinedOthers).toEqual([null]);
  });

  it("applies the relay's answer, then the candidates that arrived before it; end-of-candidates adds nothing", async () => {
    const l = leg();
    await l.handle({ type: 'Joined', others: 0 });
    await l.handle({ type: 'IceCandidate', candidate: JSON.stringify({ candidate: 'c1' }) });
    await l.handle({ type: 'IceCandidate', candidate: JSON.stringify({ candidate: '' }) });
    expect(pc.candidates).toEqual([]);
    await l.handle({ type: 'Answer', sdp: sdp('answer') });
    expect(pc.candidates).toEqual([{ candidate: 'c1' }]);
    await l.handle({ type: 'IceCandidate', candidate: JSON.stringify({ candidate: 'c2' }) });
    expect(pc.candidates.map((c) => c.candidate)).toEqual(['c1', 'c2']);
    expect(pc.transceivers[0].mid).not.toBeNull();
  });

  it('sends its own candidates to the relay, and not the end of gathering', () => {
    leg();
    pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'local-1', sdpMid: '0' }) } });
    pc.onicecandidate?.({ candidate: null });
    expect(sent).toEqual([
      { type: 'IceCandidate', candidate: JSON.stringify({ candidate: 'local-1', sdpMid: '0' }) },
    ]);
  });

  it("answers the relay's renegotiation, and keys each forwarded track by the sender its stream id names", async () => {
    const l = leg();
    await l.handle({ type: 'Joined', others: 1 });
    await l.handle({ type: 'Answer', sdp: sdp('answer') });
    steps = [];
    sent = [];
    const offer = l.handle({ type: 'Offer', sdp: sdp('offer') });
    // The relay's offer creates the transceiver; `ontrack` fires inside setRemoteDescription.
    const { transceiver } = pc.forward('audio', BOB, 'fwd-a');
    await offer;
    // Both transforms in the task `ontrack` fired in, BEFORE the track reaches the screen.
    expect(steps.slice(0, 3)).toEqual([
      'receiver transform audio bbbb2222-bob',
      'sender transform audio armed, no track yet',
      'remote audio bbbb2222-bob',
    ]);
    expect(transceiver.receiver.transform).toMatchObject({ peer: 'bbbb2222-bob' });
    expect(remote).toEqual([{ peer: 'bbbb2222-bob', trackId: 'fwd-a' }]);
    expect(l.senderOf('fwd-a')).toBe('bbbb2222-bob');
    expect(sent).toEqual([{ type: 'Answer', sdp: sdp('answer') }]);
  });

  it('holds a forwarded video to VP8 before its transforms, and tells them the codec', () => {
    leg();
    const { transceiver } = pc.forward('video', BOB);
    expect(transceiver.receiver.transform).toEqual({
      side: 'receiver',
      kind: 'video',
      peer: 'bbbb2222-bob',
      codec: 'video/VP8',
    });
  });

  it('refuses a forwarded track naming no sender, or this device: no key may be chosen for it', () => {
    for (const streamId of [null, SELF.toUpperCase()]) {
      pc = new FakePc();
      failures = [];
      remote = [];
      const l = leg();
      const { transceiver } = pc.forward('audio', streamId);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(CallSfuTrackUnattributedError);
      expect(transceiver.receiver.transform).toBeNull();
      expect(remote).toEqual([]);
      expect(pc.closed).toBe(true);
      expect(l.connection).toBeNull();
    }
  });

  it('ends the leg when a forwarded track cannot be decrypted, and never shows it', () => {
    const noKey = new Error('the worker holds no call key');
    hookOverrides = {
      attachReceiverTransform: () => {
        throw noKey;
      },
    };
    leg();
    pc.forward('audio', BOB);
    expect(failures).toEqual([noKey]);
    expect(remote).toEqual([]);
    expect(pc.closed).toBe(true);
  });

  it("is polite in a glare: rolls its offer back, answers the relay's, and offers again for what was never placed", async () => {
    const l = leg();
    await l.handle({ type: 'Joined', others: 1 });
    expect(pc.signalingState).toBe('have-local-offer');
    steps = [];
    sent = [];
    await l.handle({ type: 'Offer', sdp: sdp('offer') });
    expect(steps).toEqual([
      'setLocal rollback',
      'setRemote offer',
      'setLocal answer',
      'send Answer',
      'setLocal offer',
      'send Offer',
    ]);
    expect(sent.map((f) => f.type)).toEqual(['Answer', 'Offer']);
    // The relay applies the re-offer and answers it: our track is placed, and nothing is owed.
    await l.handle({ type: 'Answer', sdp: sdp('answer') });
    expect(pc.transceivers[0].mid).not.toBeNull();
    expect(sent).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it('drops an answer that answers no offer of ours, and offers nothing after a placed renegotiation', async () => {
    const l = leg();
    await l.handle({ type: 'Joined', others: 0 });
    await l.handle({ type: 'Answer', sdp: sdp('answer') });
    sent = [];
    await l.handle({ type: 'Answer', sdp: sdp('answer') });
    await l.handle({ type: 'Offer', sdp: sdp('offer') });
    expect(sent.map((f) => f.type)).toEqual(['Answer']);
    expect(logs.some((x) => x.includes('it answers no offer of ours, dropped'))).toBe(true);
    expect(failures).toEqual([]);
  });

  it('handles frames one at a time in arrival order, even when each step takes several turns', async () => {
    pc.latency = 3;
    const l = leg();
    void l.handle({ type: 'Joined', others: 1 });
    void l.handle({ type: 'Answer', sdp: sdp('answer') });
    // Sent before the answer was applied: it must still land after the remote description.
    await l.handle({ type: 'IceCandidate', candidate: JSON.stringify({ candidate: 'c1' }) });
    expect(steps.filter((s) => s.startsWith('set') || s.startsWith('addIce'))).toEqual([
      'setLocal offer',
      'setRemote answer',
      'addIce c1',
    ]);
  });

  it('ends with a typed negotiation error when the engine refuses a step, and drops what follows', async () => {
    const l = leg();
    await l.handle({ type: 'Joined', others: 1 });
    await l.handle({ type: 'Answer', sdp: 'not json' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(CallSfuNegotiationError);
    expect((failures[0] as CallSfuNegotiationError).step).toBe('Answer');
    expect(pc.closed).toBe(true);
    await l.handle({ type: 'Offer', sdp: sdp('offer') });
    expect(failures).toHaveLength(1);
    expect(logs.some((x) => x.includes('Offer after the leg ended - dropped'))).toBe(true);
  });

  it('reports its connection state to its owner', () => {
    leg();
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    expect(steps).toContain('state connected');
  });

  it('close is idempotent and ends the leg without a failure', async () => {
    const l = leg();
    l.close();
    l.close();
    expect(pc.closed).toBe(true);
    await l.handle({ type: 'Joined', others: 0 });
    expect(sent).toEqual([]);
    expect(failures).toEqual([]);
  });
});
