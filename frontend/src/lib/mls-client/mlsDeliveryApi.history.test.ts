import { describe, expect, it, vi } from 'vitest';
import { MlsDeliveryApi } from './mlsDeliveryApi';

describe('MlsDeliveryApi.fetchHistoryBatch', () => {
  it('maps batch response histories to a Map', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          histories: {
            g1: [{ sender_id: 'u1', content: 'c', timestamp: '2024-01-01T00:00:00Z' }],
            g2: [],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

    const out = await api.fetchHistoryBatch([
      { groupId: 'g1', afterStreamId: '1-0' },
      { groupId: 'g2' },
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(out.get('g1')).toHaveLength(1);
    expect(out.get('g2')).toEqual([]);
  });

  it('falls back to sequential fetchHistory when batch fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ sender_id: 'u1', content: 'x', timestamp: 't' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

    const out = await api.fetchHistoryBatch([{ groupId: 'g1' }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(out.get('g1')).toHaveLength(1);
  });
});
