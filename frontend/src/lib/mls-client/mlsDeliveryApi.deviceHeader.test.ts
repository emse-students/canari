import { MlsDeliveryApi } from './mlsDeliveryApi';

/**
 * WHICH DEVICE IS ASKING, ON EVERY `/api/mls/*` REQUEST.
 *
 * `[HISTORY]` on the server named the group, the cursor and the row count and NOT its caller, so a
 * burst of walks over one group could not be attributed to a device - and an account with two of
 * them looks exactly like one device walking twice. The device id is known in ONE place on this
 * side, so it is attached in one place: `auth()`, which every request already goes through.
 *
 * These cases pin that, and the part that is easy to lose in a refactor: the header must not
 * displace what a call site asks for on top of it.
 */
describe('every delivery request names the device that made it', () => {
  const okJson = () =>
    vi
      .fn()
      .mockResolvedValue(
        new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

  const makeApi = (fetchFn: ReturnType<typeof okJson>) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

  /** The headers of the Nth request, however the call site passed them. */
  const headersOf = (fetchFn: ReturnType<typeof okJson>, n = 0): Record<string, string> =>
    (fetchFn.mock.calls[n][1]?.headers ?? {}) as Record<string, string>;

  it('sends the device id on a history page', async () => {
    const fetchFn = okJson();
    const api = makeApi(fetchFn);
    api.deviceId = 'device-7';

    await api.fetchHistory('g1');

    expect(headersOf(fetchFn)['X-Canari-Device']).toBe('device-7');
  });

  it('sends it on the batch route too, which is where a catch-up starts', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ histories: {}, heads: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const api = makeApi(fetchFn as ReturnType<typeof okJson>);
    api.deviceId = 'device-7';

    await api.fetchHistoryBatch([{ groupId: 'g1' }]);

    expect(headersOf(fetchFn as ReturnType<typeof okJson>)['X-Canari-Device']).toBe('device-7');
  });

  /**
   * `'pending'` is the client's own literal for an unresolved identity and it travels like any
   * other value: a log line reading `device=pending` names a request made before `resolveDeviceId`
   * finished, which is exactly the kind of thing this field exists to surface. Dropping the header
   * there would render that case indistinguishable from an old client sending none.
   */
  it('sends the unresolved placeholder rather than nothing', async () => {
    const fetchFn = okJson();
    const api = makeApi(fetchFn);

    await api.fetchHistory('g1');

    expect(headersOf(fetchFn)['X-Canari-Device']).toBe('pending');
  });

  it('does not displace the headers a call site adds on top of it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ histories: {}, heads: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const api = makeApi(fetchFn as ReturnType<typeof okJson>);
    api.deviceId = 'device-7';

    await api.fetchHistoryBatch([{ groupId: 'g1' }]);

    const headers = headersOf(fetchFn as ReturnType<typeof okJson>);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer token');
    expect(headers['X-Canari-Device']).toBe('device-7');
  });
});
