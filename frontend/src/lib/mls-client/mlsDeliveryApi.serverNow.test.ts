import { MlsDeliveryApi, serverDateOf, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * THE SERVER'S CLOCK ON A GROUP ROW READ (`GroupMeta.serverNow`): the rename sweep bounds a re-send
 * by it (`settleNameSync`), because every receiver measures its bound on the server's clock. Read
 * from the HTTP `Date` of the delivery service's OWN answer only - a portal's page states the
 * portal's time.
 */
const DATE = 'Tue, 17 Nov 2026 09:00:00 GMT';

function answering(headers: Record<string, string>) {
  const fetchImpl: MlsDeliveryFetch = async () =>
    new Response(JSON.stringify({ id: 'g1', name: 'n', isGroup: true }), {
      status: 200,
      headers,
    });
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

describe('the server clock a group row read carries', () => {
  it("is the Date of the delivery service's own answer", async () => {
    const meta = await answering({ 'content-type': 'application/json', date: DATE }).getGroupMeta(
      'g1'
    );
    expect(meta?.serverNow).toBe(Date.parse(DATE));
  });

  it('is absent when the answer states no readable Date', async () => {
    const meta = await answering({ 'content-type': 'application/json' }).getGroupMeta('g1');
    expect(meta).not.toBeNull();
    expect(meta?.serverNow).toBeUndefined();
  });

  it("is never read from an answer that is not the API's", async () => {
    const meta = await answering({ 'content-type': 'text/plain', date: DATE }).getGroupMeta('g1');
    expect(meta?.serverNow).toBeUndefined();
  });

  it('reads nothing but a real date', () => {
    const at = (date?: string) =>
      serverDateOf({ headers: new Headers(date === undefined ? {} : { date }) });
    expect(at(DATE)).toBe(Date.parse(DATE));
    expect(at()).toBeUndefined();
    expect(at('not a date')).toBeUndefined();
  });
});
