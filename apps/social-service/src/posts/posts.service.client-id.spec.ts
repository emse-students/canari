/// <reference types="jest" />

import { ConflictException, GoneException } from '@nestjs/common';
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

function makeService(
  opts: {
    raceOnInsert?: boolean;
    withdrawnDuringInsert?: boolean;
    /** Another author's row lands between the withdrawal's two reads. */
    rowAppearsOnSecondRead?: Partial<Post>;
  } = {}
) {
  const rows = new Map<string, Partial<Post>>();
  // `deleted_post_ids`, written by the trigger on every delete of a row (migration 135).
  const deleted = new Set<string>();
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
      if (opts.rowAppearsOnSecondRead && checks === 2) rows.set(id, opts.rowAppearsOnSecondRead);
      return Promise.resolve(rows.get(id) ?? null);
    }),
    insert: jest.fn((post: Partial<Post>) => {
      if (rows.has(post.id as string)) return Promise.reject(pkError);
      rows.set(post.id as string, { ...post, publishedAt: new Date(0) });
      // A withdrawal that wrote the tombstone while this insert was on its way.
      if (opts.withdrawnDuringInsert) deleted.add(post.id as string);
      return Promise.resolve({});
    }),
    delete: jest.fn(({ id }: { id: string }) => {
      if (rows.delete(id)) deleted.add(id);
      return Promise.resolve({});
    }),
    findOneOrFail: jest.fn(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(rows.get(id))
    ),
    // The catalog read of `violatesUniqueColumns`: PK_posts is the index over `id`.
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT 1 FROM deleted_post_ids')) {
        return Promise.resolve(deleted.has(params[0] as string) ? [{ '?column?': 1 }] : []);
      }
      if (sql.startsWith('INSERT INTO deleted_post_ids')) {
        deleted.add(params[0] as string);
        return Promise.resolve([]);
      }
      if (sql.startsWith('DELETE FROM deleted_post_ids')) {
        deleted.delete(params[0] as string);
        return Promise.resolve([]);
      }
      return Promise.resolve(params[0] === 'PK_posts' ? [{ attname: 'id' }] : []);
    }),
    manager: { query: jest.fn(() => Promise.resolve([])) },
  };
  const retention = {
    release: jest.fn(),
    deleteWithdrawnMedia: jest.fn(() =>
      Promise.resolve({ deleted: 0, absent: 0, cited: 0, refused: 0 })
    ),
    claimReelFor: jest.fn((_a: string, ids: string[]) =>
      Promise.resolve({ claimed: ids, refused: [] })
    ),
  };
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
  return { service, rows, postRepo, deleted, retention };
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

  it("the race's replay keeps the reel claim: it belongs to the row that won, which shows the reel", async () => {
    const { service, rows, retention } = makeService({ raceOnInsert: true });
    const media = [
      { type: 'video', mediaId: 'reel-blob', key: 'k', iv: 'i', mimeType: 'video/mp4' },
    ];
    rows.set(ID, {
      id: ID,
      authorId: 'alice',
      kind: 'reel',
      media,
      publishedAt: new Date(0),
    } as never);
    await expect(
      service.createPost(
        { id: ID, kind: 'reel', durationMs: 5000, markdown: 'r', media, authorId: 'alice' },
        false
      )
    ).resolves.toMatchObject({ id: ID });
    expect(retention.release).not.toHaveBeenCalled();
  });

  it('refuses (410) the id of a deleted post: a resend after a delete never brings it back', async () => {
    const { service, rows, deleted } = makeService();
    deleted.add(ID);
    await expect(
      service.createPost({ id: ID, markdown: 'Soiree', authorId: 'alice' }, false)
    ).rejects.toThrow(GoneException);
    expect(rows.size).toBe(0);
  });

  it('a withdrawal landing during the insert removes the row it raced, and answers 410', async () => {
    const { service, rows, retention } = makeService({ withdrawnDuringInsert: true });
    await expect(
      service.createPost({ id: ID, markdown: 'Soiree', authorId: 'alice' }, false)
    ).rejects.toThrow(GoneException);
    expect(rows.size).toBe(0);
    expect(retention.release).toHaveBeenCalled();
  });
});

describe('PostsService.withdrawPost - the author takes back a queued post', () => {
  it('retires an id no row holds, so the create still on its way is refused', async () => {
    const { service, deleted } = makeService();
    await expect(service.withdrawPost(ID, 'alice', [])).resolves.toEqual({
      ok: true,
      deleted: false,
    });
    expect(deleted.has(ID)).toBe(true);
    await expect(
      service.createPost({ id: ID, markdown: 'Soiree', authorId: 'alice' }, false)
    ).rejects.toThrow(GoneException);
  });

  it("refuses (409) another author's post, and writes nothing", async () => {
    const { service, rows, deleted } = makeService();
    rows.set(ID, { id: ID, authorId: 'bob', markdown: 'x', publishedAt: new Date(0) });
    await expect(service.withdrawPost(ID, 'alice', [])).rejects.toThrow(ConflictException);
    expect(deleted.has(ID)).toBe(false);
    expect(rows.has(ID)).toBe(true);
  });

  it("another author's row that appears between the two reads is never deleted, and its id stays live", async () => {
    const { service, rows, deleted, retention } = makeService({
      rowAppearsOnSecondRead: { id: ID, authorId: 'bob', markdown: 'x', publishedAt: new Date(0) },
    });
    await expect(service.withdrawPost(ID, 'alice', ['m-1'])).rejects.toThrow(ConflictException);
    expect(rows.get(ID)?.authorId).toBe('bob');
    expect(deleted.has(ID)).toBe(false);
    expect(retention.deleteWithdrawnMedia).not.toHaveBeenCalled();
  });

  it('deletes its own landed post, then hands the media it uploaded to the never-cited delete', async () => {
    const { service, rows, deleted, retention } = makeService();
    rows.set(ID, { id: ID, authorId: 'alice', markdown: 'x', media: [], publishedAt: new Date(0) });
    const remove = jest.spyOn(service, 'deletePost').mockImplementation(async (id: string) => {
      rows.delete(id);
      return { ok: true };
    });
    await expect(service.withdrawPost(ID, 'alice', ['m-1', 'm-2'])).resolves.toEqual({
      ok: true,
      deleted: true,
    });
    // As the author, never as an admin: the flag a global admin carries is not passed on.
    expect(remove).toHaveBeenCalledWith(ID, 'alice', false, { keep: ['m-1', 'm-2'] });
    expect(retention.deleteWithdrawnMedia).toHaveBeenCalledWith('alice', ['m-1', 'm-2']);
    expect(deleted.has(ID)).toBe(true);
  });

  /** A landed post of alice's with two media, its delete stubbed as the row going. */
  function landedPost() {
    const made = makeService();
    made.rows.set(ID, {
      id: ID,
      authorId: 'alice',
      markdown: 'x',
      media: [{ mediaId: 'm-1' }, { mediaId: 'm-2' }],
      publishedAt: new Date(0),
    } as never);
    jest.spyOn(made.service, 'deletePost').mockImplementation(async (id: string) => {
      made.rows.delete(id);
      return { ok: true };
    });
    return made;
  }

  it('releases a held-back media the media service did NOT delete, and only that one', async () => {
    const { service, retention } = landedPost();
    retention.deleteWithdrawnMedia.mockResolvedValueOnce({
      deleted: 1,
      absent: 0,
      cited: 0,
      refused: 1,
      notTaken: ['m-2'],
    } as never);
    await service.withdrawPost(ID, 'alice', ['m-1', 'm-2', 'not-this-post']);
    expect(retention.release).toHaveBeenCalledTimes(1);
    expect(retention.release).toHaveBeenCalledWith(['m-2']);
  });

  it('releases every held-back media when the media delete throws, then rethrows', async () => {
    const { service, retention } = landedPost();
    retention.deleteWithdrawnMedia.mockRejectedValueOnce(new Error('media-service unreachable'));
    await expect(
      service.withdrawPost(ID, 'alice', ['m-1', 'm-2', 'not-this-post'])
    ).rejects.toThrow('media-service unreachable');
    // Only the deleted row's own media were held back - a named id of another post never is.
    expect(retention.release).toHaveBeenCalledWith(['m-1', 'm-2']);
  });
});
