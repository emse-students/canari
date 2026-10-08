import { Repository } from 'typeorm';
import { ChannelService, UNREAD_TRACKED_SINCE_MS } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';

/**
 * The durable unread count of a salon (2026-10-08). The client's own tally lives in memory and
 * dies with a reload; the server holds the reader's mark and the rows. What is worth protecting
 * here is WHICH salons are asked about - a private salon the caller is not in must never be
 * counted, or the count would leak that it has traffic - and the shape the client merges.
 *
 * The comparison itself (silent, own, mark, membership floor) is SQL and is measured against the
 * real database by `tools/cross-client-harness/unread-communities.mjs`, not mocked here.
 */
describe('ChannelService - unread counts', () => {
  const ME = 'me';
  const member = { id: 'm1', workspaceId: 'ws', userId: ME, roleIds: [], readMarks: {} };

  function makeService(
    channels: object[],
    rows: { channelId: string; n: string }[],
    members: object[] = [member]
  ) {
    const memberRepo = { find: jest.fn().mockResolvedValue(members) };
    const channelRepo = { find: jest.fn().mockResolvedValue(channels) };
    const messageRepo = { query: jest.fn().mockResolvedValue(rows) };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const service = new ChannelService(
      noop as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      noop as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      messageRepo as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      {} as unknown as RedisService
    );
    return { service, messageRepo };
  }

  it('asks only about the salons the caller may read, and maps the rows by channel id', async () => {
    const channels = [
      { id: 'open', workspaceId: 'ws', isPrivate: false, allowedUsers: [] },
      { id: 'mine', workspaceId: 'ws', isPrivate: true, allowedUsers: [ME] },
      { id: 'closed', workspaceId: 'ws', isPrivate: true, allowedUsers: ['someone'] },
    ];
    const { service, messageRepo } = makeService(channels, [
      { channelId: 'open', n: '3' },
      { channelId: 'mine', n: '1' },
    ]);

    const answer = await service.listUnreadCounts(ME);

    expect(answer.counts).toEqual({ open: 3, mine: 1 });
    const [, params] = messageRepo.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(ME);
    expect(params[1]).toEqual(['open', 'mine']);
    expect(params[2]).toBe(UNREAD_TRACKED_SINCE_MS);
    expect(answer.asOf).toBeGreaterThan(UNREAD_TRACKED_SINCE_MS);
  });

  it('answers empty, without a query, for a caller in no community', async () => {
    const { service, messageRepo } = makeService([], [], []);
    await expect(service.listUnreadCounts(ME)).resolves.toMatchObject({ counts: {} });
    expect(messageRepo.query).not.toHaveBeenCalled();
  });
});
