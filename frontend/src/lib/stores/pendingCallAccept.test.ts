import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markConnectionCaughtUp,
  parsePendingCallAccept,
  setPendingCallAccept,
  setPendingCallAcceptHandler,
  setSessionCaughtUp,
  takePendingCallAccept,
  whenSessionCaughtUp,
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

describe('whenSessionCaughtUp - one proof the join waits for', () => {
  it('resolves at once when the session is caught up', async () => {
    setSessionCaughtUp(true);
    await expect(whenSessionCaughtUp()).resolves.toBeUndefined();
  });

  it('waits for the catch-up, and a socket that closed waits for the next one', async () => {
    let done = false;
    void whenSessionCaughtUp().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    setSessionCaughtUp(true);
    await Promise.resolve();
    expect(done).toBe(true);

    setSessionCaughtUp(false);
    let next = false;
    void whenSessionCaughtUp().then(() => (next = true));
    await Promise.resolve();
    expect(next).toBe(false);
  });

  it('a catch-up that ended on a dropped socket is no catch-up, nor a stale one', async () => {
    setSessionCaughtUp(true);
    // The socket dropped during the fetch: the flag must not stay true for the reconnect to inherit.
    markConnectionCaughtUp(false);
    let done = false;
    void whenSessionCaughtUp().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    // The reconnect's own catch-up decides.
    markConnectionCaughtUp(true);
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('the session reports the socket state at the end of the catch-up, not a constant', () => {
    const session = readSource('src/lib/composables/useChatSession.svelte.ts');
    expect(session).toMatch(
      /onConnectionCaughtUp: \(\) => \{\s*markConnectionCaughtUp\(isWsConnected\);/
    );
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
