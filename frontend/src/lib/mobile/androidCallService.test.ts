import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs: string[] = [];
vi.mock('$lib/utils/sessionLog', () => ({
  appendLog: (msg: string) => logs.push(msg),
}));

import {
  NATIVE_CALL_EVENT,
  callStartsOnSpeaker,
  hasAndroidCallService,
  nextSpeakerDefault,
  ongoingCallSpec,
  openAndroidCallSession,
  parseNativeCallEvent,
  releaseCallServiceOfPreviousPage,
  type AndroidCallBridge,
  type AndroidCallHost,
  type OngoingCallSpec,
} from './androidCallService';

/** A window with a recording `canariCall` and a real event target the test can dispatch on. */
function host(withBridge = true) {
  const calls: { method: keyof AndroidCallBridge; arg: string; callId?: string }[] = [];
  const target = new EventTarget();
  const bridge: AndroidCallBridge = {
    start: (arg) => calls.push({ method: 'start', arg }),
    update: (arg) => calls.push({ method: 'update', arg }),
    stop: (callId, arg) => calls.push({ method: 'stop', arg, callId }),
    pageLoaded: () => calls.push({ method: 'pageLoaded', arg: '' }),
  };
  const h: AndroidCallHost & { emit: (detail: unknown) => void } = {
    canariCall: withBridge ? bridge : undefined,
    addEventListener: (t, l) => target.addEventListener(t, l),
    removeEventListener: (t, l) => target.removeEventListener(t, l),
    // Every event names a call; this call's unless the test says otherwise.
    emit: (detail) =>
      target.dispatchEvent(
        new CustomEvent(NATIVE_CALL_EVENT, {
          detail:
            typeof detail === 'object' && detail !== null && !('callId' in detail)
              ? { callId: CALL, ...detail }
              : detail,
        })
      ),
  };
  return { h, calls };
}

const CALL = 'call-1';

/** A session for {@link CALL}. */
function open(
  h: AndroidCallHost,
  onHangUp = () => {},
  onRoute: (a: boolean) => void = () => {},
  onMute = () => {}
) {
  return openAndroidCallSession(h, { onHangUp, onRoute, onMute }, CALL);
}

const SPEC: OngoingCallSpec = {
  title: 'Bob',
  text: 'Appel audio',
  connectedAtMs: 1_000,
  speaker: false,
  peerUserId: 'user-bob',
  muted: false,
  speakerChosen: false,
};

/** The page's facts about a call with Bob. */
function facts(
  connectedAtMs: number | null,
  speaker: boolean,
  muted = false,
  speakerChosen = false
) {
  return { title: 'Bob', peerUserId: 'user-bob', connectedAtMs, speaker, speakerChosen, muted };
}

beforeEach(() => {
  logs.length = 0;
});

describe('callStartsOnSpeaker - where the voice starts', () => {
  it('an audio call starts on the earpiece (or a headset), a video call on the loudspeaker', () => {
    expect(callStartsOnSpeaker(false)).toBe(false);
    expect(callStartsOnSpeaker(true)).toBe(true);
  });
});

describe('nextSpeakerDefault - the default as the call goes on', () => {
  it('starts where callStartsOnSpeaker says', () => {
    expect(nextSpeakerDefault(null, false)).toBe(false);
    expect(nextSpeakerDefault(null, true)).toBe(true);
  });

  it('moves to the loudspeaker when video shows mid-call, and never back when it stops', () => {
    expect(nextSpeakerDefault(false, true)).toBe(true);
    expect(nextSpeakerDefault(true, false)).toBe(true);
    expect(nextSpeakerDefault(false, false)).toBe(false);
  });
});

describe('speakerChosen - a default and a tap are told apart natively', () => {
  it('crosses the bridge as given, so a default yields to a headset and a tap does not', () => {
    expect(ongoingCallSpec('live', true, facts(42, true))?.speakerChosen).toBe(false);
    expect(ongoingCallSpec('live', true, facts(42, true, false, true))?.speakerChosen).toBe(true);
  });
});

describe('ongoingCallSpec - when the service holds the call', () => {
  it('starts nothing before the microphone is held: the grant prompt of a first call comes after the tap', () => {
    expect(ongoingCallSpec('ringing', false, facts(null, false))).toBeNull();
    expect(ongoingCallSpec('connecting', false, facts(null, false))).toBeNull();
  });

  it("describes the caller's ring and the callee's connecting, with no chronometer yet", () => {
    expect(ongoingCallSpec('ringing', true, facts(null, true))).toMatchObject({
      title: 'Bob',
      connectedAtMs: null,
    });
    expect(ongoingCallSpec('connecting', true, facts(null, false))).toMatchObject({
      connectedAtMs: null,
      speaker: false,
    });
  });

  it('carries the peer, whose photo the notification draws, and the mute its action shows', () => {
    expect(ongoingCallSpec('live', true, facts(42, false, true))).toMatchObject({
      peerUserId: 'user-bob',
      muted: true,
    });
  });

  it('carries connectedAt as the chronometer base once live, and while reconnecting', () => {
    expect(ongoingCallSpec('live', true, facts(42, true))?.connectedAtMs).toBe(42);
    expect(ongoingCallSpec('reconnecting', true, facts(42, true))?.connectedAtMs).toBe(42);
  });

  it('holds nothing while ringing in, once ended, or idle', () => {
    for (const kind of ['incoming', 'ended', 'idle'] as const) {
      expect(ongoingCallSpec(kind, true, facts(42, true))).toBeNull();
    }
  });

  it('never puts the running timer in the text: the chronometer is native, and the text changes only with the state', () => {
    const a = ongoingCallSpec('live', true, facts(42, true));
    const b = ongoingCallSpec('live', true, facts(42, true));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('the notification mute', () => {
  it('toggles the microphone of the running call and leaves the service in place', () => {
    const { h, calls } = host();
    const onMute = vi.fn();
    const session = open(
      h,
      () => {},
      () => {},
      onMute
    );
    session.publish(SPEC, 'live');
    h.emit({ kind: 'mute' });
    session.publish({ ...SPEC, muted: true }, 'muted');
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.method)).toEqual(['start', 'update']);
    expect(JSON.parse(calls[1].arg).muted).toBe(true);
  });

  it('a mute with no service started does nothing', () => {
    const { h } = host();
    const onMute = vi.fn();
    open(
      h,
      () => {},
      () => {},
      onMute
    );
    h.emit({ kind: 'mute' });
    expect(onMute).not.toHaveBeenCalled();
  });
});

describe('openAndroidCallSession - the bridge', () => {
  it('says at ERROR level, once, that a build without the bridge cannot keep the call off screen', () => {
    const { h } = host(false);
    const session = open(h);
    session.publish(SPEC, 'live');
    session.publish(null, 'ended');
    session.dispose();
    expect(
      logs.filter((l) => l.includes('ERROR') && l.includes('no ongoing-call service'))
    ).toHaveLength(1);
  });

  it('starts once, updates only on a change, and stops at the end', () => {
    const { h, calls } = host();
    const session = open(h);
    session.publish({ ...SPEC, connectedAtMs: null }, 'ringing');
    session.publish({ ...SPEC, connectedAtMs: null }, 'ringing again');
    session.publish(SPEC, 'live');
    session.publish({ ...SPEC, speaker: true }, 'loudspeaker');
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start', 'update', 'update', 'stop']);
    expect(JSON.parse(calls[0].arg)).toEqual({ ...SPEC, connectedAtMs: null, callId: CALL });
    expect(JSON.parse(calls[1].arg).callId).toBe(CALL);
    expect(calls[3]).toMatchObject({ arg: 'ended', callId: CALL });
  });

  it('a stop with nothing started sends nothing', () => {
    const { h, calls } = host();
    const session = open(h);
    session.publish(null, 'declined');
    session.dispose();
    expect(calls).toEqual([]);
  });

  it('dispose stops a started service and stops listening', () => {
    const { h, calls } = host();
    const onHangUp = vi.fn();
    const session = open(h, onHangUp);
    session.publish(SPEC, 'live');
    session.dispose();
    expect(calls.map((c) => c.method)).toEqual(['start', 'stop']);
    h.emit({ kind: 'hangup' });
    expect(onHangUp).not.toHaveBeenCalled();
  });

  it("hands the notification's hang-up to the call, and sends no stop afterwards: the service already left", () => {
    const { h, calls } = host();
    const onHangUp = vi.fn();
    const session = open(h, onHangUp);
    session.publish(SPEC, 'live');
    h.emit({ kind: 'hangup' });
    session.publish(null, 'ended');
    session.dispose();
    expect(onHangUp).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.method)).toEqual(['start']);
  });

  it('a refusal coded `refused` is logged at ERROR and never asked again, even on a resume', () => {
    const { h, calls } = host();
    const session = open(h);
    session.publish(SPEC, 'live');
    h.emit({ kind: 'failed', code: 'refused', reason: 'start: RECORD_AUDIO is not granted' });
    h.emit({ kind: 'foreground' });
    session.publish({ ...SPEC, speaker: true }, 'loudspeaker');
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start']);
    expect(
      logs.some((l) => l.includes('ERROR ongoing-call service refused: start: RECORD_AUDIO'))
    ).toBe(true);
  });

  it('an `off-screen` refusal waits for the resume EVENT, then asks once with the current description', () => {
    const { h, calls } = host();
    const session = open(h);
    session.publish({ ...SPEC, connectedAtMs: null }, 'ringing');
    h.emit({ kind: 'failed', code: 'off-screen', reason: 'start: the app is not on screen' });
    // Nothing is sent while waiting: no clock, no retry loop.
    session.publish(SPEC, 'live');
    expect(calls.map((c) => c.method)).toEqual(['start']);
    expect(logs.some((l) => l.includes('WARN ongoing-call service refused'))).toBe(true);
    h.emit({ kind: 'foreground' });
    expect(calls.map((c) => c.method)).toEqual(['start', 'start']);
    expect(JSON.parse(calls[1].arg)).toEqual({ ...SPEC, callId: CALL });
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start', 'start', 'stop']);
  });

  it('a second `off-screen` refusal in the same call is final', () => {
    const { h, calls } = host();
    const session = open(h);
    session.publish(SPEC, 'live');
    h.emit({ kind: 'failed', code: 'off-screen', reason: 'a' });
    h.emit({ kind: 'foreground' });
    h.emit({ kind: 'failed', code: 'off-screen', reason: 'b' });
    h.emit({ kind: 'foreground' });
    session.publish({ ...SPEC, speaker: true }, 'loudspeaker');
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start', 'start']);
    expect(logs.some((l) => l.includes('ERROR ongoing-call service refused: b'))).toBe(true);
  });

  it('a `foreground` nobody waits for asks nothing', () => {
    const { h, calls } = host();
    const session = open(h);
    session.publish(SPEC, 'live');
    h.emit({ kind: 'foreground' });
    expect(calls.map((c) => c.method)).toEqual(['start']);
  });

  it('a call that ends while waiting for the resume asks nothing on the resume', () => {
    const { h, calls } = host();
    const session = open(h);
    session.publish(SPEC, 'live');
    h.emit({ kind: 'failed', code: 'off-screen', reason: 'a' });
    session.publish(null, 'ended');
    h.emit({ kind: 'foreground' });
    expect(calls.map((c) => c.method)).toEqual(['start']);
  });

  it('a stop Android made on its own is a WARN, and the session asks nothing more', () => {
    const { h, calls } = host();
    const session = open(h);
    session.publish(SPEC, 'live');
    h.emit({ kind: 'stopped', reason: 'the task was removed from Recents' });
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start']);
    expect(logs.some((l) => l.includes('WARN ongoing-call service stopped by Android'))).toBe(true);
  });

  it("an event of another call (an earlier one's, landing late) is dropped", () => {
    const { h, calls } = host();
    const onHangUp = vi.fn();
    const session = open(h, onHangUp);
    session.publish(SPEC, 'live');
    h.emit({ callId: 'call-0', kind: 'hangup' });
    h.emit({ callId: 'call-0', kind: 'stopped', reason: 'x' });
    session.publish(null, 'ended');
    expect(onHangUp).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(['start', 'stop']);
    expect(logs.some((l) => l.includes('of another call'))).toBe(true);
  });

  it('the route is unavailable while a start waits for the screen, and for good once refused', () => {
    const { h } = host();
    const route: boolean[] = [];
    const session = open(
      h,
      () => {},
      (a) => route.push(a)
    );
    session.publish(SPEC, 'live');
    h.emit({ kind: 'failed', code: 'off-screen', reason: 'a' });
    expect(route).toEqual([false]);
    h.emit({ kind: 'foreground' });
    expect(route).toEqual([false, true]);
    h.emit({ kind: 'failed', code: 'refused', reason: 'b' });
    expect(route).toEqual([false, true, false]);
  });

  it('the route is unavailable once Android stopped the service on its own', () => {
    const { h } = host();
    const route: boolean[] = [];
    const session = open(
      h,
      () => {},
      (a) => route.push(a)
    );
    session.publish(SPEC, 'live');
    h.emit({ kind: 'stopped', reason: 'destroyed' });
    expect(route).toEqual([false]);
  });

  it('an event it cannot read is logged, never guessed at', () => {
    const { h } = host();
    open(h);
    h.emit({ kind: 'teleported' });
    expect(logs.some((l) => l.includes('ERROR unreadable canari:call-native'))).toBe(true);
  });
});

describe('the page-load release and the speaker route', () => {
  it('a page that loads tells native once, which stops a service the previous page left', () => {
    const { h, calls } = host();
    releaseCallServiceOfPreviousPage(h);
    expect(calls.map((c) => c.method)).toEqual(['pageLoaded']);
  });

  it('without the bridge there is no service, no release to ask, and no speaker route', () => {
    const { h, calls } = host(false);
    releaseCallServiceOfPreviousPage(h);
    expect(calls).toEqual([]);
    expect(hasAndroidCallService(h)).toBe(false);
    expect(hasAndroidCallService(host().h)).toBe(true);
  });
});

describe('parseNativeCallEvent', () => {
  it('reads the six kinds the Kotlin side sends and nothing else', () => {
    const c = { callId: 'c' };
    expect(parseNativeCallEvent({ ...c, kind: 'started' })).toEqual({ ...c, kind: 'started' });
    expect(parseNativeCallEvent({ ...c, kind: 'hangup' })).toEqual({ ...c, kind: 'hangup' });
    expect(parseNativeCallEvent({ ...c, kind: 'mute' })).toEqual({ ...c, kind: 'mute' });
    expect(parseNativeCallEvent({ ...c, kind: 'foreground' })).toEqual({
      ...c,
      kind: 'foreground',
    });
    expect(parseNativeCallEvent({ ...c, kind: 'failed', code: 'off-screen', reason: 'x' })).toEqual(
      {
        ...c,
        kind: 'failed',
        code: 'off-screen',
        reason: 'x',
      }
    );
    // A refusal is acted on by its code: one without a known code is unreadable, never guessed.
    expect(parseNativeCallEvent({ ...c, kind: 'failed', reason: 'x' })).toBeNull();
    expect(parseNativeCallEvent({ ...c, kind: 'failed', code: 'later', reason: 'x' })).toBeNull();
    // An event names its call, or it cannot be told from an earlier call's.
    expect(parseNativeCallEvent({ kind: 'started' })).toBeNull();
    expect(parseNativeCallEvent({ callId: '', kind: 'started' })).toBeNull();
    expect(parseNativeCallEvent({ ...c, kind: 'stopped', reason: 'y' })).toEqual({
      ...c,
      kind: 'stopped',
      reason: 'y',
    });
    expect(parseNativeCallEvent({ ...c, kind: 'other' })).toBeNull();
    expect(parseNativeCallEvent(null)).toBeNull();
    expect(parseNativeCallEvent('started')).toBeNull();
  });
});
