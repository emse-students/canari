import { describe, expect, it, vi } from 'vitest';
import { AddressedUnsupportedError, MlsDeliveryApi } from './mlsDeliveryApi';
import { DELIVERY, addressedHistoryAnswer, addressedKeyMaterial } from './frameDelivery';

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

  it('sends a history answer to the asking device, transport', async () => {
    const body = await bodyOf(addressedHistoryAnswer('bob:bob-phone'));

    expect(body.recipientDevices).toEqual(['bob:bob-phone']);
    expect(body.durable).toBe(false);
  });
});

/**
 * Step A: a server refuses an addressed conversation frame to a device that did not declare the
 * capability - that refusal is TYPED, so the answerer answers nobody rather than reading prose.
 */
describe('an addressed history answer the server cannot route', () => {
  const api = (res: Response) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(res) as unknown as typeof fetch,
    });

  it('throws AddressedUnsupportedError naming the devices', async () => {
    const failure = await api(
      new Response(JSON.stringify({ error: 'addressed_unsupported', devices: ['bob:bob-phone'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    )
      .postApplicationMessage('g1', 'AAAA', addressedHistoryAnswer('bob:bob-phone'))
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AddressedUnsupportedError);
    expect((failure as AddressedUnsupportedError).devices).toEqual(['bob:bob-phone']);
  });

  it('a 400 on a frame for the whole group is never read as one', async () => {
    const failure = await api(
      new Response(JSON.stringify({ error: 'addressed_unsupported' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    )
      .postApplicationMessage('g1', 'AAAA', DELIVERY.transport)
      .catch((e: unknown) => e);

    expect(failure).not.toBeInstanceOf(AddressedUnsupportedError);
  });
});

describe('whether the server routes addressed history answers', () => {
  const answering = (body: unknown) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      ) as unknown as typeof fetch,
    });

  it('is read from the exclusions answer', async () => {
    const api = answering({ exclusions: {}, withheld: { me: [] }, addressedAnswers: true });
    expect(await api.getAddressedAnswersSupported('g1')).toBe(true);
  });

  it('is false from a server that predates it', async () => {
    const api = answering({ exclusions: {}, withheld: { me: [] } });
    expect(await api.getAddressedAnswersSupported('g1')).toBe(false);
  });
});
