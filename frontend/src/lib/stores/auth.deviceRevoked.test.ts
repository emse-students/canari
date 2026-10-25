// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A refresh refused BECAUSE THE DEVICE WAS REVOKED BY ITS OWNER (`DEVICE_REVOKED_BY_OWNER`).
 *
 * An owner's revocation ends the device's session server-side, so the device's own revocation check
 * is asked with a dead credential and the refresh refusal is the only place left that can say why
 * (DEV-2, 2026-10-25). Pinned here: the refusal is typed at its throw, the cause is latched beside the
 * dead-credential verdict (so the latched answer stays typed), any other dead session stays a plain
 * one, and a new credential voids both.
 */

const currentUserId = vi.fn<() => string | null>(() => 'user-1');
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => currentUserId(),
  saveUserLocally: vi.fn(),
  clearUserLocally: vi.fn(),
}));

const {
  refresh,
  SessionExpiredError,
  SessionEndedByDeviceRevocationError,
  isSessionEndedByDeviceRevocation,
  isRefreshCredentialProvenDead,
  setSessionExpiredHandler,
  setToken,
} = await import('$lib/stores/auth');

/** A refusal as core-service sends it, Nest's envelope plus an optional code. */
function refusal(status: number, code?: string): Response {
  return Response.json(
    { statusCode: status, message: 'Unauthorized', ...(code ? { code } : {}) },
    { status }
  );
}

function liveToken(): string {
  const claims = btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `h.${claims}.s`;
}

const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  // Every case starts from a live credential: the verdict is latched across cases otherwise.
  setToken(liveToken());
});

describe('a refresh refused because the device was revoked by its owner', () => {
  it('throws the typed error, latches the cause, and announces it once', async () => {
    const handler = vi.fn(() => {
      // The reaction reads the cause from the latch, so it must be set BEFORE the announcement.
      expect(isSessionEndedByDeviceRevocation()).toBe(true);
    });
    setSessionExpiredHandler(handler);
    fetchMock.mockResolvedValue(refusal(401, 'DEVICE_REVOKED_BY_OWNER'));

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(SessionEndedByDeviceRevocationError);
    // Still a dead session for every consumer that only stops on one.
    expect(outcome).toBeInstanceOf(SessionExpiredError);
    expect(isRefreshCredentialProvenDead()).toBe(true);
    expect(isSessionEndedByDeviceRevocation()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    setSessionExpiredHandler(null);
  });

  it('answers a later caller from the latch, still typed, without asking again', async () => {
    fetchMock.mockResolvedValue(refusal(401, 'DEVICE_REVOKED_BY_OWNER'));
    await refresh().catch(() => {});
    fetchMock.mockClear();

    await expect(refresh()).rejects.toBeInstanceOf(SessionEndedByDeviceRevocationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves any other dead session a plain one - only the code says revoked', async () => {
    fetchMock.mockResolvedValue(refusal(401));

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(SessionExpiredError);
    expect(outcome).not.toBeInstanceOf(SessionEndedByDeviceRevocationError);
    expect(isSessionEndedByDeviceRevocation()).toBe(false);
  });

  it('never reads a transport failure as a revocation', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).not.toBeInstanceOf(SessionExpiredError);
    expect(isRefreshCredentialProvenDead()).toBe(false);
    expect(isSessionEndedByDeviceRevocation()).toBe(false);
  });

  it('never believes the code from an edge - a body without our envelope proves nothing', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ status: 401, code: 'DEVICE_REVOKED_BY_OWNER_X' }, { status: 401 })
    );

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).not.toBeInstanceOf(SessionExpiredError);
    expect(isSessionEndedByDeviceRevocation()).toBe(false);
  });

  it('a new credential voids the cause with the verdict', async () => {
    fetchMock.mockResolvedValue(refusal(401, 'DEVICE_REVOKED_BY_OWNER'));
    await refresh().catch(() => {});
    expect(isSessionEndedByDeviceRevocation()).toBe(true);

    setToken(liveToken());

    expect(isSessionEndedByDeviceRevocation()).toBe(false);
    expect(isRefreshCredentialProvenDead()).toBe(false);
  });
});
