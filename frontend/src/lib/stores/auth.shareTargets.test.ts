import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EVERY sign-out erases the conversations Android's share sheet suggests (sharing lot S5; user,
 * 2026-10-22): they are this account's conversation names, and an account switch must never show
 * them to the next one. Both ways out go through `clearAuthUnderway`, and both are pinned here -
 * the deliberate sign-out and the local one a tab takes when another tab deleted the account.
 */
const clearShareTargets = vi.fn(async (_reason: string) => {});
vi.mock('$lib/sharing/shareTargetsNative', () => ({
  clearShareTargets: (reason: string) => clearShareTargets(reason),
}));

const discardSharedOut = vi.fn(async (_reason: string) => {});
vi.mock('$lib/sharing/shareOutCleanup', () => ({
  discardSharedOut: (reason: string) => discardSharedOut(reason),
}));

const { clearAuth, clearAuthLocally } = await import('$lib/stores/auth');

beforeEach(() => {
  clearShareTargets.mockClear();
  discardSharedOut.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 }))
  );
});

describe('a sign-out erases the share sheet suggestions', () => {
  it('clearAuth clears them, beside the shared-out file', async () => {
    await clearAuth();
    expect(clearShareTargets).toHaveBeenCalledTimes(1);
    expect(clearShareTargets).toHaveBeenCalledWith('signed out');
    expect(discardSharedOut).toHaveBeenCalledTimes(1);
  });

  it('clearAuthLocally clears them too', async () => {
    await clearAuthLocally();
    expect(clearShareTargets).toHaveBeenCalledTimes(1);
  });
});
