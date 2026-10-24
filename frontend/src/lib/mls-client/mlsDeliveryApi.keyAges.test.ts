import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * The age of a device's keys is the evidence the new-device notices weigh before saying "a new
 * device was added" (`isNewToItsOwner`): the server dates each key it recorded (`firstSeen`). A key
 * the history never recorded carries no date, and an older server sends no `firstSeen` at all - the
 * two are kept apart, since only the second leaves the question unanswered.
 */
describe('the dated signature keys of a device', () => {
  const api = (body: unknown) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ) as unknown as MlsDeliveryFetch,
    });

  it('carries each recorded key with the instant the server first saw it', async () => {
    const answer = await api({
      keys: ['AQID', 'BAUG'],
      firstSeen: [{ signatureKey: 'AQID', firstSeenAt: '2026-10-21T08:00:00.000Z' }],
    }).fetchDeviceSignatureKeys('u1', 'd1');

    expect(answer.kind).toBe('keys');
    if (answer.kind !== 'keys') throw new Error('unreachable');
    expect(answer.keys.map((k) => Array.from(k))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(answer.firstSeen?.map((f) => [Array.from(f.key), f.firstSeenAt])).toEqual([
      [[1, 2, 3], Date.parse('2026-10-21T08:00:00.000Z')],
    ]);
  });

  it('says nothing of the ages when the server sent none', async () => {
    const answer = await api({ keys: ['AQID'] }).fetchDeviceSignatureKeys('u1', 'd1');
    if (answer.kind !== 'keys') throw new Error('unreachable');
    expect(answer.firstSeen).toBeUndefined();
  });

  it('drops a malformed age rather than inventing one', async () => {
    const answer = await api({
      keys: ['AQID'],
      firstSeen: [{ signatureKey: 'AQID', firstSeenAt: 'not a date' }, { signatureKey: 7 }],
    }).fetchDeviceSignatureKeys('u1', 'd1');
    if (answer.kind !== 'keys') throw new Error('unreachable');
    expect(answer.firstSeen).toEqual([]);
  });
});
