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

  it('a fresh user-members read neither joins nor is joined by one already on the wire', async () => {
    const { api, urls } = counting(JSON.stringify([{ userId: 'a' }]));
    await Promise.all([
      api.getGroupUserMembers('g1'),
      api.getGroupUserMembers('g1', { fresh: true }),
      api.getGroupUserMembers('g1'),
    ]);
    // the two plain askers share one request, the fresh one sent its own
    expect(urls).toHaveLength(2);
  });

  it('keeps different groups apart', async () => {
    const { api, urls } = counting('[]');
    await Promise.all([api.getGroupUserMembers('g1'), api.getGroupUserMembers('g2')]);
    expect(urls).toHaveLength(2);
  });
});

describe('the account-level reads of a boot (WP-W4)', () => {
  it('sends ONE users/:id/groups request for simultaneous askers, and asks again afterwards', async () => {
    const { api, urls } = counting('[]');
    await Promise.all([api.getUserGroups('u1'), api.getUserGroups('u1'), api.getUserGroups('u1')]);
    expect(urls).toHaveLength(1);
    await api.getUserGroups('u1');
    expect(urls).toHaveLength(2);
  });

  it('sends ONE devices/:id request for simultaneous askers, and keeps accounts apart', async () => {
    const { api, urls } = counting('[]');
    await Promise.all([
      api.fetchUserDevices('u1'),
      api.fetchUserDevices('u1'),
      api.fetchUserDevices('u1'),
      api.fetchUserDevices('u2'),
    ]);
    expect(urls.filter((u) => u.endsWith('/api/mls/devices/u1'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/api/mls/devices/u2'))).toHaveLength(1);
  });

  it('a failed shared read rejects every joiner and is not remembered', async () => {
    let calls = 0;
    const api = new MlsDeliveryApi({
      historyUrl: 'https://test.local',
      getToken: async () => 'tok',
      fetchImpl: async () => {
        calls++;
        return new Response('[]', { status: calls === 1 ? 500 : 200 });
      },
    });
    const both = await Promise.allSettled([api.getUserGroups('u1'), api.getUserGroups('u1')]);
    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toBe(1);
    await expect(api.getUserGroups('u1')).resolves.toEqual([]);
  });
});
