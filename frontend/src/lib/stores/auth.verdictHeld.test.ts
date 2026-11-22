// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `refreshAnswerHeldByCaller`: the PIN gate asks WHY a PIN route refused its session and owns the
 * answer, so the app-wide session-expired reaction must not run (and close the gate) while it asks -
 * and must still run for everyone else, afterwards, and for a login that left meanwhile.
 */

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  saveUserLocally: vi.fn(),
  clearUserLocally: vi.fn(),
}));

const {
  refresh,
  refreshAnswerHeldByCaller,
  announceHeldVerdict,
  SessionExpiredError,
  isRefreshCredentialProvenDead,
  setSessionExpiredHandler,
  setToken,
} = await import('$lib/stores/auth');

const refusal = () => Response.json({ statusCode: 401, message: 'Unauthorized' }, { status: 401 });

function liveToken(): string {
  const claims = btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `h.${claims}.s`;
}

const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();
const handler = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  handler.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  setToken(liveToken());
  setSessionExpiredHandler(handler);
});

describe('refreshAnswerHeldByCaller', () => {
  it('throws the verdict to its caller and does NOT fire the session-expired handler while held', async () => {
    fetchMock.mockResolvedValue(refusal());
    const outcome = await refreshAnswerHeldByCaller('test').catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(SessionExpiredError);
    expect(handler).not.toHaveBeenCalled();
    // The verdict is still LATCHED: every later reader sees it.
    expect(isRefreshCredentialProvenDead()).toBe(true);
  });

  it('releases the hold when the call throws: a later refresh on the latch announces the verdict', async () => {
    fetchMock.mockResolvedValue(refusal());
    await refreshAnswerHeldByCaller('test').catch(() => {});
    expect(handler).not.toHaveBeenCalled();

    fetchMock.mockClear();
    const later = await refresh().catch((e: unknown) => e);

    expect(later).toBeInstanceOf(SessionExpiredError);
    expect(fetchMock).not.toHaveBeenCalled(); // answered from the latch
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('releases the hold when the call succeeds, so a later verdict is announced', async () => {
    fetchMock.mockResolvedValue(Response.json({ accessToken: liveToken() }, { status: 200 }));
    await refreshAnswerHeldByCaller('test').catch(() => {});
    fetchMock.mockResolvedValue(refusal());
    await refresh().catch(() => {});
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('announceHeldVerdict - a verdict held for a login that left reaches the app after all', () => {
  it('announces a latched, held verdict once the hold is over', async () => {
    fetchMock.mockResolvedValue(refusal());
    await refreshAnswerHeldByCaller('test').catch(() => {});
    expect(handler).not.toHaveBeenCalled();

    announceHeldVerdict();
    announceHeldVerdict(); // at most once per session

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('announces nothing when no verdict is latched', () => {
    announceHeldVerdict();
    expect(handler).not.toHaveBeenCalled();
  });
});
