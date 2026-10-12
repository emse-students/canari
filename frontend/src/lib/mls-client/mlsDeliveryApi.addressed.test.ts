import { describe, expect, it, vi } from 'vitest';
import { MlsDeliveryApi } from './mlsDeliveryApi';
import { DELIVERY, addressedKeyMaterial } from './frameDelivery';

/**
 * An ADDRESSED frame - a Graine answer to one device's seed request (channel-encryption section 23)
 * - names its recipients on the wire, and every other frame names none, which every server reads as
 * "the whole group".
 */
describe('postApplicationMessage and the frame it addresses', () => {
  function bodyOf(delivery: Parameters<MlsDeliveryApi['postApplicationMessage']>[2]) {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return api
      .postApplicationMessage('g1', 'AAAA', delivery)
      .then(() => JSON.parse(String(fetchImpl.mock.calls[0][1].body)) as Record<string, unknown>);
  }

  it('sends the addressed device as `recipientDevices`, durable and silent', async () => {
    const body = await bodyOf(addressedKeyMaterial('bob:bob-phone'));

    expect(body.recipientDevices).toEqual(['bob:bob-phone']);
    expect(body.durable).toBe(true);
    expect(body.silent).toBe(true);
  });

  it('sends no `recipientDevices` at all for a frame meant for the whole group', async () => {
    // Absent, never empty: the server refuses an empty list rather than read it as "everyone".
    const body = await bodyOf(DELIVERY.keyMaterial);

    expect('recipientDevices' in body).toBe(false);
  });
});
