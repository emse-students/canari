/**
 * THE DELIVERY API THAT SHIPS OBEYS THE 401 RULE. The renewal is optional in `MlsDeliveryApiOptions`
 * so a test can read one response; this pins that the one production construction passes it.
 */
import { describe, expect, it, vi } from 'vitest';

const refresh = vi.fn().mockResolvedValue('fresh');
vi.mock('$lib/stores/auth', () => ({
  getToken: async () => 'stale',
  refresh: () => refresh(),
}));

const { productionDeliveryApi } = await import('./productionDeliveryApi');

describe('productionDeliveryApi', () => {
  it('renews the token on a 401 and sends the same commit again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ accepted: true, newEpoch: 2 }));
    const api = productionDeliveryApi('https://delivery.test', f as unknown as typeof fetch);
    await expect(api.submitCommit('g-1', 1, 'AQ==', undefined, 'Ag==')).resolves.toMatchObject({
      accepted: true,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
