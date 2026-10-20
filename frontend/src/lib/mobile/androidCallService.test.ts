import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs: string[] = [];
vi.mock('$lib/utils/sessionLog', () => ({
  appendLog: (msg: string) => logs.push(msg),
}));

import {
  NATIVE_CALL_EVENT,
  hasAndroidCallService,
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
  const calls: { method: keyof AndroidCallBridge; arg: string }[] = [];
  const target = new EventTarget();
  const bridge: AndroidCallBridge = {
    start: (arg) => calls.push({ method: 'start', arg }),
    update: (arg) => calls.push({ method: 'update', arg }),
    stop: (arg) => calls.push({ method: 'stop', arg }),
    pageLoaded: () => calls.push({ method: 'pageLoaded', arg: '' }),
  };
  const h: AndroidCallHost & { emit: (detail: unknown) => void } = {
    canariCall: withBridge ? bridge : undefined,
    addEventListener: (t, l) => target.addEventListener(t, l),
    removeEventListener: (t, l) => target.removeEventListener(t, l),
    emit: (detail) => target.dispatchEvent(new CustomEvent(NATIVE_CALL_EVENT, { detail })),
  };
  return { h, calls };
}

const SPEC: OngoingCallSpec = {
  title: 'Bob',
  text: 'Appel audio',
  connectedAtMs: 1_000,
  speaker: true,
};

beforeEach(() => {
  logs.length = 0;
});

describe('ongoingCallSpec - when the service holds the call', () => {
  it('starts nothing before the microphone is held: the grant prompt of a first call comes after the tap', () => {
    expect(ongoingCallSpec('ringing', false, 'Bob', null, true)).toBeNull();
    expect(ongoingCallSpec('connecting', false, 'Bob', null, true)).toBeNull();
  });

  it("describes the caller's ring and the callee's connecting, with no chronometer yet", () => {
    expect(ongoingCallSpec('ringing', true, 'Bob', null, true)).toMatchObject({
      title: 'Bob',
      connectedAtMs: null,
    });
    expect(ongoingCallSpec('connecting', true, 'Bob', null, false)).toMatchObject({
      connectedAtMs: null,
      speaker: false,
    });
  });

  it('carries connectedAt as the chronometer base once live, and while reconnecting', () => {
    expect(ongoingCallSpec('live', true, 'Bob', 42, true)?.connectedAtMs).toBe(42);
    expect(ongoingCallSpec('reconnecting', true, 'Bob', 42, true)?.connectedAtMs).toBe(42);
  });

  it('holds nothing while ringing in, once ended, or idle', () => {
    for (const kind of ['incoming', 'ended', 'idle'] as const) {
      expect(ongoingCallSpec(kind, true, 'Bob', 42, true)).toBeNull();
    }
  });

  it('never puts the running timer in the text: the chronometer is native, and the text changes only with the state', () => {
    const a = ongoingCallSpec('live', true, 'Bob', 42, true);
    const b = ongoingCallSpec('live', true, 'Bob', 42, true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('openAndroidCallSession - the bridge', () => {
  it('says at ERROR level, once, that a build without the bridge cannot keep the call off screen', () => {
    const { h } = host(false);
    const session = openAndroidCallSession(h, () => {});
    session.publish(SPEC, 'live');
    session.publish(null, 'ended');
    session.dispose();
    expect(
      logs.filter((l) => l.includes('ERROR') && l.includes('no ongoing-call service'))
    ).toHaveLength(1);
  });

  it('starts once, updates only on a change, and stops at the end', () => {
    const { h, calls } = host();
    const session = openAndroidCallSession(h, () => {});
    session.publish({ ...SPEC, connectedAtMs: null }, 'ringing');
    session.publish({ ...SPEC, connectedAtMs: null }, 'ringing again');
    session.publish(SPEC, 'live');
    session.publish({ ...SPEC, speaker: false }, 'earpiece');
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start', 'update', 'update', 'stop']);
    expect(JSON.parse(calls[0].arg)).toEqual({ ...SPEC, connectedAtMs: null });
    expect(calls[3].arg).toBe('ended');
  });

  it('a stop with nothing started sends nothing', () => {
    const { h, calls } = host();
    const session = openAndroidCallSession(h, () => {});
    session.publish(null, 'declined');
    session.dispose();
    expect(calls).toEqual([]);
  });

  it('dispose stops a started service and stops listening', () => {
    const { h, calls } = host();
    const onHangUp = vi.fn();
    const session = openAndroidCallSession(h, onHangUp);
    session.publish(SPEC, 'live');
    session.dispose();
    expect(calls.map((c) => c.method)).toEqual(['start', 'stop']);
    h.emit({ kind: 'hangup' });
    expect(onHangUp).not.toHaveBeenCalled();
  });

  it("hands the notification's hang-up to the call, and sends no stop afterwards: the service already left", () => {
    const { h, calls } = host();
    const onHangUp = vi.fn();
    const session = openAndroidCallSession(h, onHangUp);
    session.publish(SPEC, 'live');
    h.emit({ kind: 'hangup' });
    session.publish(null, 'ended');
    session.dispose();
    expect(onHangUp).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.method)).toEqual(['start']);
  });

  it('a refusal coded `refused` is logged at ERROR and never asked again, even on a resume', () => {
    const { h, calls } = host();
    const session = openAndroidCallSession(h, () => {});
    session.publish(SPEC, 'live');
    h.emit({ kind: 'failed', code: 'refused', reason: 'start: RECORD_AUDIO is not granted' });
    h.emit({ kind: 'foreground' });
    session.publish({ ...SPEC, speaker: false }, 'earpiece');
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start']);
    expect(
      logs.some((l) => l.includes('ERROR ongoing-call service refused: start: RECORD_AUDIO'))
    ).toBe(true);
  });

  it('an `off-screen` refusal waits for the resume EVENT, then asks once with the current description', () => {
    const { h, calls } = host();
    const session = openAndroidCallSession(h, () => {});
    session.publish({ ...SPEC, connectedAtMs: null }, 'ringing');
    h.emit({ kind: 'failed', code: 'off-screen', reason: 'start: the app is not on screen' });
    // Nothing is sent while waiting: no clock, no retry loop.
    session.publish(SPEC, 'live');
    expect(calls.map((c) => c.method)).toEqual(['start']);
    expect(logs.some((l) => l.includes('WARN ongoing-call service refused'))).toBe(true);
    h.emit({ kind: 'foreground' });
    expect(calls.map((c) => c.method)).toEqual(['start', 'start']);
    expect(JSON.parse(calls[1].arg)).toEqual(SPEC);
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start', 'start', 'stop']);
  });

  it('a second `off-screen` refusal in the same call is final', () => {
    const { h, calls } = host();
    const session = openAndroidCallSession(h, () => {});
    session.publish(SPEC, 'live');
    h.emit({ kind: 'failed', code: 'off-screen', reason: 'a' });
    h.emit({ kind: 'foreground' });
    h.emit({ kind: 'failed', code: 'off-screen', reason: 'b' });
    h.emit({ kind: 'foreground' });
    session.publish({ ...SPEC, speaker: false }, 'earpiece');
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start', 'start']);
    expect(logs.some((l) => l.includes('ERROR ongoing-call service refused: b'))).toBe(true);
  });

  it('a `foreground` nobody waits for asks nothing', () => {
    const { h, calls } = host();
    const session = openAndroidCallSession(h, () => {});
    session.publish(SPEC, 'live');
    h.emit({ kind: 'foreground' });
    expect(calls.map((c) => c.method)).toEqual(['start']);
  });

  it('a call that ends while waiting for the resume asks nothing on the resume', () => {
    const { h, calls } = host();
    const session = openAndroidCallSession(h, () => {});
    session.publish(SPEC, 'live');
    h.emit({ kind: 'failed', code: 'off-screen', reason: 'a' });
    session.publish(null, 'ended');
    h.emit({ kind: 'foreground' });
    expect(calls.map((c) => c.method)).toEqual(['start']);
  });

  it('a stop Android made on its own is a WARN, and the session asks nothing more', () => {
    const { h, calls } = host();
    const session = openAndroidCallSession(h, () => {});
    session.publish(SPEC, 'live');
    h.emit({ kind: 'stopped', reason: 'the task was removed from Recents' });
    session.publish(null, 'ended');
    expect(calls.map((c) => c.method)).toEqual(['start']);
    expect(logs.some((l) => l.includes('WARN ongoing-call service stopped by Android'))).toBe(true);
  });

  it('an event it cannot read is logged, never guessed at', () => {
    const { h } = host();
    openAndroidCallSession(h, () => {});
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
  it('reads the five kinds the Kotlin side sends and nothing else', () => {
    expect(parseNativeCallEvent({ kind: 'started' })).toEqual({ kind: 'started' });
    expect(parseNativeCallEvent({ kind: 'hangup' })).toEqual({ kind: 'hangup' });
    expect(parseNativeCallEvent({ kind: 'foreground' })).toEqual({ kind: 'foreground' });
    expect(parseNativeCallEvent({ kind: 'failed', code: 'off-screen', reason: 'x' })).toEqual({
      kind: 'failed',
      code: 'off-screen',
      reason: 'x',
    });
    // A refusal is acted on by its code: one without a known code is unreadable, never guessed.
    expect(parseNativeCallEvent({ kind: 'failed', reason: 'x' })).toBeNull();
    expect(parseNativeCallEvent({ kind: 'failed', code: 'later', reason: 'x' })).toBeNull();
    expect(parseNativeCallEvent({ kind: 'stopped', reason: 'y' })).toEqual({
      kind: 'stopped',
      reason: 'y',
    });
    expect(parseNativeCallEvent({ kind: 'other' })).toBeNull();
    expect(parseNativeCallEvent(null)).toBeNull();
    expect(parseNativeCallEvent('started')).toBeNull();
  });
});
