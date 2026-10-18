import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { FindOperator, Repository } from 'typeorm';
import { InternalPresenceController } from './internal-presence.controller';
import { MAX_PRESENCE_AUDIENCE_USERS } from '../utils/presence-audience';
import type { ChannelMember } from '../channels/entities/channel-member.entity';

type Row = { workspaceId: string; userId: string };

/** Whether `row` satisfies a `where` built from plain values and `In(...)`. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof Row];
    if (cond instanceof FindOperator) {
      if (cond.type === 'in') return (cond.value as unknown as unknown[]).includes(value);
      throw new Error(`operator ${cond.type} not modelled`);
    }
    return value === cond;
  });
}

/**
 * The community half of the presence audience (WP-PRESENCE, 2026-10-18). An in-memory
 * `channel_members` answers the controller's own `find` calls, so the QUERIES are what is tested:
 * a shared community counts, a stranger does not, the viewer never answers for themself, and the
 * route is internal-only.
 */
describe('InternalPresenceController', () => {
  const env = { ...process.env };
  const rows: Row[] = [
    { workspaceId: 'ws-1', userId: 'alice' },
    { workspaceId: 'ws-1', userId: 'bob' },
    { workspaceId: 'ws-2', userId: 'carol' },
    { workspaceId: 'ws-2', userId: 'dora' },
  ];
  const find = jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
    rows.filter((r) => matches(r, where))
  );
  const controller = new InternalPresenceController({
    find,
  } as unknown as Repository<ChannelMember>);

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'shared-secret';
    find.mockClear();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('answers the members of a community the viewer belongs to, and nobody else', async () => {
    await expect(
      controller.sharedCommunities('shared-secret', {
        viewerId: 'alice',
        userIds: ['bob', 'carol'],
      })
    ).resolves.toEqual({ userIds: ['bob'] });
  });

  it('compares ids in the lowercase spelling every stored id has', async () => {
    await expect(
      controller.sharedCommunities('shared-secret', { viewerId: 'ALICE', userIds: ['Bob'] })
    ).resolves.toEqual({ userIds: ['bob'] });
  });

  it('never answers for the viewer themself, and asks nothing for an empty question', async () => {
    await expect(
      controller.sharedCommunities('shared-secret', { viewerId: 'alice', userIds: ['alice'] })
    ).resolves.toEqual({ userIds: [] });
    expect(find).not.toHaveBeenCalled();
  });

  it('answers an empty audience for a viewer in no community', async () => {
    await expect(
      controller.sharedCommunities('shared-secret', { viewerId: 'zed', userIds: ['bob'] })
    ).resolves.toEqual({ userIds: [] });
  });

  it('refuses a caller without the internal secret before reading anything', async () => {
    await expect(
      controller.sharedCommunities('wrong', { viewerId: 'alice', userIds: ['bob'] })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(find).not.toHaveBeenCalled();
  });

  it('refuses a malformed question rather than answering "nobody"', async () => {
    await expect(
      controller.sharedCommunities('shared-secret', { viewerId: 'alice', userIds: [1] })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.sharedCommunities('shared-secret', { userIds: ['bob'] })
    ).rejects.toBeInstanceOf(BadRequestException);
    const tooMany = Array.from({ length: MAX_PRESENCE_AUDIENCE_USERS + 1 }, (_, i) => `u${i}`);
    await expect(
      controller.sharedCommunities('shared-secret', { viewerId: 'alice', userIds: tooMany })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
