import { ForbiddenException, HttpException, Logger } from '@nestjs/common';
import {
  ChannelService,
  COMMUNITY_BOOT_READS_CONCURRENCY,
  COMMUNITY_BOOT_READS_MAX,
  bootReadRefusal,
} from './channel.service';
import { ChannelsController } from './channels.controller';

/**
 * The batched boot read: one answer carrying, per community, the salon listing. It answers through
 * the method the single route calls, so what is pinned here is the per-item verdict (a refusal never
 * fails a sibling), what is NOT in it (the key-group reference), the bounds, what a failure may
 * tell the client, and the controller's input checks - not the authorization, which the single
 * route's own specs hold.
 */
describe('ChannelService.listCommunityBootReads', () => {
  const USER = 'u1';

  function makeService() {
    const service = new ChannelService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const listChannels = jest.spyOn(service, 'listChannelsForUser');
    // The key group is chat-delivery's: the batch must never reach it.
    const keyGroup = jest.spyOn(service, 'getDistributionGroupForMember');
    return { service, listChannels, keyGroup, warn };
  }

  afterEach(() => jest.restoreAllMocks());

  it('answers every community with its listing and never touches the key group', async () => {
    const { service, listChannels, keyGroup } = makeService();
    listChannels.mockImplementation((ws) => Promise.resolve([{ id: `c-${ws}` }] as never));

    const { items } = await service.listCommunityBootReads(USER, ['a', 'b', 'c']);

    expect(items.map((i) => i.workspaceId)).toEqual(['a', 'b', 'c']);
    expect(items[1].channels).toEqual([{ id: 'c-b' }]);
    expect(items.every((i) => i.channelsRefusal === null)).toBe(true);
    expect(Object.keys(items[0]).sort()).toEqual(['channels', 'channelsRefusal', 'workspaceId']);
    expect(listChannels).toHaveBeenCalledTimes(3);
    expect(listChannels).toHaveBeenCalledWith('a', USER);
    expect(keyGroup).not.toHaveBeenCalled();
  });

  it('carries a refusal on its own item and answers the others', async () => {
    const { service, listChannels } = makeService();
    listChannels.mockImplementation((ws) =>
      ws === 'left' ? Promise.reject(new ForbiddenException('nope')) : Promise.resolve([] as never)
    );

    const { items } = await service.listCommunityBootReads(USER, ['ok', 'left', 'ok2']);

    const byId = Object.fromEntries(items.map((i) => [i.workspaceId, i]));
    expect(byId.ok.channelsRefusal).toBeNull();
    expect(byId.left.channels).toBeNull();
    expect(byId.left.channelsRefusal).toMatchObject({ status: 403 });
    expect(byId.ok2.channels).toEqual([]);
  });

  it('reads a repeated id once and answers no more than the bound', async () => {
    const { service, listChannels } = makeService();
    listChannels.mockResolvedValue([] as never);
    const many = Array.from({ length: COMMUNITY_BOOT_READS_MAX + 5 }, (_, i) => `w${i}`);

    const { items } = await service.listCommunityBootReads(USER, ['w0', 'w0', ...many]);

    expect(items).toHaveLength(COMMUNITY_BOOT_READS_MAX);
    expect(listChannels).toHaveBeenCalledTimes(COMMUNITY_BOOT_READS_MAX);
  });

  it('never has more than the concurrency bound in flight', async () => {
    const { service, listChannels } = makeService();
    let inFlight = 0;
    let peak = 0;
    listChannels.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return [] as never;
    });
    const ids = Array.from({ length: COMMUNITY_BOOT_READS_CONCURRENCY * 3 }, (_, i) => `w${i}`);

    const { items } = await service.listCommunityBootReads(USER, ids);

    expect(items).toHaveLength(ids.length);
    expect(peak).toBe(COMMUNITY_BOOT_READS_CONCURRENCY);
  });

  it('sends a generic 500 for an unclassified failure and logs the detail here', async () => {
    const { service, listChannels, warn } = makeService();
    listChannels.mockRejectedValue(new Error('relation "channel_members" does not exist'));

    const { items } = await service.listCommunityBootReads(USER, ['a']);

    expect(items[0].channelsRefusal).toEqual({
      status: 500,
      code: null,
      message: 'Internal error',
    });
    expect(JSON.stringify(items)).not.toContain('channel_members');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('channel_members'));
  });

  it('classifies an HTTP exception by status and code', () => {
    expect(bootReadRefusal(new HttpException({ code: 'X', message: 'm' }, 409))).toMatchObject({
      status: 409,
      code: 'X',
    });
    expect(bootReadRefusal(new ForbiddenException('f')).code).toBeNull();
  });
});

describe('ChannelsController.listCommunityBootReads', () => {
  function make() {
    const service = { listCommunityBootReads: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new ChannelsController(service as unknown as ChannelService);
    return { controller, service };
  }

  it('splits the ids and lower-cases the reader', async () => {
    const { controller, service } = make();
    await controller.listCommunityBootReads(' U1 ', 'a, b,,c');
    expect(service.listCommunityBootReads).toHaveBeenCalledWith('u1', ['a', 'b', 'c']);
  });

  it('refuses no ids and too many ids with a 400', () => {
    const { controller } = make();
    expect(() => controller.listCommunityBootReads('u1', '')).toThrow(HttpException);
    expect(() => controller.listCommunityBootReads('u1', undefined)).toThrow(HttpException);
    const tooMany = Array.from({ length: COMMUNITY_BOOT_READS_MAX + 1 }, (_, i) => `w${i}`);
    expect(() => controller.listCommunityBootReads('u1', tooMany.join(','))).toThrow(/at most 50/);
  });
});
