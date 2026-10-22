import { GROUP_ROSTERS_MAX_GROUPS, MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * `fetchGroupRosters` replaces one `GET user-members` per held group (81 per connection on the
 * 2026-10-12 production console) by `ceil(n / GROUP_ROSTERS_MAX_GROUPS)` POSTs - and, like the
 * history batch, never throws: what it did not answer is absent, and the caller decides nothing for it.
 */
function api(answer: (body: { groupIds: string[] }) => Response) {
  const bodies: Array<{ groupIds: string[] }> = [];
  const urls: string[] = [];
  const fetchImpl: MlsDeliveryFetch = async (input, init) => {
    urls.push(String(input));
    const body = JSON.parse(String(init?.body)) as { groupIds: string[] };
    bodies.push(body);
    return answer(body);
  };
  return {
    api: new MlsDeliveryApi({
      historyUrl: 'https://test.local',
      getToken: async () => 'tok',
      fetchImpl,
    }),
    bodies,
    urls,
  };
}

const json = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

describe('fetchGroupRosters', () => {
  it('reads 81 rosters in ONE request, and keeps a refusal apart from an answer', async () => {
    const ids = Array.from({ length: 81 }, (_, i) => `g${i}`);
    const { api: a, urls } = api(({ groupIds }) =>
      json({
        rosters: Object.fromEntries(groupIds.filter((g) => g !== 'g7').map((g) => [g, ['alice']])),
        refused: ['g7'],
      })
    );

    const got = await a.fetchGroupRosters(ids);

    expect(urls).toEqual(['https://test.local/api/mls/group-rosters']);
    expect(got.rosters.size).toBe(80);
    expect(got.rosters.get('g0')).toEqual(['alice']);
    expect(got.refused).toEqual(new Set(['g7']));
  });

  it('chunks at the server cap rather than learning it by being refused', async () => {
    const ids = Array.from({ length: GROUP_ROSTERS_MAX_GROUPS + 1 }, (_, i) => `g${i}`);
    const { api: a, bodies } = api(() => json({ rosters: {}, refused: [] }));

    await a.fetchGroupRosters(ids);

    expect(bodies.map((b) => b.groupIds.length)).toEqual([GROUP_ROSTERS_MAX_GROUPS, 1]);
  });

  it('answers nothing, and throws nothing, against a server without the route', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api: a } = api(
      () => new Response('Cannot POST /api/mls/group-rosters', { status: 404 })
    );

    const got = await a.fetchGroupRosters(['g1', 'g2']);

    expect(got.rosters.size).toBe(0);
    expect(got.refused.size).toBe(0);
    expect(warn.mock.calls[0][0]).toContain('404');
    warn.mockRestore();
  });

  it('leaves unanswered a roster that is not a list, rather than reading it as empty', async () => {
    // An empty roster names every leaf but this device's as a stray.
    const { api: a } = api(() => json({ rosters: { g1: null, g2: ['alice'] }, refused: [] }));

    const got = await a.fetchGroupRosters(['g1', 'g2']);

    expect(got.rosters.has('g1')).toBe(false);
    expect(got.rosters.get('g2')).toEqual(['alice']);
  });

  it('carries the revoked devices of each answered group, and only well-formed ones', async () => {
    // The ALLOWLIST a destructive collector reads: only an exact `userId:deviceId` the server names
    // as revoked, for a group it answered. Anything else is dropped rather than guessed at.
    const { api: a } = api(() =>
      json({
        rosters: { g1: ['alice', 'bob'], g2: ['alice'] },
        refused: ['g3'],
        revoked: { g1: ['bob:phone-1', 42, ''], g2: 'nope', g3: ['eve:x'] },
      })
    );

    const got = await a.fetchGroupRosters(['g1', 'g2', 'g3']);

    expect(got.revoked.get('g1')).toEqual(['bob:phone-1']);
    expect(got.revoked.has('g2')).toBe(false);
    expect(got.revoked.has('g3')).toBe(false);
  });

  it('knows no revoked device from a server that predates the field', async () => {
    const { api: a } = api(() => json({ rosters: { g1: ['alice'] }, refused: [] }));
    expect((await a.fetchGroupRosters(['g1'])).revoked.size).toBe(0);
  });
});
