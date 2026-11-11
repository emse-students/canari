import { ForbiddenException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { ChannelService, COMMUNITY_BOOT_READS_MAX, bootReadRefusal } from './channel.service';
import { ChannelsController } from './channels.controller';

/**
 * The batched boot read: one answer carrying, per community, the salon listing and the key-group
 * reference. It answers through the two methods the single routes call, so what is pinned here is
 * the per-item verdict (a refusal never fails a sibling), the bound, and the controller's input
 * checks - not the authorization, which the single routes' own specs hold.
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
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const listChannels = jest.spyOn(service, 'listChannelsForUser');
    const keyGroup = jest.spyOn(service, 'getDistributionGroupForMember');
    return { service, listChannels, keyGroup };
  }

  const ref = (groupId: string) => ({
    groupId,
    groupInfo: null,
    baseEpoch: null,
    activeEpoch: 0,
  });

  afterEach(() => jest.restoreAllMocks());

  it('answers every community with both halves, one read of each per community', async () => {
    const { service, listChannels, keyGroup } = makeService();
    listChannels.mockImplementation((ws) => Promise.resolve([{ id: `c-${ws}` }] as never));
    keyGroup.mockImplementation((ws) => Promise.resolve(ref(`g-${ws}`)));

    const { items } = await service.listCommunityBootReads(USER, ['a', 'b', 'c']);

    expect(items.map((i) => i.workspaceId)).toEqual(['a', 'b', 'c']);
    expect(items[1].channels).toEqual([{ id: 'c-b' }]);
    expect(items[1].keyGroup?.groupId).toBe('g-b');
    expect(items.every((i) => i.channelsRefusal === null && i.keyGroupRefusal === null)).toBe(true);
    expect(listChannels).toHaveBeenCalledTimes(3);
    expect(keyGroup).toHaveBeenCalledTimes(3);
    // The roster is NOT part of it: it must be read after the device's own tree.
    expect(keyGroup).toHaveBeenCalledWith('a', USER);
  });

  it('carries a refusal on its own item and answers the others', async () => {
    const { service, listChannels, keyGroup } = makeService();
    listChannels.mockImplementation((ws) =>
      ws === 'left' ? Promise.reject(new ForbiddenException('nope')) : Promise.resolve([] as never)
    );
    keyGroup.mockImplementation((ws) =>
      ws === 'nokg'
        ? Promise.reject(
            new NotFoundException({ code: 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP', message: 'x' })
          )
        : Promise.resolve(ref(`g-${ws}`))
    );

    const { items } = await service.listCommunityBootReads(USER, ['ok', 'left', 'nokg']);

    const byId = Object.fromEntries(items.map((i) => [i.workspaceId, i]));
    expect(byId.ok.channelsRefusal).toBeNull();
    expect(byId.left.channels).toBeNull();
    expect(byId.left.channelsRefusal).toMatchObject({ status: 403 });
    expect(byId.left.keyGroup?.groupId).toBe('g-left');
    expect(byId.nokg.keyGroupRefusal).toMatchObject({
      status: 404,
      code: 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP',
    });
    expect(byId.nokg.channels).toEqual([]);
  });

  it('reads a repeated id once and answers no more than the bound', async () => {
    const { service, listChannels, keyGroup } = makeService();
    listChannels.mockResolvedValue([] as never);
    keyGroup.mockResolvedValue(ref('g'));
    const many = Array.from({ length: COMMUNITY_BOOT_READS_MAX + 5 }, (_, i) => `w${i}`);

    const { items } = await service.listCommunityBootReads(USER, ['w0', 'w0', ...many]);

    expect(items).toHaveLength(COMMUNITY_BOOT_READS_MAX);
    expect(listChannels).toHaveBeenCalledTimes(COMMUNITY_BOOT_READS_MAX);
  });

  it('turns an unclassified failure into a 500 refusal, never a thrown answer', async () => {
    const { service, listChannels, keyGroup } = makeService();
    listChannels.mockRejectedValue(new Error('db down'));
    keyGroup.mockResolvedValue(ref('g'));

    const { items } = await service.listCommunityBootReads(USER, ['a']);

    expect(items[0].channelsRefusal).toEqual({ status: 500, code: null, message: 'db down' });
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
