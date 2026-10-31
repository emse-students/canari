/// <reference types="jest" />

import { DeviceSessionsNotEndedError, endDeviceSessions } from './device-sessions';

/** Puts an environment variable back as it was - unset stays unset, never the string "undefined". */
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * The call an owner's device delete makes to core-service: every way it can fail is the one typed
 * error the delete answers as a 503, and only a readable count is a success.
 */
describe('endDeviceSessions', () => {
  const previousSecret = process.env.INTERNAL_SECRET;
  const previousUrl = process.env.CORE_SERVICE_INTERNAL_URL;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'secret';
    process.env.CORE_SERVICE_INTERNAL_URL = 'http://core.test:3012';
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
    restore('INTERNAL_SECRET', previousSecret);
    restore('CORE_SERVICE_INTERNAL_URL', previousUrl);
  });

  const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("asks core-service with the internal secret, naming the caller's session, and returns the count", async () => {
    answer(200, { ended: 2 });
    await expect(endDeviceSessions('u1', 'web-a:b', 'sid-1')).resolves.toBe(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://core.test:3012/api/internal/sessions/users/u1/devices/web-a%3Ab?exceptSession=sid-1'
    );
    expect(init.method).toBe('DELETE');
    expect(init.headers).toEqual({ 'x-internal-secret': 'secret' });
  });

  it('names no exception when the caller has no session', async () => {
    answer(200, { ended: 0 });
    await endDeviceSessions('u1', 'd1', null);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://core.test:3012/api/internal/sessions/users/u1/devices/d1'
    );
  });

  it.each([
    ['a non-2xx answer', () => answer(500, {})],
    ['an answer without a count', () => answer(200, {})],
    [
      'an unreadable answer',
      () => fetchMock.mockResolvedValue(new Response('<html>', { status: 200 })),
    ],
    ['core unreachable', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
  ])('throws the typed error on %s', async (_label, arrange) => {
    arrange();
    await expect(endDeviceSessions('u1', 'd1', null)).rejects.toBeInstanceOf(
      DeviceSessionsNotEndedError
    );
  });

  it('throws the typed error without calling anything when the secret is unset', async () => {
    process.env.INTERNAL_SECRET = '';
    await expect(endDeviceSessions('u1', 'd1', null)).rejects.toBeInstanceOf(
      DeviceSessionsNotEndedError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
