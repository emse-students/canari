import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EVERY SIGN-OUT ERASES A SHARE INTO CANARI (user, 2026-10-22): the erase is tested on its own
 * (`incomingShareSignOut.test.ts`), and this pins that BOTH exits reach it - the sign-out a member
 * chooses, and the local one another tab's account deletion makes.
 */
const erase = vi.hoisted(() => vi.fn(async (_reason: string) => {}));
const discardOut = vi.hoisted(() => vi.fn(async (_reason: string) => {}));

vi.mock('$lib/mobile/incomingShareSignOut', () => ({ eraseIncomingShare: erase }));
vi.mock('$lib/sharing/shareOutCleanup', () => ({ discardSharedOut: discardOut }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  saveUserLocally: vi.fn(),
  clearUserLocally: vi.fn(),
}));

const { clearAuth, clearAuthLocally } = await import('$lib/stores/auth');

describe('a sign-out erases the share into Canari', () => {
  beforeEach(() => {
    erase.mockClear();
    discardOut.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 }))
    );
  });

  it('on the sign-out a member chooses', async () => {
    await clearAuth();
    expect(erase).toHaveBeenCalledExactlyOnceWith('signed out');
    expect(discardOut).toHaveBeenCalledExactlyOnceWith('signed out');
  });

  it('on the local sign-out another tab makes', async () => {
    await clearAuthLocally();
    expect(erase).toHaveBeenCalledExactlyOnceWith('signed out');
    expect(discardOut).toHaveBeenCalledExactlyOnceWith('signed out');
  });
});
