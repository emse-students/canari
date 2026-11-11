import { ChannelApiError, ChannelService, COMMUNITY_BOOT_READS_MAX } from './ChannelService';

/**
 * The batched boot read, counted on a fake network: what a load of N communities puts on the wire
 * before and after, and that the answers are handed out once, for the load that asked, and as the
 * refusals the single routes answer.
 */
describe('ChannelService - the batched boot read of a load', () => {
  const ref = (groupId: string) => ({
    groupId,
    groupInfo: null,
    baseEpoch: null,
    activeEpoch: 3,
  });

  /** A service on a fake network: every URL asked is recorded, `answer` decides each response. */
  function serviceOnNetwork(answer: (url: string) => Response) {
    const svc = new ChannelService();
    const urls: string[] = [];
    vi.spyOn(
      svc as unknown as { fetchWithAuth: (url: string) => Promise<Response> },
      'fetchWithAuth'
    ).mockImplementation(async (url: string) => {
      urls.push(url);
      return answer(url);
    });
    return { svc, urls };
  }

  /** The server's answer: the batch route carries `items`; a single route answers its own half. */
  const server =
    (
      ids: string[],
      refused: Record<string, Partial<{ channels: number; keyGroup: number }>> = {}
    ) =>
    (url: string): Response => {
      if (url.includes('/workspaces/boot-reads')) {
        return Response.json({
          items: ids.map((workspaceId) => ({
            workspaceId,
            channels: refused[workspaceId]?.channels ? null : [{ id: `c-${workspaceId}` }],
            channelsRefusal: refused[workspaceId]?.channels
              ? { status: refused[workspaceId].channels, code: null, message: 'no' }
              : null,
            keyGroup: refused[workspaceId]?.keyGroup ? null : ref(`g-${workspaceId}`),
            keyGroupRefusal: refused[workspaceId]?.keyGroup
              ? { status: refused[workspaceId].keyGroup, code: 'X', message: 'no' }
              : null,
          })),
        });
      }
      if (url.includes('/distribution-group')) return Response.json(ref('g-single'));
      if (url.includes('/user/me')) return Response.json([{ id: 'c-single' }]);
      return Response.json([]);
    };

  /** What one walk of a community does: its salons, its key-group reference, its roster. */
  async function walk(svc: ChannelService, workspaceId: string) {
    await svc.listChannels(workspaceId);
    await svc.getDistributionGroup({ kind: 'workspace', workspaceId });
    await svc.listWorkspaceMembers(workspaceId);
  }

  const nine = Array.from({ length: 9 }, (_, i) => `w${i}`);

  it('MEASURED: nine communities are 27 requests without the batch, 10 with it', async () => {
    const without = serviceOnNetwork(server(nine));
    await Promise.all(nine.map((id) => walk(without.svc, id)));
    expect(without.urls).toHaveLength(27);

    const withBatch = serviceOnNetwork(server(nine));
    const release = await withBatch.svc.holdCommunityBootReads(nine);
    await Promise.all(nine.map((id) => walk(withBatch.svc, id)));
    release();

    // One batch, plus the roster of each community (read after the device's own tree).
    expect(withBatch.urls).toHaveLength(10);
    expect(withBatch.urls.filter((u) => u.includes('/boot-reads'))).toHaveLength(1);
    expect(withBatch.urls.filter((u) => u.endsWith('/members'))).toHaveLength(9);
  });

  it('hands each half out once: the second read of the same community goes to its route', async () => {
    const { svc, urls } = serviceOnNetwork(server(['a', 'b']));
    await svc.holdCommunityBootReads(['a', 'b']);

    expect(await svc.listChannels('a')).toEqual([{ id: 'c-a' }]);
    expect(await svc.listChannels('a')).toEqual([{ id: 'c-single' }]);
    expect((await svc.getDistributionGroup({ kind: 'workspace', workspaceId: 'a' })).groupId).toBe(
      'g-a'
    );
    expect(urls.filter((u) => u.includes('/user/me'))).toHaveLength(1);
  });

  it('holds nothing once the load releases it', async () => {
    const { svc, urls } = serviceOnNetwork(server(['a', 'b']));
    const release = await svc.holdCommunityBootReads(['a', 'b']);
    release();

    expect(await svc.listChannels('a')).toEqual([{ id: 'c-single' }]);
    expect(urls.filter((u) => u.includes('/user/me'))).toHaveLength(1);
  });

  it('never serves a read that names a device: its seat is judged against a fresher base', async () => {
    const { svc, urls } = serviceOnNetwork(server(['a', 'b']));
    await svc.holdCommunityBootReads(['a', 'b']);

    const got = await svc.getDistributionGroup({ kind: 'workspace', workspaceId: 'a' }, 'dev-1');

    expect(got.groupId).toBe('g-single');
    expect(urls.some((u) => u.includes('/a/distribution-group?deviceId=dev-1'))).toBe(true);
  });

  it('rethrows a refused half as the refusal the single route answers, once', async () => {
    const { svc } = serviceOnNetwork(
      server(['a', 'left'], { left: { channels: 403, keyGroup: 404 } })
    );
    await svc.holdCommunityBootReads(['a', 'left']);

    const channels = await svc.listChannels('left').catch((e: unknown) => e);
    expect(channels).toBeInstanceOf(ChannelApiError);
    expect((channels as ChannelApiError).status).toBe(403);

    const keyGroup = await svc
      .getDistributionGroup({ kind: 'workspace', workspaceId: 'left' })
      .catch((e: unknown) => e);
    expect((keyGroup as ChannelApiError).status).toBe(404);
    expect((keyGroup as ChannelApiError).code).toBe('X');
    // The refusal was an answer, taken once; a sibling is untouched.
    expect(await svc.listChannels('a')).toEqual([{ id: 'c-a' }]);
  });

  it('a failed batch holds nothing and says so: every community reads its own route', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc, urls } = serviceOnNetwork((url) =>
      url.includes('/boot-reads') ? new Response('nope', { status: 404 }) : server(['a'])(url)
    );

    const release = await svc.holdCommunityBootReads(['a', 'b']);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[BOOT_READS] batched read'));
    expect(await svc.listChannels('a')).toEqual([{ id: 'c-single' }]);
    expect(urls.filter((u) => u.includes('/user/me'))).toHaveLength(1);
    release();
  });

  it('asks nothing for a single community, and chunks above the server bound', async () => {
    const one = serviceOnNetwork(server(['a']));
    await one.svc.holdCommunityBootReads(['a']);
    expect(one.urls).toHaveLength(0);

    const many = Array.from({ length: COMMUNITY_BOOT_READS_MAX + 1 }, (_, i) => `w${i}`);
    const big = serviceOnNetwork((url) => {
      const ids = new URL(url, 'http://x').searchParams.get('ids')!.split(',');
      return server(ids)(url);
    });
    await big.svc.holdCommunityBootReads(many);
    expect(big.urls).toHaveLength(2);
  });
});
