// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A refresh refused BECAUSE A DEVICE WAS REVOKED BY ITS OWNER (`DEVICE_REVOKED_BY_OWNER`).
 *
 * An owner's revocation ends the device's session server-side, so the device's own revocation check
 * is asked with a dead credential and the refresh refusal is the only place left that can say why
 * (DEV-2, 2026-10-25). Pinned here: the refusal is typed at its throw and NAMES the device and
 * account (a reset follows only when they are this install's), the cause is latched beside the
 * dead-credential verdict (so the latched answer stays typed), any other dead session stays a plain
 * one, a refusal that is not core-service's resets nothing, and a new credential voids both.
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
  RefreshFailedError,
  revokedDeviceOfEndedSession,
  isRefreshCredentialProvenDead,
  setSessionExpiredHandler,
  setToken,
} = await import('$lib/stores/auth');

const REVOKED = { userId: 'user-1', deviceId: 'phone-1' };

/** A refusal as core-service sends it, Nest's envelope plus an optional code and fields. */
function refusal(status: number, fields: Record<string, unknown> = {}): Response {
  return Response.json({ statusCode: status, message: 'Unauthorized', ...fields }, { status });
}
const revokedRefusal = () => refusal(401, { code: 'DEVICE_REVOKED_BY_OWNER', ...REVOKED });

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

describe('a refresh refused because a device was revoked by its owner', () => {
  it('throws the typed error naming the device, latches it, and announces it once', async () => {
    const handler = vi.fn(() => {
      // The reaction reads the cause from the latch, so it must be set BEFORE the announcement.
      expect(revokedDeviceOfEndedSession()).toEqual(REVOKED);
    });
    setSessionExpiredHandler(handler);
    fetchMock.mockResolvedValue(revokedRefusal());

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(SessionEndedByDeviceRevocationError);
    expect((outcome as InstanceType<typeof SessionEndedByDeviceRevocationError>).revoked).toEqual(
      REVOKED
    );
    // Still a dead session for every consumer that only stops on one.
    expect(outcome).toBeInstanceOf(SessionExpiredError);
    expect(isRefreshCredentialProvenDead()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    setSessionExpiredHandler(null);
  });

  it('answers a later caller from the latch, still typed and still naming it, without asking again', async () => {
    fetchMock.mockResolvedValue(revokedRefusal());
    await refresh().catch(() => {});
    fetchMock.mockClear();

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(SessionEndedByDeviceRevocationError);
    expect((outcome as InstanceType<typeof SessionEndedByDeviceRevocationError>).revoked).toEqual(
      REVOKED
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves any other dead session a plain one - only the code says revoked', async () => {
    fetchMock.mockResolvedValue(refusal(401));

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(SessionExpiredError);
    expect(outcome).not.toBeInstanceOf(SessionEndedByDeviceRevocationError);
    expect(revokedDeviceOfEndedSession()).toBeNull();
  });

  it('reads the code without a named device as a plain dead session - it can name no reset', async () => {
    fetchMock.mockResolvedValue(refusal(401, { code: 'DEVICE_REVOKED_BY_OWNER' }));

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(SessionExpiredError);
    expect(outcome).not.toBeInstanceOf(SessionEndedByDeviceRevocationError);
    expect(revokedDeviceOfEndedSession()).toBeNull();
  });

  it('never reads a transport failure as a revocation', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).not.toBeInstanceOf(SessionExpiredError);
    expect(isRefreshCredentialProvenDead()).toBe(false);
    expect(revokedDeviceOfEndedSession()).toBeNull();
  });

  /** THE REAL BOUNDARY: a 401 core-service did not write proves nothing about the credential. */
  it('resets nothing on an HTML 401 - a portal or an edge page', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html><body>401 Authorization Required</body></html>', {
        status: 401,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(RefreshFailedError);
    expect(outcome).not.toBeInstanceOf(SessionExpiredError);
    expect(isRefreshCredentialProvenDead()).toBe(false);
    expect(revokedDeviceOfEndedSession()).toBeNull();
  });

  it("resets nothing on an edge's JSON 401 - no envelope and no code of ours", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'unauthorized', deviceId: 'phone-1' }, { status: 401 })
    );

    const outcome = await refresh().catch((e: unknown) => e);

    expect(outcome).not.toBeInstanceOf(SessionExpiredError);
    expect(isRefreshCredentialProvenDead()).toBe(false);
    expect(revokedDeviceOfEndedSession()).toBeNull();
  });

  it('a new credential voids the cause with the verdict', async () => {
    fetchMock.mockResolvedValue(revokedRefusal());
    await refresh().catch(() => {});
    expect(revokedDeviceOfEndedSession()).toEqual(REVOKED);

    setToken(liveToken());

    expect(revokedDeviceOfEndedSession()).toBeNull();
    expect(isRefreshCredentialProvenDead()).toBe(false);
  });
});
