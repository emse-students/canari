import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abandonCatchUpWaiters,
  markConnectionCaughtUp,
  parsePendingCallAccept,
  setPendingCallAccept,
  setPendingCallAcceptHandler,
  setSessionCaughtUp,
  SessionCatchUpAbandonedError,
  takePendingCallAccept,
  clearPendingCallAccept,
  hasPendingCallAccept,
  whenNextCatchUp,
} from './pendingCallAccept';
import { readSource, relativeTo, sourceFiles } from '../../test/sourceTree';

vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

const ANSWER = {
  groupId: 'group-1',
  callId: 'call-1',
  hasVideo: false,
  callerId: 'peer@example.org',
};

afterEach(() => {
  setSessionCaughtUp(false);
  takePendingCallAccept();
  setPendingCallAcceptHandler(null);
});

describe('a native answer is handed to the session at once - the catch-up is not its gate', () => {
  it('handed over as soon as it is recorded, before any catch-up', () => {
    const handler = vi.fn();
    setPendingCallAcceptHandler(handler);
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('the answer was recorded');
  });

  it('an answer drained before the session registered is handed over at the registration', () => {
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    const handler = vi.fn();
    setPendingCallAcceptHandler(handler);
    expect(handler).toHaveBeenCalledWith('the session registered its handler');
  });

  it('a catch-up hands nothing over a second time', () => {
    const handler = vi.fn((_why: string) => takePendingCallAccept());
    setPendingCallAcceptHandler(handler);
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    setSessionCaughtUp(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('drops an answer recorded too long ago', () => {
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() - 10 * 60_000 });
    expect(takePendingCallAccept()).toBeNull();
  });
});

describe('whenNextCatchUp - an event the call wait re-reads its facts on, never a proof', () => {
  it('a session already caught up does not resolve it: only the NEXT catch-up does', async () => {
    setSessionCaughtUp(true);
    let done = false;
    void whenNextCatchUp().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    setSessionCaughtUp(false);
    setSessionCaughtUp(true);
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('a catch-up that ended on a dropped socket wakes nothing, the reconnect one does', async () => {
    let done = false;
    void whenNextCatchUp().then(() => (done = true));
    markConnectionCaughtUp(false);
    await Promise.resolve();
    expect(done).toBe(false);
    markConnectionCaughtUp(true);
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('an aborted waiter is removed and rejected with the reason', async () => {
    const stop = new AbortController();
    const wait = whenNextCatchUp(stop.signal);
    stop.abort(new Error('the call ended'));
    await expect(wait).rejects.toThrow('the call ended');
    expect(abandonCatchUpWaiters('nothing left')).toBe(0);
  });

  it('a sign-out rejects every waiter, so the catch-up of the next account wakes none of them', async () => {
    const wait = whenNextCatchUp();
    expect(abandonCatchUpWaiters('signed out')).toBe(1);
    await expect(wait).rejects.toBeInstanceOf(SessionCatchUpAbandonedError);
    setSessionCaughtUp(true);
    expect(abandonCatchUpWaiters('again')).toBe(0);
  });

  it('the session reports the socket state at the end of the catch-up, not a constant', () => {
    const session = readSource('src/lib/composables/useChatSession.svelte.ts');
    expect(session).toMatch(
      /onConnectionCaughtUp: \(\) => \{\s*markConnectionCaughtUp\(isWsConnected\);/
    );
  });
});

describe('one pending answer, never overwritten, never inherited', () => {
  it('a second answer of ANOTHER call is refused while the first is fresh', () => {
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    setPendingCallAccept({ ...ANSWER, callId: 'call-2', acceptedAt: Date.now() });
    expect(hasPendingCallAccept('call-1')).toBe(true);
    expect(hasPendingCallAccept('call-2')).toBe(false);
  });

  it('the same call answered again replaces it', () => {
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() - 1000 });
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    expect(takePendingCallAccept()?.callId).toBe('call-1');
  });

  it('a sign-out drops it: the next account never joins it', () => {
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    clearPendingCallAccept('signed out');
    expect(takePendingCallAccept()).toBeNull();
  });
});

describe('the native accept file', () => {
  it('is read whole, its instant the native tap', () => {
    const raw = JSON.stringify({ ...ANSWER, acceptedAt: 1_700_000_000_000, rungAt: 1 });
    expect(parsePendingCallAccept(raw)).toEqual({ ...ANSWER, acceptedAt: 1_700_000_000_000 });
  });

  it('is no answer without the instant of the tap - never stamped on drain', () => {
    expect(parsePendingCallAccept(JSON.stringify(ANSWER))).toBeNull();
  });

  it('is no answer without a group or a call', () => {
    expect(parsePendingCallAccept(JSON.stringify({ callId: 'c', acceptedAt: 1 }))).toBeNull();
    expect(parsePendingCallAccept('not json')).toBeNull();
  });
});

/**
 * THE NATIVE ANSWER IS CARRIED BY A PRIVATE INTENT, NEVER A PUBLIC URL. The only door into the held
 * intent is the native file drained here: no other source file records one, and the deep-link
 * handler reads no answer from a link.
 */
describe('a link never answers a call', () => {
  // The run's source snapshot: the scan is a filter over strings in memory, with no disk walk.
  it('only the native drain records an answer', () => {
    const sources = sourceFiles({
      under: 'src',
      extensions: ['ts', 'svelte'],
      tests: 'exclude',
      skipDirs: ['wasm', 'proto'],
    });
    expect(sources.map((f) => f.path)).toContain('src/lib/stores/pendingCallAccept.ts');
    const recorders = sources
      .filter(({ text }) => text.includes('setPendingCallAccept('))
      .map(({ path }) => relativeTo(path, 'src'));
    expect(recorders).toEqual(['lib/stores/pendingCallAccept.ts']);
  });

  it('the deep-link handler records nothing from acceptCall', () => {
    const hooks = readSource('src/hooks.client.ts');
    expect(hooks).not.toMatch(/import\(\s*'\$lib\/stores\/pendingCallAccept'\s*\)/);
    expect(hooks).not.toMatch(/from '\$lib\/stores\/pendingCallAccept'/);
    expect(hooks).not.toMatch(/searchParams\.get\('acceptCall'\)/);
  });
});
