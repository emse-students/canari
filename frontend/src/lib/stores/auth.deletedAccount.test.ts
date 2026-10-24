// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two things an account deletion asks of the auth store (WP-DEL-LOCAL):
 *
 * - a tab told by ANOTHER tab that its account was deleted signs out LOCALLY only - the refresh
 *   cookie and the native credential are one per origin, and by then they may be another account's;
 * - the resumed wipe of a deleted account can ask who is signed in here and whether a sign-in is in
 *   flight, and wait for it to land.
 */

let savedUserId: string | null = 'user-1';
const clearUserLocally = vi.fn(() => {
  savedUserId = null;
});
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => savedUserId,
  getSavedUserId: () => savedUserId,
  saveUserLocally: vi.fn(),
  clearUserLocally: () => clearUserLocally(),
}));

const clearNativeRefreshToken = vi.fn(async () => {});
vi.mock('$lib/stores/nativeRefreshToken', () => ({
  REFRESH_HEADER: 'X-Canari-Refresh',
  usesBodyRefreshTransport: () => true,
  readNativeRefreshToken: async () => 'stored-credential',
  writeNativeRefreshToken: vi.fn(async () => {}),
  clearNativeRefreshToken: () => clearNativeRefreshToken(),
}));

const { clearAuth, clearAuthLocally, accountLiveness, handleOidcCallback, refresh, setToken } =
  await import('$lib/stores/auth');
const { isDeletedAccountHere, forgetDeletedAccountOnSignIn } =
  await import('$lib/utils/deletedAccountMarker');

const {
  markDeletedAccountWipePending,
  pendingDeletedAccountWipes,
  resumePendingDeletedAccountWipes,
  wipeDeletedAccountLocalData,
} = await import('$lib/utils/accountLocalWipe');
/** The live wipe right after the DELETE, in the realm that ran the session. */
const AFTER_DELETE = { closeThisRunsHandles: false, expectNativeDatabase: false };
const { ACCOUNT_KEY } = await import('$lib/utils/accountLocalKeys');
const { m } = await import('$lib/paraglide/messages');

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function tokenFor(sub: string): string {
  return 'h.' + btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.s';
}

beforeEach(() => {
  savedUserId = 'user-1';
  fetchMock.mockReset();
  clearUserLocally.mockClear();
  clearNativeRefreshToken.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  setToken(tokenFor('user-1'));
});

describe('clearAuthLocally - the tab another tab told of a deletion', () => {
  it('forgets this tab identity and sends NO logout on the shared cookie', async () => {
    await clearAuthLocally();
    expect(clearUserLocally).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // Nor the native credential, which another account may hold by now.
    expect(clearNativeRefreshToken).not.toHaveBeenCalled();
    expect(accountLiveness.isLive('user-1')).toBe(false);
  });

  it('is not what clearAuth does: a deliberate sign-out still revokes', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await clearAuth();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/auth/logout');
    expect(clearNativeRefreshToken).toHaveBeenCalledTimes(1);
  });
});

describe('accountLiveness - what the resumed deletion wipe asks', () => {
  it('names only the subject of a token that landed here, never the saved identity', () => {
    expect(accountLiveness.isLive('user-1')).toBe(true);
    expect(accountLiveness.isLive('user-2')).toBe(false);
    savedUserId = null;
    // The token alone says who signed in.
    expect(accountLiveness.isLive('user-1')).toBe(true);
    // And the saved identity alone says NOTHING: a kill before `clearAuth()` leaves it naming the
    // deleted account (P2-1 of the review of #2023).
    savedUserId = 'user-1';
    setToken('not-a-jwt');
    expect(accountLiveness.isLive('user-1')).toBe(false);
  });

  it('reports a refresh in flight as a sign-in, and settles once it lands', async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    savedUserId = null;
    // Expire the in-memory token so a refresh is actually sent.
    setToken('not-a-jwt');
    const flight = refresh().catch(() => {});
    expect(accountLiveness.signInInFlight()).toBe(true);

    let settled = false;
    const waiting = accountLiveness.whenSignInSettled().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    answer(
      new Response(JSON.stringify({ access_token: tokenFor('user-2') }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await flight;
    await waiting;
    expect(settled).toBe(true);
    expect(accountLiveness.signInInFlight()).toBe(false);
  });
});

describe('the resumed deletion wipe, against the real accountLiveness (P2-1 of #2023)', () => {
  const deleted: string[] = [];
  beforeEach(() => {
    deleted.length = 0;
    localStorage.clear();
    vi.stubGlobal('indexedDB', {
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        deleted.push(name);
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
  });

  it('a kill before clearAuth left the saved user at the deleted account: the wipe still runs', async () => {
    // The process was killed between the marker and `clearAuth()`: `canari_saved_user` still
    // names user-1, and this start has no token (an offline cold start).
    savedUserId = 'user-1';
    setToken('not-a-jwt');
    markDeletedAccountWipePending('user-1');
    localStorage.setItem(ACCOUNT_KEY.salonUnsent('user-1'), 'plaintext');
    await resumePendingDeletedAccountWipes(accountLiveness);
    expect(deleted).toContain('CanariDB_user-1');
    expect(localStorage.getItem(ACCOUNT_KEY.salonUnsent('user-1'))).toBeNull();
    expect(pendingDeletedAccountWipes()).toEqual([]);
  });

  it('the subject signed in again (a token naming it landed here): nothing wiped, marker dropped', async () => {
    setToken(tokenFor('user-1'));
    markDeletedAccountWipePending('user-1');
    localStorage.setItem(ACCOUNT_KEY.salonUnsent('user-1'), 'the new session');
    await resumePendingDeletedAccountWipes(accountLiveness);
    expect(deleted).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.salonUnsent('user-1'))).toBe('the new session');
    expect(pendingDeletedAccountWipes()).toEqual([]);
  });
});

describe('the subject comes back as a NEW account (scenario A of the fourth review of #2023)', () => {
  const deleted: string[] = [];
  beforeEach(() => {
    deleted.length = 0;
    localStorage.clear();
    vi.stubGlobal('indexedDB', {
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        deleted.push(name);
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
  });

  /** A successful OIDC callback for `sub`: the server let the subject in, its erasure completed. */
  async function signInAgainAs(sub: string): Promise<void> {
    localStorage.setItem('canari_oidc_state', 'st');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: tokenFor(sub), user: { id: sub } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await handleOidcCallback('code', 'st');
  }

  it('the callback drops the marker, and a later tokenless resume wipes nothing of the new account', async () => {
    // A marker that outlived the deletion (a refused case collision, a blocked delete).
    markDeletedAccountWipePending('user-1');
    await signInAgainAs('user-1');
    expect(pendingDeletedAccountWipes()).toEqual([]);
    expect(isDeletedAccountHere('user-1')).toBe(false);

    // The new account's data, then a start that holds NO token: a second tab before its refresh,
    // or a native cold start offline - exactly where `isLive` cannot see the new session.
    localStorage.setItem(ACCOUNT_KEY.salonUnsent('user-1'), 'the new account');
    setToken('not-a-jwt');
    await resumePendingDeletedAccountWipes(accountLiveness);
    expect(deleted).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.salonUnsent('user-1'))).toBe('the new account');
  });

  it('a callback for ANOTHER subject leaves the deleted account owed', async () => {
    markDeletedAccountWipePending('user-1');
    await signInAgainAs('user-2');
    expect(pendingDeletedAccountWipes()).toEqual(['user-1']);
    expect(isDeletedAccountHere('user-1')).toBe(true);
  });

  it('a refused callback (erasure still running) drops nothing', async () => {
    markDeletedAccountWipePending('user-1');
    localStorage.setItem('canari_oidc_state', 'st');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'ACCOUNT_ERASURE_PENDING' }), { status: 403 })
    );
    await expect(handleOidcCallback('code', 'st')).rejects.toThrow();
    expect(pendingDeletedAccountWipes()).toEqual(['user-1']);
  });

  it('words a subject the server refuses as a user id through Paraglide, never its English', async () => {
    localStorage.setItem('canari_oidc_state', 'st');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'USER_ID_INVALID', rule: 'colon', message: 'server English' }),
        { status: 400 }
      )
    );
    await expect(handleOidcCallback('code', 'st')).rejects.toThrow(m.auth_user_id_invalid());
  });
});

describe('isDeletedAccountHere - what every login asks before opening a store (scenario B)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('indexedDB', {
      deleteDatabase: () => {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
  });

  it('holds while the wipe is owed, and AFTER the live wipe finished and dropped the marker', async () => {
    // The offline unlock read its key before the wipe ran; by the time it asks, the wipe may be done
    // and the marker gone - the process that ran the DELETE still knows the account was deleted.
    markDeletedAccountWipePending('user-3');
    expect(isDeletedAccountHere('user-3')).toBe(true);
    expect(await wipeDeletedAccountLocalData('user-3', AFTER_DELETE)).toEqual([]);
    expect(pendingDeletedAccountWipes()).toEqual([]);
    expect(isDeletedAccountHere('user-3')).toBe(true);
    expect(isDeletedAccountHere('user-4')).toBe(false);
  });

  it('is lifted by an online sign-in of that subject, and by nothing else', async () => {
    markDeletedAccountWipePending('user-5');
    await wipeDeletedAccountLocalData('user-5', AFTER_DELETE);
    expect(isDeletedAccountHere('user-5')).toBe(true);
    forgetDeletedAccountOnSignIn('user-5');
    expect(isDeletedAccountHere('user-5')).toBe(false);
  });

  it('a RESUMED wipe leaves no in-process flag: a sign-in from another tab must not be refused here', async () => {
    // Tab A resumes a stale marker for user-6; the user then signs in again from tab B, whose
    // callback drops the shared marker but cannot reach tab A's memory. Tab A's next login of
    // user-6 must find the account NOT deleted (P3 of the fifth review of #2023).
    setToken('not-a-jwt');
    markDeletedAccountWipePending('user-6');
    expect(isDeletedAccountHere('user-6')).toBe(true);
    await resumePendingDeletedAccountWipes(accountLiveness);
    expect(pendingDeletedAccountWipes()).toEqual([]);
    expect(isDeletedAccountHere('user-6')).toBe(false);
  });
});
