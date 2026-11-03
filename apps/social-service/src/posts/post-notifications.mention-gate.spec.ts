/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { PostNotificationsService } from './post-notifications.service';
import type { Post } from './entities/post.entity';

/**
 * A MENTION FOLLOWS THE READ'S PREDICATE (`readPostOpenVerdict`), PLUS A BLOCK WITH THE WRITER.
 *
 * It used to reach anyone but the review cohort: a reader outside the post's audience, a person who
 * blocked the author, and - for a scheduled post - before anyone could open it. A mention pushes the
 * post's text, so each of those was handed what the post's own route answers with a 404.
 *
 * The audience SQL is proven against PostgreSQL in `post-openable.integration.spec.ts`; here it is
 * a switch per reader, and the blocks are the `user_blocks` rows a real read would return.
 */
describe('PostNotificationsService.notifyPostMentions - the read gate', () => {
  const AUTHOR = 'author';

  function make(world: { invisibleTo?: string[]; blocks?: [string, string][] } = {}) {
    const blocks = world.blocks ?? [];
    const created: { recipientId: string; actorId: string; actorName?: string }[] = [];
    const query = jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes('AS visible')) {
        const viewer = params[1] as string;
        return Promise.resolve([{ visible: !(world.invisibleTo ?? []).includes(viewer) }]);
      }
      // `blockedUserIdsFor`: the reader's blocks, either way.
      if (sql.includes('AS "otherId" FROM user_blocks')) {
        const viewer = params[0] as string;
        return Promise.resolve(
          blocks
            .filter(([a, b]) => a === viewer || b === viewer)
            .map(([a, b]) => ({ otherId: a === viewer ? b : a }))
        );
      }
      // `isBlockedBetween`: one pair, either way.
      if (sql.includes('FROM user_blocks')) {
        const [x, y] = params as string[];
        const hit = blocks.some(([a, b]) => (a === x && b === y) || (a === y && b === x));
        return Promise.resolve(hit ? [{ '?column?': 1 }] : []);
      }
      if (sql.includes('FROM users')) return Promise.resolve([{ displayName: 'Real Name' }]);
      return Promise.resolve([]);
    });
    const service = new PostNotificationsService(
      {} as never,
      { manager: { query } } as never,
      {} as never,
      {} as never
    );
    jest.spyOn(service, 'createNotification').mockImplementation((data) => {
      created.push(data);
      return Promise.resolve();
    });
    return { service, created };
  }

  const post = (overrides: Partial<Post> = {}): Post =>
    ({
      id: '00000000-0000-4000-8000-000000000001',
      authorId: AUTHOR,
      associationId: null,
      anonymous: false,
      hiddenByModeration: false,
      scheduledAt: null,
      kind: 'post',
      expiresAt: null,
      markdown: 'salut',
      mentions: ['friend'],
      ...overrides,
    }) as unknown as Post;

  beforeEach(() => jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('tells a mentioned reader who may open the post (the positive case)', async () => {
    const { service, created } = make();
    await expect(service.notifyPostMentions(post())).resolves.toBe(1);
    expect(created).toEqual([
      expect.objectContaining({ recipientId: 'friend', actorId: AUTHOR, actorName: 'Real Name' }),
    ]);
  });

  it('tells nobody outside the post audience', async () => {
    const { service, created } = make({ invisibleTo: ['friend'] });
    await expect(service.notifyPostMentions(post())).resolves.toBe(0);
    expect(created).toEqual([]);
  });

  it.each([
    ['the author blocked them', [AUTHOR, 'friend']],
    ['they blocked the author', ['friend', AUTHOR]],
  ] as const)('tells nobody a block separates from the author: %s', async (_case, pair) => {
    const { service, created } = make({ blocks: [[pair[0], pair[1]]] });
    await service.notifyPostMentions(post());
    expect(created).toEqual([]);
  });

  it('tells nobody a block separates from the writer, even on an association post', async () => {
    // The read exempts an association post from the author block (no oracle); a mention does not,
    // since dropping it tells its target nothing - it is the writer's act toward that person.
    const { service, created } = make({ blocks: [['friend', AUTHOR]] });
    await service.notifyPostMentions(post({ associationId: 'asso-1' } as Partial<Post>));
    expect(created).toEqual([]);
  });

  it('tells nobody about a post hidden by moderation', async () => {
    const { service, created } = make();
    await service.notifyPostMentions(post({ hiddenByModeration: true }));
    expect(created).toEqual([]);
  });

  it('tells nobody about a post scheduled later: its publication will', async () => {
    const { service, created } = make();
    await service.notifyPostMentions(post({ scheduledAt: new Date(Date.now() + 86_400_000) }));
    expect(created).toEqual([]);
  });

  it('keeps the readers the gate admits and drops the others, counted at debug', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { service, created } = make({ invisibleTo: ['far'], blocks: [['blocked', AUTHOR]] });
    await service.notifyPostMentions(post({ mentions: ['friend', 'far', 'blocked'] }));
    expect(created.map((c) => c.recipientId)).toEqual(['friend']);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('2 of 3 mention(s) dropped'));
  });

  it('masks the author of an anonymous post, and never resolves their name', async () => {
    const { service, created } = make();
    const resolve = jest.spyOn(service, 'resolveActorName');
    await service.notifyPostMentions(post({ anonymous: true }));
    expect(resolve).not.toHaveBeenCalled();
    expect(created).toEqual([
      expect.objectContaining({ recipientId: 'friend', actorId: '', actorName: 'Anonyme' }),
    ]);
  });

  it('never tells the author about their own post', async () => {
    const { service, created } = make();
    await service.notifyPostMentions(post({ mentions: [AUTHOR] }));
    expect(created).toEqual([]);
  });
});
