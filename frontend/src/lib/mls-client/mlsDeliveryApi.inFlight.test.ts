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
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
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

  it('sends ONE peek of devices/:id for simultaneous roster readers, and keeps accounts apart', async () => {
    const { api, urls } = counting('[]');
    await Promise.all([
      api.listUserDevices('u1'),
      api.listUserDevices('u1'),
      api.listUserDevices('u1'),
      api.listUserDevices('u2'),
    ]);
    expect(urls.filter((u) => u.endsWith('/api/mls/devices/u1?peek=1'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/api/mls/devices/u2?peek=1'))).toHaveLength(1);
    // A roster read claims nothing: no request without the peek reached the wire.
    expect(urls.filter((u) => !u.endsWith('?peek=1'))).toHaveLength(0);
  });

  // A CLAIM IS NEVER SHARED: each answer spends one package per device, and two adders handed one
  // answer would build two Welcomes on one package - the joiner refuses the second.
  it('sends one CLAIMING devices/:id per adder, even when they ask at once', async () => {
    const { api, urls } = counting(JSON.stringify([{ deviceId: 'd1', keyPackage: 'AQID' }]));
    const [first, second] = await Promise.all([
      api.fetchUserDevices('u1'),
      api.fetchUserDevices('u1'),
    ]);
    expect(urls.filter((u) => u.endsWith('/api/mls/devices/u1'))).toHaveLength(2);
    expect(first).not.toBe(second);
  });

  it('a roster read and a claim never share one request', async () => {
    const { api, urls } = counting('[]');
    await Promise.all([api.listUserDevices('u1'), api.fetchUserDevices('u1')]);
    expect(urls.filter((u) => u.endsWith('/api/mls/devices/u1?peek=1'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/api/mls/devices/u1'))).toHaveLength(1);
  });

  it('a Welcome sent to every device of a person reads their ids with a peek, claiming nothing', async () => {
    const urls: string[] = [];
    const api = new MlsDeliveryApi({
      historyUrl: 'https://test.local',
      getToken: async () => 'tok',
      fetchImpl: async (input) => {
        urls.push(String(input));
        const body = String(input).includes('/api/mls/devices/')
          ? [
              { deviceId: 'd1', keyPackage: 'AQID' },
              { deviceId: 'd2', keyPackage: 'AQID' },
            ]
          : {};
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await api.sendWelcome(new Uint8Array([1]), 'bob', 'g1');
    expect(urls.filter((u) => u.includes('/api/mls/devices/'))).toEqual([
      'https://test.local/api/mls/devices/bob?peek=1',
    ]);
    expect(urls.filter((u) => u.endsWith('/api/mls/welcome'))).toHaveLength(2);
  });

  it('a roster entry carries no KeyPackage, because none was claimed for it', async () => {
    const { api } = counting(
      JSON.stringify([{ deviceId: 'd1', keyPackage: 'AQID', deviceName: 'Mi 9T', deviceOs: 7 }])
    );
    await expect(api.listUserDevices('u1')).resolves.toEqual([
      {
        deviceId: 'd1',
        userId: 'u1',
        deviceName: 'Mi 9T',
        deviceOs: undefined,
        deviceAppVersion: undefined,
      },
    ]);
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
