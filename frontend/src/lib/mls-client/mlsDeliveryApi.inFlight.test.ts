import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * REQUEST COUNTS. HAR 2026-10-05: `GET /api/mls/groups/:id` fired 14 times for 7 groups (the status
 * reader and the meta reader each sent their own) and `user-members` once per asker. Simultaneous
 * identical reads now share ONE request; nothing is held once the answer is in.
 */
function counting(body: string) {
  const urls: string[] = [];
  const fetchImpl: MlsDeliveryFetch = async (input) => {
    urls.push(String(input));
    return new Response(body, { status: 200 });
  };
  const api = new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
  return { api, urls };
}

describe('simultaneous identical reads', () => {
  it('sends ONE groups/:id request for getGroupMeta + getGroupServerStatus on one group', async () => {
    const { api, urls } = counting(JSON.stringify({ id: 'g1', name: 'n', isGroup: true }));
    const [meta, status] = await Promise.all([
      api.getGroupMeta('g1'),
      api.getGroupServerStatus('g1'),
    ]);
    expect(urls).toHaveLength(1);
    expect(meta?.groupId).toBe('g1');
    expect(typeof status).toBe('object');
  });

  it('sends ONE user-members request for simultaneous askers, and asks again afterwards', async () => {
    const { api, urls } = counting(JSON.stringify([{ userId: 'a' }]));
    await Promise.all([api.getGroupUserMembers('g1'), api.getGroupUserMembers('g1')]);
    expect(urls).toHaveLength(1);
    // Nothing is held past the answer: a roster read after it is a fresh read.
    await api.getGroupUserMembers('g1');
    expect(urls).toHaveLength(2);
  });

  it('keeps different groups apart', async () => {
    const { api, urls } = counting('[]');
    await Promise.all([api.getGroupUserMembers('g1'), api.getGroupUserMembers('g2')]);
    expect(urls).toHaveLength(2);
  });
});
