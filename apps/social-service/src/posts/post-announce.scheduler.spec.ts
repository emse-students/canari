/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { PostAnnounceScheduler } from './post-announce.scheduler';
import type { Post } from './entities/post.entity';

/**
 * NOBODY WAS TOLD ABOUT A POST, and these pin the things that decide who now is.
 *
 * The riskiest property here is not who receives a notification - it is that a post is announced
 * ONCE. A sweeper on a one-minute cron that forgot to stamp its rows would re-announce every
 * unstamped post sixty times an hour to the whole school, and the only thing standing between the
 * two behaviours is that `feedNotifiedAt` is written BEFORE the send. So the stamp is asserted
 * directly, including on the path where the announcement itself fails.
 *
 * What these cannot see: migration 058's backfill. Nothing in TypeScript can - it is the `UPDATE`
 * in the SQL file, and its absence would look exactly like a fresh database.
 */
describe('PostAnnounceScheduler', () => {
  type Row = Partial<Post> & { id: string };

  let updates: { id: string; patch: Record<string, unknown> }[];
  let batches: Record<string, unknown>[];
  let queries: { sql: string; params?: unknown[] }[];
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  /** A scheduler over `rows`, with the three tables it reads answered by `answer`. */
  function scheduler(rows: Row[], answer: (sql: string) => unknown[] = () => []) {
    const postRepo = {
      find: () => Promise.resolve(rows),
      update: (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return Promise.resolve({});
      },
      manager: {
        query: (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          return Promise.resolve(answer(sql));
        },
      },
    };
    const notifications = {
      createNotifications: (data: Record<string, unknown>) => {
        batches.push(data);
        return Promise.resolve((data.recipientIds as string[]).length);
      },
    };
    return new PostAnnounceScheduler(postRepo as never, notifications as never);
  }

  /** Answers the three tables the sweeper reads, by what the SQL is asking for. */
  const tables =
    (opts: { audience?: string[]; followers?: string[]; associationName?: string | null }) =>
    (sql: string) => {
      if (sql.includes('FROM users')) return (opts.audience ?? []).map((id) => ({ id }));
      if (sql.includes('user_follows'))
        return (opts.followers ?? []).map((followerUserId) => ({ followerUserId }));
      if (sql.includes('associations'))
        return opts.associationName === null ? [] : [{ name: opts.associationName ?? 'BDE' }];
      return [];
    };

  beforeEach(() => {
    updates = [];
    batches = [];
    queries = [];
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('does nothing at all when no post is waiting', async () => {
    await scheduler([]).announcePosts();
    expect(updates).toEqual([]);
    expect(batches).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('stamps a post before announcing it, so a tick cannot announce it twice', async () => {
    // THE ORDER IS THE PROPERTY, not the two calls, so both are wrapped to record it.
    const order: string[] = [];
    const post: Row = { id: 'p1', authorId: 'a1', associationId: 'asso1', markdown: 'hello' };
    const s = scheduler([post], tables({ audience: ['u1', 'u2'] }));
    const parts = s as unknown as {
      postRepo: { update: (id: string, patch: Record<string, unknown>) => Promise<unknown> };
      notifications: { createNotifications: (d: Record<string, unknown>) => Promise<number> };
    };
    const realUpdate = parts.postRepo.update;
    parts.postRepo.update = (id, patch) => {
      order.push('stamp');
      return realUpdate(id, patch);
    };
    const realNotify = parts.notifications.createNotifications;
    parts.notifications.createNotifications = (d) => {
      order.push('notify');
      return realNotify(d);
    };

    await s.announcePosts();

    expect(order).toEqual(['stamp', 'notify']);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('p1');
    expect(updates[0].patch.feedNotifiedAt).toBeInstanceOf(Date);
  });

  it('tells the whole feed audience about an association post, under the association name', async () => {
    const post: Row = { id: 'p1', authorId: 'a1', associationId: 'asso1', markdown: 'Soiree' };
    await scheduler([post], tables({ audience: ['u1', 'u2', 'a1'] })).announcePosts();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      type: 'association_post',
      postId: 'p1',
      // The author stays the ACTOR so `createNotifications` can exclude them, while the NAME
      // shown is the association's - the reader follows the association, not the officer.
      actorId: 'a1',
      actorName: 'BDE',
      text: 'Soiree',
      pushData: { postId: 'p1' },
    });
    expect(batches[0].recipientIds).toEqual(['u1', 'u2', 'a1']);
  });

  it('tells only the followers about a personal post', async () => {
    const post: Row = { id: 'p2', authorId: 'a2', markdown: 'coucou' };
    await scheduler([post], tables({ audience: ['u1', 'u2'], followers: ['f1'] })).announcePosts();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ type: 'followed_post', actorId: 'a2', text: 'coucou' });
    expect(batches[0].recipientIds).toEqual(['f1']);
    // The audience query must not even run: a personal post is not an announcement to the school.
    expect(queries.some((q) => q.sql.includes('FROM users'))).toBe(false);
  });

  it('writes nothing for a personal post nobody follows, rather than an empty batch', async () => {
    const post: Row = { id: 'p3', authorId: 'a3', markdown: 'coucou' };
    await scheduler([post], tables({ followers: [] })).announcePosts();
    // Still stamped: it must not be reconsidered every minute for the rest of its life.
    expect(updates).toHaveLength(1);
    expect(batches).toEqual([]);
  });

  it('keeps sweeping after one post fails, and does not retry the one that did', async () => {
    // An association row with no name is a broken row, not a post to announce as "somebody".
    const rows: Row[] = [
      { id: 'p1', authorId: 'a1', associationId: 'broken', markdown: 'x' },
      { id: 'p2', authorId: 'a2', markdown: 'y' },
    ];
    await scheduler(rows, (sql) => {
      if (sql.includes('associations')) return [];
      if (sql.includes('user_follows')) return [{ followerUserId: 'f1' }];
      return [];
    }).announcePosts();

    expect(warn).toHaveBeenCalled();
    // Both stamped - the failed one deliberately included, which is the documented trade.
    expect(updates.map((u) => u.id)).toEqual(['p1', 'p2']);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ postId: 'p2' });
  });

  it('truncates the post text rather than putting a whole post on a lock screen', async () => {
    const post: Row = {
      id: 'p1',
      authorId: 'a1',
      associationId: 'asso1',
      markdown: 'x'.repeat(200),
    };
    await scheduler([post], tables({ audience: ['u1'] })).announcePosts();
    expect((batches[0].text as string).length).toBeLessThan(70);
    expect(batches[0].text).toContain('…');
  });

  it('survives a post with no text at all, which is what an image-only post is', async () => {
    const post: Row = { id: 'p1', authorId: 'a1', associationId: 'asso1', markdown: '' };
    await scheduler([post], tables({ audience: ['u1'] })).announcePosts();
    expect(batches).toHaveLength(1);
    expect(batches[0].text).toBe('');
  });
});
