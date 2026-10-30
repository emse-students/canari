import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parsePendingCallAccept,
  setPendingCallAccept,
  setPendingCallAcceptHandler,
  setSessionCaughtUp,
  takePendingCallAccept,
} from './pendingCallAccept';

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
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory())
        return name === 'wasm' || name === 'proto' ? [] : sources(path);
      return /\.(ts|svelte)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
    });

  it('only the native drain records an answer', () => {
    const recorders = sources(SRC)
      .filter((p) => readFileSync(p, 'utf8').includes('setPendingCallAccept('))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'));
    expect(recorders).toEqual(['lib/stores/pendingCallAccept.ts']);
    // A scan of the whole source tree: seconds under a loaded parallel run, never a hang.
  }, 60_000);

  it('the deep-link handler records nothing from acceptCall', () => {
    const hooks = readFileSync(join(SRC, 'hooks.client.ts'), 'utf8');
    expect(hooks).not.toMatch(/import\(\s*'\$lib\/stores\/pendingCallAccept'\s*\)/);
    expect(hooks).not.toMatch(/from '\$lib\/stores\/pendingCallAccept'/);
    expect(hooks).not.toMatch(/searchParams\.get\('acceptCall'\)/);
  });
});
