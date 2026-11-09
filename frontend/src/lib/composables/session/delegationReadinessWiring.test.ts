// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionCallbacks, SessionContext } from './sessionTypes';

/**
 * WHAT A FOLLOWER TAB'S HANDED-OVER COMMIT MEETS IN THIS TAB FOLLOWS THE SESSION'S OWN FLAGS - read
 * over the REAL composable (`useChatSession`), whose two setters are the one writer of `isLoggedIn`
 * and `isLoginInProgress` (round 2 of the review of #3160). The readiness used to be derived in a
 * component effect from `isLoginInProgress`, a plain boolean no effect re-runs on, so a vault
 * auto-login read `unavailable` throughout and could stay `starting` after it.
 */

vi.mock('$lib/mlsService', () => ({
  createMlsService: () => ({ pauseSocket: vi.fn(), isWsOpen: () => false, destroy: vi.fn() }),
}));
vi.mock('$lib/services/CallService', () => ({
  CallService: class {
    readonly callState = { subscribe: () => () => {} };
    setChatNotifier() {}
  },
}));

const setDelegationReadiness = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/tabCommitDelegation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/tabCommitDelegation')>()),
  setDelegationReadiness,
}));

// The login itself is not under test: it hands over the context the composable built, and the case
// drives that context's setters as `loginImpl` does at each start and end.
let captured: SessionContext | null = null;
vi.mock('./sessionAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sessionAuth')>()),
  loginImpl: vi.fn(async (ctx: SessionContext) => {
    captured = ctx;
  }),
}));

const { useChatSession } = await import('../useChatSession.svelte');

const last = () => setDelegationReadiness.mock.calls.at(-1)?.[0];

describe("the session's flags set the delegation readiness", () => {
  it('a login running is starting, a live session ready, a session that ended unavailable', async () => {
    const session = useChatSession();
    await session.login({ log: vi.fn() } as unknown as ChatSessionCallbacks);
    const ctx = captured as SessionContext;

    // The shell raises the flag before the login (the layout guard), through the API setter.
    session.isLoginInProgress = true;
    expect(last()).toBe('starting');

    ctx.setIsLoggedIn(true);
    expect(last()).toBe('ready');
    ctx.setIsLoginInProgress(false);
    expect(last()).toBe('ready');

    // A sign-out.
    ctx.setIsLoggedIn(false);
    expect(last()).toBe('unavailable');

    // A login that ends early (the PIN keypad is owed): unavailable, never left at starting.
    ctx.setIsLoginInProgress(true);
    expect(last()).toBe('starting');
    ctx.setIsLoginInProgress(false);
    expect(last()).toBe('unavailable');
  });
});
