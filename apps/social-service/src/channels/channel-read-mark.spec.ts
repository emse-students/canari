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
 * A salon's read receipts, which it never had until 2026-09-29.
 *
 * Reported by the user: a DM shows who read a message, a salon showed "Envoyé" for ever, because the
 * DM watermark travels over MLS and a salon has no MLS group. The server now keeps the same
 * watermark on the membership row. What is worth protecting here is what a max-merge cannot take
 * back - a mark in the future - and who is told: the salon's readers, and only when it moved.
 */
describe('ChannelService - salon read marks', () => {
  const WS = 'ws-1';
  const CH = 'ch-1';
  const READER = 'reader';
  const NEWEST = new Date('2026-09-29T10:00:00.000Z');

  function makeService(opts: { isPrivate?: boolean; allowed?: string[]; affected?: number } = {}) {
    const channel = {
      id: CH,
      workspaceId: WS,
      name: 'general',
      isPrivate: opts.isPrivate ?? false,
      allowedUsers: opts.allowed ?? [],
    };
    const members = [
      { id: 'm-reader', workspaceId: WS, userId: READER, roleIds: [], readMarks: { [CH]: 5 } },
      { id: 'm-other', workspaceId: WS, userId: 'other', roleIds: [], readMarks: { [CH]: 9 } },
      { id: 'm-new', workspaceId: WS, userId: 'newcomer', roleIds: [], readMarks: {} },
    ];
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: opts.affected ?? 1 }),
    };
    const memberRepo = {
      findOne: jest.fn((o: { where: { userId: string } }) =>
        Promise.resolve(members.find((m) => m.userId === o.where.userId) ?? null)
      ),
      find: jest.fn().mockResolvedValue(members),
      createQueryBuilder: jest.fn(() => qb),
    };
    const channelRepo = { findOne: jest.fn().mockResolvedValue(channel) };
    const messageRepo = { findOne: jest.fn().mockResolvedValue({ id: 'msg', createdAt: NEWEST }) };
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
    return { service, redis, qb, messageRepo };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('raises the mark and tells every reader of the salon, the reader included', async () => {
    const { service, redis, qb } = makeService();
    const at = NEWEST.getTime() - 1000;

    await expect(service.advanceChannelReadMark(CH, READER, at)).resolves.toEqual({ at });

    expect(qb.setParameters).toHaveBeenCalledWith({ channelId: CH, at });
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.read',
      { channelId: CH, workspaceId: WS, userId: READER, at },
      [READER, 'other', 'newcomer']
    );
  });

  // A max-merge cannot take a value back: a mark in the future would show every later message as
  // read by this member, on every screen, for ever.
  it('bounds a mark past the newest message to that message', async () => {
    const { service, qb } = makeService();

    await service.advanceChannelReadMark(CH, READER, NEWEST.getTime() + 86_400_000);

    expect(qb.setParameters).toHaveBeenCalledWith({ channelId: CH, at: NEWEST.getTime() });
  });

  // The reader's instant is the AUTHOR's clock, always earlier than the row's createdAt. Left alone
  // the newest message stays "newer than the mark" for ever and the unread count calls it unread
  // right after it was read (measured 2026-10-08: 49 ms on one machine).
  it('takes the later of the author instant and the row createdAt the client names', async () => {
    const { service, qb } = makeService();
    const at = NEWEST.getTime() - 49;

    await service.advanceChannelReadMark(CH, READER, at, NEWEST.getTime());

    expect(qb.setParameters).toHaveBeenCalledWith({ channelId: CH, at: NEWEST.getTime() });
  });

  it('never lets serverAt lower the mark, and still bounds it by the newest message', async () => {
    const { service, qb } = makeService();
    const at = NEWEST.getTime() - 10;
    await service.advanceChannelReadMark(CH, READER, at, 5);
    expect(qb.setParameters).toHaveBeenLastCalledWith({ channelId: CH, at });
    await service.advanceChannelReadMark(CH, READER, at, NEWEST.getTime() + 86_400_000);
    expect(qb.setParameters).toHaveBeenLastCalledWith({ channelId: CH, at: NEWEST.getTime() });
  });

  // The WHERE carries the comparison, so "not ahead" is the row count - and nobody is told.
  it('tells nobody when the mark did not move', async () => {
    const { service, redis } = makeService({ affected: 0 });

    await expect(service.advanceChannelReadMark(CH, READER, 3)).resolves.toBeNull();
    expect(redis.publishChannelEvent).not.toHaveBeenCalled();
  });

  it('refuses an instant that is not a positive integer', async () => {
    const { service } = makeService();
    await expect(service.advanceChannelReadMark(CH, READER, Number.NaN)).rejects.toThrow(
      BadRequestException
    );
    await expect(service.advanceChannelReadMark(CH, READER, 0)).rejects.toThrow(
      BadRequestException
    );
  });

  it('refuses a member who cannot read the private salon', async () => {
    const { service } = makeService({ isPrivate: true, allowed: ['other'] });
    await expect(service.advanceChannelReadMark(CH, READER, 1)).rejects.toThrow(ForbiddenException);
  });

  it('lists the marks of the current readers only, lowercased, skipping who has read nothing', async () => {
    const { service } = makeService({ isPrivate: true, allowed: ['other', 'newcomer'] });

    await expect(service.listChannelReadMarks(CH, 'other')).resolves.toEqual({ other: 9 });
  });
});
