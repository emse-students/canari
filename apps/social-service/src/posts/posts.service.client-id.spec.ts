/// <reference types="jest" />

import { ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * A QUEUED POST SENT TWICE IS ONE POST (`post-client-id.ts`). The background publish queue resends
 * a post whose answer it never received; the id it minted when it queued the post is what makes the
 * second request find the first one's row. Pinned over an in-memory table whose primary key refuses a
 * duplicate the way Postgres does (SQLSTATE 23505 naming the constraint), so the race - two requests
 * past the check at once - is exercised, not described.
 */
const ID = '0b6a3c1e-8f2d-4a5b-9c7d-1e2f3a4b5c6d';

function makeService(opts: { raceOnInsert?: boolean } = {}) {
  const rows = new Map<string, Partial<Post>>();
  const pkError = Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint: 'PK_posts',
    schema: 'public',
  });
  let checks = 0;
  const postRepo = {
    create: jest.fn((data: Partial<Post>) => ({ ...data })),
    save: jest.fn((post: Partial<Post>) => {
      const row = { id: `gen-${rows.size + 1}`, ...post };
      rows.set(row.id as string, row);
      return Promise.resolve(row);
    }),
    findOne: jest.fn(({ where: { id } }: { where: { id: string } }) => {
      checks += 1;
      // The race: the FIRST check sees nothing, then another request's row lands before the insert.
      if (opts.raceOnInsert && checks === 1) return Promise.resolve(null);
      return Promise.resolve(rows.get(id) ?? null);
    }),
    insert: jest.fn((post: Partial<Post>) => {
      if (rows.has(post.id as string)) return Promise.reject(pkError);
      rows.set(post.id as string, { ...post, publishedAt: new Date(0) });
      return Promise.resolve({});
    }),
    findOneOrFail: jest.fn(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(rows.get(id))
    ),
    // The catalog read of `violatesUniqueColumns`: PK_posts is the index over `id`.
    query: jest.fn((_sql: string, params: unknown[]) =>
      Promise.resolve(params[0] === 'PK_posts' ? [{ attname: 'id' }] : [])
    ),
    manager: { query: jest.fn(() => Promise.resolve([])) },
  };
  const retention = { release: jest.fn() };
  const service = new PostsService(
    postRepo as unknown as Repository<Post>,
    {
      del: jest.fn(),
      setex: jest.fn(),
      get: jest.fn(),
      incr: jest.fn(() => Promise.resolve(1)),
      deleteByPattern: jest.fn(() => Promise.resolve(0)),
    } as unknown as RedisService,
    {} as FollowsService,
    {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set())),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
      moderatedPostIds: () => Promise.resolve(new Set<string>()),
      mayModeratePost: () => Promise.resolve(false),
      findValidatedCalendarEventSummary: jest.fn(() => Promise.resolve(null)),
    } as unknown as AssociationsService,
    { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
    retention as unknown as PostMediaRetentionService
  );
  return { service, rows, postRepo };
}

describe('PostsService.createPost with a client id', () => {
  it('stores the post under the id the client minted', async () => {
    const { service, rows, postRepo } = makeService();
    const post = await service.createPost({ id: ID, markdown: 'Soiree', authorId: 'alice' }, false);
    expect(post).toMatchObject({ id: ID });
    expect([...rows.keys()]).toEqual([ID]);
    // Inserted, never saved: a save over an existing id would be an UPDATE of that post.
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('answers a resend from the first row: one post, the same id, nothing written twice', async () => {
    const { service, rows, postRepo } = makeService();
    await service.createPost({ id: ID, markdown: 'Soiree', authorId: 'alice' }, false);
    const again = await service.createPost(
      { id: ID, markdown: 'Soiree', authorId: 'alice' },
      false
    );
    expect(again).toMatchObject({ id: ID });
    expect(rows.size).toBe(1);
    expect(postRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('answers the request that lost the race on the primary key as a replay, not a 500', async () => {
    const { service, rows } = makeService({ raceOnInsert: true });
    rows.set(ID, { id: ID, authorId: 'alice', markdown: 'Soiree', publishedAt: new Date(0) });
    await expect(
      service.createPost({ id: ID, markdown: 'Soiree', authorId: 'alice' }, false)
    ).resolves.toMatchObject({ id: ID });
    expect(rows.size).toBe(1);
  });

  it("refuses (409) an id that is another author's post, and leaves that post untouched", async () => {
    const { service, rows } = makeService();
    await service.createPost({ id: ID, markdown: 'Soiree', authorId: 'alice' }, false);
    await expect(
      service.createPost({ id: ID, markdown: 'Pirate', authorId: 'mallory' }, false)
    ).rejects.toThrow(ConflictException);
    expect(rows.get(ID)).toMatchObject({ authorId: 'alice', markdown: 'Soiree' });
  });

  it('without an id, creates as before: the database names the post', async () => {
    const { service, postRepo } = makeService();
    await expect(
      service.createPost({ markdown: 'Soiree', authorId: 'alice' }, false)
    ).resolves.toMatchObject({ id: 'gen-1' });
    expect(postRepo.insert).not.toHaveBeenCalled();
  });
});
