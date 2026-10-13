import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';

/**
 * "Marquer tout comme lu" on a community (2026-10-13). What is worth protecting here is WHO is told
 * and WHICH salons are touched: the caller's own devices only, never the salon's readers (the read
 * mark is the "Lu par" receipt and must not move), and never a private salon the caller cannot
 * read. The bound (newest row, `upTo`) and the never-lower merge are SQL, checked against a real
 * database (docs/wiki/frontend/modules/chat.md, "Mark a whole community as read"); here the SQL is
 * asserted to carry them and to be ONE statement.
 */
describe('ChannelService - clearing a community unread', () => {
  const WS = 'ws-1';
  const ME = 'me';
  const UP_TO = 1_760_000_000_000;
  const member = { id: 'm-me', workspaceId: WS, userId: ME, roleIds: [], readMarks: {} };
  const channels = [
    { id: 'open', workspaceId: WS, name: 'general', isPrivate: false, allowedUsers: [] },
    { id: 'mine', workspaceId: WS, name: 'bureau', isPrivate: true, allowedUsers: [ME] },
    { id: 'closed', workspaceId: WS, name: 'secret', isPrivate: true, allowedUsers: ['someone'] },
  ];

  function makeService(
    opts: {
      member?: object | null;
      channels?: object[];
      prev?: Record<string, number>;
      next?: Record<string, number>;
    } = {}
  ) {
    const memberRepo = {
      findOne: jest.fn().mockResolvedValue(opts.member === undefined ? member : opts.member),
      createQueryBuilder: jest.fn(),
    };
    const channelRepo = { find: jest.fn().mockResolvedValue(opts.channels ?? channels) };
    // TypeORM answers an UPDATE ... RETURNING as `[rows, rowCount]`.
    const messageRepo = {
      query: jest.fn().mockResolvedValue([[{ prev: opts.prev ?? {}, next: opts.next ?? {} }], 1]),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const redis = { publishChannelEvent: jest.fn().mockResolvedValue(undefined) };
    const service = new ChannelService(
      noop as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      noop as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      messageRepo as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );
    (service as unknown as { internalSecret: string }).internalSecret = 'secret';
    const push = jest
      .spyOn(service as unknown as { sendInternalPush: () => Promise<void> }, 'sendInternalPush')
      .mockResolvedValue(undefined);
    return { service, redis, messageRepo, memberRepo, push };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('clears every salon the caller may read, in ONE statement, bounded by upTo and the newest row', async () => {
    const { service, messageRepo, memberRepo } = makeService({
      next: { open: UP_TO - 5, mine: UP_TO },
    });

    await service.clearWorkspaceUnread(WS, ME, UP_TO);

    expect(messageRepo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = messageRepo.query.mock.calls[0] as [string, unknown[]];
    // The private salon the caller is not in is never named, so its traffic is never touched.
    expect(params).toEqual(['m-me', ['open', 'mine'], UP_TO]);
    expect(sql).toContain('LEAST(');
    expect(sql).toContain('max(m."createdAt")');
    // Never lowered: the merge takes the greater of the row as it is now and the new value.
    expect(sql).toContain('GREATEST(b.at, COALESCE((cm."clearedMarks" ->> b.cid)::bigint, 0))');
    // The read mark is the receipt others see; this statement must not name it.
    expect(sql).not.toContain('readMarks');
    expect(memberRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('tells the caller alone, never the salon readers, and never publishes channel.read', async () => {
    const { service, redis } = makeService({
      prev: { open: 10 },
      next: { open: UP_TO - 5, mine: UP_TO },
    });

    await expect(service.clearWorkspaceUnread(WS, ME, UP_TO)).resolves.toEqual({
      cleared: { open: UP_TO - 5, mine: UP_TO },
    });

    expect(redis.publishChannelEvent).toHaveBeenCalledTimes(1);
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.unread.cleared',
      { workspaceId: WS, userId: ME, cleared: { open: UP_TO - 5, mine: UP_TO } },
      [ME]
    );
  });

  it('dismisses the banners of the salons that moved, on the caller own devices only', async () => {
    const { service, push } = makeService({
      prev: { mine: UP_TO },
      next: { open: UP_TO - 5, mine: UP_TO },
    });

    await service.clearWorkspaceUnread(WS, ME, UP_TO);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(ME, 'general', {
      type: 'channel_read',
      channelId: 'open',
      workspaceId: WS,
      senderId: ME,
    });
  });

  it('tells nobody when no salon moved', async () => {
    const { service, redis, push } = makeService({
      prev: { open: UP_TO },
      next: { open: UP_TO },
    });

    await expect(service.clearWorkspaceUnread(WS, ME, UP_TO)).resolves.toEqual({ cleared: {} });
    expect(redis.publishChannelEvent).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not a member of the community', async () => {
    const { service, messageRepo } = makeService({ member: null });
    await expect(service.clearWorkspaceUnread(WS, ME, UP_TO)).rejects.toThrow(ForbiddenException);
    expect(messageRepo.query).not.toHaveBeenCalled();
  });

  it('answers empty, without a statement, for a community with no salon the caller may read', async () => {
    const { service, messageRepo, redis } = makeService({ channels: [channels[2]] });
    await expect(service.clearWorkspaceUnread(WS, ME, UP_TO)).resolves.toEqual({ cleared: {} });
    expect(messageRepo.query).not.toHaveBeenCalled();
    expect(redis.publishChannelEvent).not.toHaveBeenCalled();
  });

  it('refuses an instant that is not a positive integer', async () => {
    const { service } = makeService();
    await expect(service.clearWorkspaceUnread(WS, ME, Number.NaN)).rejects.toThrow(
      BadRequestException
    );
    await expect(service.clearWorkspaceUnread(WS, ME, 0)).rejects.toThrow(BadRequestException);
  });
});
