import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChannelApiError, ChannelService, COMMUNITY_BOOT_READS_MAX } from './ChannelService';

/**
 * The batched salon listing of a load, counted on a fake network: what a load of N communities puts
 * on the wire before and after, that the answers are the LOAD's (a handle, never the shared
 * service's state), handed out once, and rethrown as the refusals the single route answers.
 */
describe('ChannelService - the batched salon listing of a load', () => {
  const ref = (groupId: string) => ({ groupId, groupInfo: null, baseEpoch: null, activeEpoch: 3 });

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
    const log = vi.fn();
    return { svc, urls, log };
  }

  /** The server's answer: the batch route carries `items`; a single route answers its own read. */
  const server =
    (ids: string[], refused: Record<string, number> = {}): ((url: string) => Response) =>
    (url) => {
      if (url.includes('/workspaces/boot-reads')) {
        return Response.json({
          items: ids.map((workspaceId) => ({
            workspaceId,
            channels: refused[workspaceId] ? null : [{ id: `c-${workspaceId}` }],
            channelsRefusal: refused[workspaceId]
              ? { status: refused[workspaceId], code: 'X', message: 'no' }
              : null,
          })),
        });
      }
      if (url.includes('/distribution-group')) return Response.json(ref('g-single'));
      if (url.includes('/user/me')) return Response.json([{ id: 'c-single' }]);
      return Response.json([]);
    };

  /** What one walk of a community reads: its salons (through the load), key group, roster. */
  async function walk(
    svc: ChannelService,
    reads: { listChannels(id: string): Promise<unknown> },
    workspaceId: string
  ) {
    await reads.listChannels(workspaceId);
    await svc.getDistributionGroup({ kind: 'workspace', workspaceId });
    await svc.listWorkspaceMembers(workspaceId);
  }

  const nine = Array.from({ length: 9 }, (_, i) => `w${i}`);

  it('MEASURED: nine communities are 27 requests without the batch, 19 with it', async () => {
    const without = serviceOnNetwork(server(nine));
    await Promise.all(nine.map((id) => walk(without.svc, without.svc, id)));
    expect(without.urls).toHaveLength(27);

    const withBatch = serviceOnNetwork(server(nine));
    const reads = await withBatch.svc.readCommunityBootReads(nine, withBatch.log);
    await Promise.all(nine.map((id) => walk(withBatch.svc, reads, id)));
    reads.release();

    // One batch of listings, plus each community's key-group reference and roster.
    expect(withBatch.urls).toHaveLength(19);
    expect(withBatch.urls.filter((u) => u.includes('/boot-reads'))).toHaveLength(1);
    expect(withBatch.urls.filter((u) => u.includes('/distribution-group'))).toHaveLength(9);
    expect(withBatch.urls.filter((u) => u.endsWith('/members'))).toHaveLength(9);
    expect(withBatch.urls.filter((u) => u.includes('/user/me'))).toHaveLength(0);
  });

  it('never batches the key group: its reference is read on its own route, after MLS is ready', async () => {
    const { svc, urls, log } = serviceOnNetwork(server(['a', 'b']));
    await svc.readCommunityBootReads(['a', 'b'], log);

    const got = await svc.getDistributionGroup({ kind: 'workspace', workspaceId: 'a' });

    expect(got.groupId).toBe('g-single');
    expect(urls.some((u) => u.includes('/workspaces/a/distribution-group'))).toBe(true);
  });

  it('hands each listing out once: the second read of the same community goes to its route', async () => {
    const { svc, urls, log } = serviceOnNetwork(server(['a', 'b']));
    const reads = await svc.readCommunityBootReads(['a', 'b'], log);

    expect(await reads.listChannels('a')).toEqual([{ id: 'c-a' }]);
    expect(await reads.listChannels('a')).toEqual([{ id: 'c-single' }]);
    expect(urls.filter((u) => u.includes('/user/me'))).toHaveLength(1);
  });

  it('ANOTHER CALLER CANNOT TAKE A HELD HALF: the service itself always reads the route', async () => {
    const { svc, urls, log } = serviceOnNetwork(server(['a', 'b']));
    const reads = await svc.readCommunityBootReads(['a', 'b'], log);

    // A gesture, a leader-tab executor, a creation, `refreshChannelOrder`: all call the service.
    expect(await svc.listChannels('a')).toEqual([{ id: 'c-single' }]);
    expect(urls.filter((u) => u.includes('/user/me'))).toHaveLength(1);
    // The load's own held answer is still there for the load.
    expect(await reads.listChannels('a')).toEqual([{ id: 'c-a' }]);
  });

  it('release drops only the ids of its own load: a second load keeps its hold', async () => {
    const { svc, urls, log } = serviceOnNetwork(server(['a', 'b', 'c', 'd']));
    const first = await svc.readCommunityBootReads(['a', 'b'], log);
    const second = await svc.readCommunityBootReads(['c', 'd'], log);

    first.release();

    // The first load's listings are gone: its reads fall to the route...
    expect(await first.listChannels('a')).toEqual([{ id: 'c-single' }]);
    // ...and the second load, still running, lost nothing.
    expect(await second.listChannels('c')).toEqual([{ id: 'c-c' }]);
    expect(await second.listChannels('d')).toEqual([{ id: 'c-d' }]);
    expect(urls.filter((u) => u.includes('/user/me'))).toHaveLength(1);
  });

  it('two loads on the SAME ids each keep their own answers', async () => {
    const { svc, log } = serviceOnNetwork(server(['a', 'b']));
    const first = await svc.readCommunityBootReads(['a', 'b'], log);
    const second = await svc.readCommunityBootReads(['a', 'b'], log);

    first.release();

    expect(await second.listChannels('a')).toEqual([{ id: 'c-a' }]);
  });

  it('rethrows a refused listing as the refusal the single route answers, once', async () => {
    const { svc, log } = serviceOnNetwork(server(['a', 'left'], { left: 403 }));
    const reads = await svc.readCommunityBootReads(['a', 'left'], log);

    const refused = await reads.listChannels('left').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ChannelApiError);
    expect((refused as ChannelApiError).status).toBe(403);
    expect((refused as ChannelApiError).code).toBe('X');
    // The refusal was an answer, taken once; a sibling is untouched.
    expect(await reads.listChannels('a')).toEqual([{ id: 'c-a' }]);
  });

  it('a failed batch is said in the load log at warn and every community reads its own route', async () => {
    const { svc, urls, log } = serviceOnNetwork((url) =>
      url.includes('/boot-reads') ? new Response('nope', { status: 404 }) : server(['a'])(url)
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reads = await svc.readCommunityBootReads(['a', 'b'], log);

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[BOOT_READS\] warn: batched listing/)
    );
    expect(warn).not.toHaveBeenCalled();
    expect(await reads.listChannels('a')).toEqual([{ id: 'c-single' }]);
    expect(urls.filter((u) => u.includes('/user/me'))).toHaveLength(1);
  });

  it('asks nothing for a single community, and chunks above the server bound', async () => {
    const one = serviceOnNetwork(server(['a']));
    await one.svc.readCommunityBootReads(['a'], one.log);
    expect(one.urls).toHaveLength(0);

    const many = Array.from({ length: COMMUNITY_BOOT_READS_MAX + 1 }, (_, i) => `w${i}`);
    const big = serviceOnNetwork((url) => {
      const ids = new URL(url, 'http://x').searchParams.get('ids')!.split(',');
      return server(ids)(url);
    });
    await big.svc.readCommunityBootReads(many, big.log);
    expect(big.urls).toHaveLength(2);
  });

  it('the client bound is the server bound', () => {
    const source = readFileSync(
      resolve(process.cwd(), '../apps/social-service/src/channels/channel.service.ts'),
      'utf8'
    );
    const match = /export const COMMUNITY_BOOT_READS_MAX = (\d+);/.exec(source);
    expect(match).not.toBeNull();
    expect(COMMUNITY_BOOT_READS_MAX).toBe(Number(match![1]));
  });
});
