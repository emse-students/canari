import { BadRequestException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  ChannelRetentionScheduler,
  CHANNEL_MESSAGE_RETENTION_DAYS,
} from './channel-retention.scheduler';
import { ChannelService, MAX_LIVE_SESSION_QUERY } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';

/**
 * The one-year window, and the property that makes it ONE window rather than two.
 *
 * A Graine seed opens the messages of one session. If the messages go and the seed stays, a device
 * keeps the keys to something that no longer exists - unbounded, and pure liability. The obvious
 * implementation gives the device its own one-year timer, which is a second copy of a number that
 * lives on the server, and two windows meant to be one is the shape that drifts. So seed liveness
 * is DERIVED: the device asks which of its sessions the server still has messages for.
 *
 * That is also what lets pinned messages be exempt without stranding anybody: a pinned message
 * keeps naming its session, so the session stays live and the seed is kept with it.
 */
describe('ChannelRetentionScheduler', () => {
  const query = jest.fn();
  const makeScheduler = () =>
    new ChannelRetentionScheduler({ manager: { query } } as unknown as Repository<ChannelMessage>);

  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('deletes past the window and NEVER a pinned message', async () => {
    query.mockResolvedValue({ rowCount: 4 });

    const deleted = await makeScheduler().purgeOnce();

    expect(deleted).toBe(4);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // Both halves matter: the age bound, and the exemption that keeps a human's deliberate pin.
    expect(sql).toContain('DELETE FROM channel_messages');
    expect(sql).toContain('pinned = false');
    expect(sql).toContain('make_interval');
    expect(params).toEqual([CHANNEL_MESSAGE_RETENTION_DAYS]);
  });

  it('keeps the window at a year, which the seed sweep reads off this table', () => {
    // Not a tautology: this number is the ONLY copy, and a second one anywhere is the defect.
    expect(CHANNEL_MESSAGE_RETENTION_DAYS).toBe(365);
  });

  it('reports a failure instead of a silent zero', async () => {
    query.mockRejectedValue(new Error('connection lost'));

    // The cron wrapper swallows, so the log is all a loss leaves - but purgeOnce itself must throw
    // rather than answer 0, which a caller would read as "nothing was old enough".
    await expect(makeScheduler().purgeOnce()).rejects.toThrow('connection lost');
    await expect(makeScheduler().purgeExpiredChannelMessages()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('ChannelService.liveGraineSessions', () => {
  function makeService() {
    const builder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(() => Promise.resolve([] as { senderSessionId: string }[])),
    };
    const memberRepo = { find: jest.fn(() => Promise.resolve([{ workspaceId: 'ws1' }])) };
    const messageRepo = { createQueryBuilder: jest.fn(() => builder) };

    const service = new ChannelService(
      {} as unknown as Repository<Workspace>,
      {} as unknown as Repository<Channel>,
      {} as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      messageRepo as unknown as Repository<ChannelMessage>,
      {} as unknown as Repository<WorkspaceInvite>,
      {} as unknown as RedisService
    );

    return { service, builder, memberRepo, messageRepo };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('answers with the sessions still named by a stored message', async () => {
    const { service, builder } = makeService();
    builder.getRawMany.mockResolvedValue([{ senderSessionId: 's1' }, { senderSessionId: 's3' }]);

    const live = await service.liveGraineSessions('u1', ['s1', 's2', 's3']);

    expect(live).toEqual(['s1', 's3']);
    // s2 is absent, so the device drops that seed - the messages it opened are gone.
  });

  it('scopes the answer to the communities the caller belongs to', async () => {
    const { service, builder, memberRepo } = makeService();
    memberRepo.find.mockResolvedValue([{ workspaceId: 'ws1' }, { workspaceId: 'ws2' }]);

    await service.liveGraineSessions('u1', ['s1']);

    expect(builder.andWhere).toHaveBeenCalledWith(expect.stringContaining('workspaceId'), {
      workspaceIds: ['ws1', 'ws2'],
    });
  });

  it('tells a member of nothing that nothing is live, without querying messages', async () => {
    const { service, memberRepo, messageRepo } = makeService();
    memberRepo.find.mockResolvedValue([]);

    expect(await service.liveGraineSessions('u1', ['s1'])).toEqual([]);
    expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('asks nothing when the device holds nothing', async () => {
    const { service, memberRepo } = makeService();

    expect(await service.liveGraineSessions('u1', [])).toEqual([]);
    expect(memberRepo.find).not.toHaveBeenCalled();
  });

  it('REFUSES an oversized list rather than truncating it', async () => {
    const { service, messageRepo } = makeService();
    // A truncated answer reads as "the rest are dead", and the device would delete live seeds.
    const tooMany = Array.from({ length: MAX_LIVE_SESSION_QUERY + 1 }, (_, i) => `s${i}`);

    await expect(service.liveGraineSessions('u1', tooMany)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
