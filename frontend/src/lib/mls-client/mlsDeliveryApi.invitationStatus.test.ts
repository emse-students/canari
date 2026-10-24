import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * A membership report the server REFUSES is said on the client, with the status, the code and the
 * reason the server named. The report stays best-effort - it never throws to its caller - but it used
 * to ignore the status code altogether, so a device whose seat had been purged before it processed
 * its Welcome stayed unrouted with nothing in its own log to say why.
 */
function makeApi(fetchImpl: MlsDeliveryFetch): MlsDeliveryApi {
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

describe('updateInvitationStatus', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns with the status, code and reason when the report is refused, and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi(
      async () =>
        new Response(
          JSON.stringify({ code: 'NOT_A_MEMBER', message: 'refused', reason: 'no_seat' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await expect(
      api.updateInvitationStatus('dev-1', 'user-1', 'group-123456', 'active')
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('403');
    expect(line).toContain('NOT_A_MEMBER');
    expect(line).toContain('no_seat');
    expect(line).toContain('active');
  });

  it('says nothing when the report is accepted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi(async () => new Response('{"status":"active"}', { status: 201 }));

    await api.updateInvitationStatus('dev-1', 'user-1', 'group-123456', 'active');

    expect(warn).not.toHaveBeenCalled();
  });

  it('names a body that is not JSON as carrying no code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi(async () => new Response('<html>bad gateway</html>', { status: 502 }));

    await api.updateInvitationStatus('dev-1', 'user-1', 'group-123456', 'pending');

    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('502');
    expect(line).toContain('code=none');
  });
});
