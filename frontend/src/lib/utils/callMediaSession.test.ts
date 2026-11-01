import { describe, it, expect, vi, beforeEach } from 'vitest';

const logs: string[] = [];
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: (l: string) => logs.push(l) }));

import { applyCallMediaSession, clearCallMediaSession } from './callMediaSession';

/** A media session that knows only the actions it is given, and throws on the rest like Chromium. */
function fakeSession(known: string[]) {
  const handlers = new Map<string, (() => void) | null>();
  return {
    metadata: null as unknown,
    playbackState: 'none',
    handlers,
    micActive: undefined as boolean | undefined,
    setActionHandler(action: string, h: (() => void) | null) {
      if (!known.includes(action)) throw new TypeError(`unknown action ${action}`);
      handlers.set(action, h);
    },
    setMicrophoneActive(active: boolean) {
      this.micActive = active;
    },
  };
}

const params = () => ({
  title: 'Bob',
  artist: 'Canari',
  muted: true,
  onHangup: vi.fn(),
  onToggleMicrophone: vi.fn(),
});

beforeEach(() => {
  // A new call: what the previous test's call said is said again.
  clearCallMediaSession({});
  logs.length = 0;
});

describe('the call on the OS media session', () => {
  it('says so, and does nothing else, on an engine without the API', () => {
    expect(applyCallMediaSession({}, params())).toBe(false);
    expect(logs.join('\n')).toContain('no Media Session API');
  });

  // 313 identical lines in 46 s of a video ring (Android 1.5.3, 2026-10-31): the surface re-applies
  // the session on every change it shows, and the engine's answer does not change within a call.
  it('says a missing API ONCE per call, however often the surface re-applies', () => {
    for (let i = 0; i < 50; i++) applyCallMediaSession({}, params());
    expect(logs.filter((l) => l.includes('no Media Session API'))).toHaveLength(1);
    clearCallMediaSession({});
    applyCallMediaSession({}, params());
    expect(logs.filter((l) => l.includes('no Media Session API'))).toHaveLength(2);
  });

  it('names a refused action once per call', () => {
    const session = fakeSession(['hangup']);
    const host = { mediaSession: session as unknown as MediaSession };
    applyCallMediaSession(host, params());
    applyCallMediaSession(host, params());
    expect(logs.filter((l) => l.includes("'togglemicrophone' unsupported"))).toHaveLength(1);
  });

  it('wires hang-up and the microphone, and mirrors the mute', () => {
    const session = fakeSession(['hangup', 'togglemicrophone']);
    const p = params();
    applyCallMediaSession({ mediaSession: session as unknown as MediaSession }, p);
    session.handlers.get('hangup')?.();
    session.handlers.get('togglemicrophone')?.();
    expect(p.onHangup).toHaveBeenCalledOnce();
    expect(p.onToggleMicrophone).toHaveBeenCalledOnce();
    expect(session.playbackState).toBe('playing');
    expect(session.micActive).toBe(false);
  });

  it('keeps the other action when one is unknown, and names the refused one', () => {
    const session = fakeSession(['hangup']);
    applyCallMediaSession({ mediaSession: session as unknown as MediaSession }, params());
    expect(session.handlers.has('hangup')).toBe(true);
    expect(logs.join('\n')).toContain("'togglemicrophone' unsupported");
  });

  it('clears the handlers and the state when the call goes', () => {
    const session = fakeSession(['hangup', 'togglemicrophone']);
    const host = { mediaSession: session as unknown as MediaSession };
    applyCallMediaSession(host, params());
    clearCallMediaSession(host);
    expect(session.handlers.get('hangup')).toBeNull();
    expect(session.playbackState).toBe('none');
    expect(session.metadata).toBeNull();
  });
});
