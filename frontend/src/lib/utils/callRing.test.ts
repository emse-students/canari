// @vitest-environment happy-dom
/**
 * THE IN-APP INCOMING RING IS CANARI'S RING, LOOPED, AND ENDS WITH THE CALL (owner, 2026-11-01).
 *
 * Android rings natively through the `canariCall` bridge (the RINGTONE stream, the ringer mode
 * honoured); every other platform loops the rendered file on the shared tone output. Pinned against
 * a recording bridge and a fake `AudioContext`: which output a ring takes, that the loop is the
 * node's own (`loop = true`, no timer), that a stop ends it and so releases the output, that the
 * app's sounds setting is carried, and that the ring comes back with the app on screen.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AndroidCallBridge } from '$lib/mobile/androidCallService';
import {
  RING_IN_APP_GAIN,
  RING_SRC,
  resetCallRingForTest,
  startCallRing,
  stopCallRing,
  type CallRingHost,
} from '$lib/utils/callRing';
import { resetToneOutputForTest } from '$lib/utils/toneOutput';

class FakeSource extends EventTarget {
  buffer: unknown = null;
  loop = false;
  started: number | null = null;
  stopped = false;
  connect = vi.fn();
  disconnect = vi.fn();
  start(at: number) {
    this.started = at;
  }
  stop() {
    this.stopped = true;
    this.dispatchEvent(new Event('ended'));
  }
}

const sources: FakeSource[] = [];
const gains: { gain: { value: number } }[] = [];
const contexts: FakeContext[] = [];

class FakeContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {};
  resume = vi.fn(() => Promise.resolve());
  suspend = vi.fn(() => {
    this.state = 'suspended';
    return Promise.resolve();
  });
  close = vi.fn(() => Promise.resolve());
  createBufferSource() {
    const s = new FakeSource();
    sources.push(s);
    return s;
  }
  createGain() {
    const g = { gain: { value: 1 }, connect: vi.fn() };
    gains.push(g);
    return g;
  }
  constructor() {
    contexts.push(this);
  }
}

const DECODED = { duration: 5 } as unknown as AudioBuffer;

class FakeOfflineContext {
  decodeAudioData = vi.fn(() => Promise.resolve(DECODED));
}

function bridgeHost(): { host: CallRingHost; calls: string[] } {
  const calls: string[] = [];
  const bridge = {
    ringStart: (callId: string, appSounds: boolean) => calls.push(`start ${callId} ${appSounds}`),
    ringStop: (callId: string, reason: string) => calls.push(`stop ${callId} ${reason}`),
  } as unknown as AndroidCallBridge;
  return {
    host: {
      canariCall: bridge,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    calls,
  };
}

const noBridge: CallRingHost = { addEventListener: () => {}, removeEventListener: () => {} };

/** Lets the fetch and the decode settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sources.length = 0;
  gains.length = 0;
  contexts.length = 0;
  resetCallRingForTest();
  resetToneOutputForTest();
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineContext);
  fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  stopCallRing('test over');
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
});

it('on Android, rings natively with the app sounds setting, and stops natively', async () => {
  const { host, calls } = bridgeHost();
  startCallRing('call-1', true, host);
  await settle();
  expect(calls).toEqual(['start call-1 true']);
  expect(fetchMock, 'no web sound on Android').not.toHaveBeenCalled();
  stopCallRing('answered');
  expect(calls).toEqual(['start call-1 true', 'stop call-1 answered']);
});

it('a second start for the same call rings nothing more; another call replaces the first', () => {
  const { host, calls } = bridgeHost();
  startCallRing('call-1', false, host);
  startCallRing('call-1', false, host);
  startCallRing('call-2', false, host);
  expect(calls).toEqual([
    'start call-1 false',
    'stop call-1 another call rings',
    'start call-2 false',
  ]);
});

it('elsewhere, loops the rendered ring on the tone output, with no timer', async () => {
  startCallRing('call-1', true, noBridge);
  await settle();
  expect(fetchMock).toHaveBeenCalledWith(RING_SRC);
  expect(sources).toHaveLength(1);
  const [source] = sources;
  expect(source.buffer).toBe(DECODED);
  expect(source.loop).toBe(true);
  expect(source.started).not.toBeNull();
  expect(gains[0].gain.value).toBe(RING_IN_APP_GAIN);
});

it('a stop ends the loop, which releases the tone output', async () => {
  startCallRing('call-1', true, noBridge);
  await settle();
  stopCallRing('declined');
  expect(sources[0].stopped).toBe(true);
  expect(contexts[0].suspend).toHaveBeenCalled();
});

it('a ring stopped before its file is decoded never plays', async () => {
  startCallRing('call-1', true, noBridge);
  stopCallRing('cancelled');
  await settle();
  expect(sources).toHaveLength(0);
});

it('the app sounds off: nothing plays on the tone output', async () => {
  startCallRing('call-1', false, noBridge);
  await settle();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(sources).toHaveLength(0);
});

it('a ring still up when the app comes back on screen starts again', async () => {
  const { host, calls } = bridgeHost();
  startCallRing('call-1', true, host);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(calls).toEqual(['start call-1 true', 'start call-1 true']);
  stopCallRing('answered');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(calls.filter((c) => c.startsWith('start'))).toHaveLength(2);
});

it('a stop with nothing ringing does nothing', () => {
  const { host, calls } = bridgeHost();
  stopCallRing('idle at startup');
  startCallRing('call-1', true, host);
  stopCallRing('answered');
  stopCallRing('again');
  expect(calls).toEqual(['start call-1 true', 'stop call-1 answered']);
});
