import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markConnectionCaughtUp,
  parsePendingCallAccept,
  setPendingCallAccept,
  setPendingCallAcceptHandler,
  setSessionCaughtUp,
  takePendingCallAccept,
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

describe('a native answer is acted on once the session has caught up', () => {
  it('held until the catch-up, then handed over once', () => {
    const handler = vi.fn();
    setPendingCallAcceptHandler(handler);
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    expect(handler).not.toHaveBeenCalled();

    setSessionCaughtUp(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('the session caught up');
  });

  it('acted on at once when the session is already caught up', () => {
    const handler = vi.fn();
    setPendingCallAcceptHandler(handler);
    setSessionCaughtUp(true);
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    expect(handler).toHaveBeenCalledWith('the answer was recorded');
  });

  it('a socket that closed waits for the next catch-up', () => {
    const handler = vi.fn();
    setPendingCallAcceptHandler(handler);
    setSessionCaughtUp(true);
    setSessionCaughtUp(false);
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    expect(handler).not.toHaveBeenCalled();
  });

  it('a catch-up that ended on a dropped socket is no catch-up, nor a stale one', () => {
    const handler = vi.fn();
    setPendingCallAcceptHandler(handler);
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });

    // The socket dropped during the fetch: the catch-up's end must not act, nor leave the flag
    // true for the reconnect to inherit.
    markConnectionCaughtUp(false);
    expect(handler).not.toHaveBeenCalled();

    // The reconnect's own catch-up decides.
    markConnectionCaughtUp(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a stale true flag is cleared by a catch-up on a dropped socket', () => {
    const handler = vi.fn();
    setPendingCallAcceptHandler(handler);
    setSessionCaughtUp(true);
    markConnectionCaughtUp(false);
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() });
    expect(handler).not.toHaveBeenCalled();
  });

  it('the session reports the socket state at the end of the catch-up, not a constant', () => {
    const session = readSource('src/lib/composables/useChatSession.svelte.ts');
    expect(session).toMatch(
      /onConnectionCaughtUp: \(\) => \{\s*markConnectionCaughtUp\(isWsConnected\);/
    );
  });

  it('drops an answer recorded too long ago', () => {
    setPendingCallAccept({ ...ANSWER, acceptedAt: Date.now() - 10 * 60_000 });
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
