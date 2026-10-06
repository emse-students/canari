import { DeliveryUnreachableError, MlsDeliveryApi } from './mlsDeliveryApi';

/**
 * A SEND THAT COULD NOT BE ASKED IS A TYPE, NOT A SENTENCE. On Tauri `plugin-http` rejects with a
 * bare string (`error sending request for url ...`), which reached the reaction toast as
 * "unclassified" (Mi 9T, 2026-10-06). It is classified here, at the throw.
 */
describe('postApplicationMessage on a transport failure', () => {
  const makeApi = (fetchFn: typeof fetch) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

  it('throws DeliveryUnreachableError carrying the raw rejection', async () => {
    const raw = 'error sending request for url (https://example.test/api/mls/send)';
    const api = makeApi(vi.fn().mockRejectedValue(raw) as unknown as typeof fetch);

    const failure = await api.postApplicationMessage('g1', 'AAAA').catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(DeliveryUnreachableError);
    expect((failure as DeliveryUnreachableError).cause).toBe(raw);
  });

  it('lets a cancelled request through as the cancellation it is', async () => {
    const abort = new DOMException('cancelled', 'AbortError');
    const api = makeApi(vi.fn().mockRejectedValue(abort) as unknown as typeof fetch);

    await expect(api.postApplicationMessage('g1', 'AAAA')).rejects.toBe(abort);
  });

  it('leaves a bad answer to the status branch', async () => {
    const api = makeApi(
      vi.fn().mockResolvedValue(new Response('{}', { status: 500 })) as unknown as typeof fetch
    );

    const failure = await api.postApplicationMessage('g1', 'AAAA').catch((e: unknown) => e);

    expect(failure).not.toBeInstanceOf(DeliveryUnreachableError);
  });
});
