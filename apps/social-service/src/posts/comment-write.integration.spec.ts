/**
 * NO COMMENT WRITE IS LOST TO ANOTHER (lead's review of #2999), against a REAL PostgreSQL.
 *
 * `posts.comments` is one jsonb array, so every comment write is a read-modify-write of it. Two
 * writers that each read the array and each store their copy lose one write: an add racing a
 * moderation delete brought the removed comment back, or dropped the new reply. `writeComments`
 * (`comment-write.ts`) serialises them on the post row's lock; this proves it with the SHIPPED
 * services racing for real.
 *
 * DETERMINISTIC, NO CLOCK: a third connection holds the row lock first, the two writers are started
 * and seen QUEUED on it (`pg_stat_activity.wait_event_type = 'Lock'`), then the lock is let go. Both
 * orders a scheduler could pick are covered, since both writers wait on the same lock.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`; everything happens in a throwaway schema, dropped at the end.
 */
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ContentReport } from '../moderation/entities/content-report.entity';
import { ModerationService } from '../moderation/moderation.service';
import { Post } from './entities/post.entity';
import { PostInteractionsService } from './post-interactions.service';
import type { StoredComment } from './comment-identity';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('comment writes against PostgreSQL: none is lost to another', () => {
  const schema = `cwrite_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;
  let ds: DataSource;
  let interactions: PostInteractionsService;
  let moderation: ModerationService;

  const stored = async (postId: string) =>
    (await client.query(`SELECT comments FROM posts WHERE id = $1`, [postId])).rows[0]
      .comments as StoredComment[];

  /** Waits, by asking PostgreSQL and never a clock, until `n` backends are queued on a lock. */
  const queuedOnLock = async (n: number) => {
    for (let asked = 0; asked < 10_000; asked++) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
      );
      if ((rows[0].n as number) >= n) return;
    }
    throw new Error(`never saw ${n} writer(s) queued on the post's lock`);
  };

  /** Runs `start` while another connection holds post `postId`'s row lock; lets go once all queued. */
  const raceUnderHeldLock = async <T>(postId: string, writers: (() => Promise<T>)[]) => {
    const holder = new Client({ connectionString: URL });
    await holder.connect();
    try {
      await holder.query(`SET search_path TO ${schema}`);
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM posts WHERE id = $1 FOR UPDATE`, [postId]);
      const running: Promise<T>[] = [];
      for (const [i, writer] of writers.entries()) {
        running.push(writer());
        await queuedOnLock(i + 1);
      }
      await holder.query('COMMIT');
      return await Promise.all(running);
    } finally {
      await holder.end();
    }
  };

  const seed = async (postId: string, comments: StoredComment[]) => {
    await client.query(
      `INSERT INTO posts (id, "authorId", markdown, comments) VALUES ($1, 'author', '', $2)`,
      [postId, JSON.stringify(comments)]
    );
  };

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Post, ContentReport],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public`, max: 6 },
    });
    await ds.initialize();
    await client.query(`
      CREATE TABLE ${schema}.users (id varchar PRIMARY KEY, "displayName" varchar,
        "firstName" varchar, "lastName" varchar);
      CREATE TABLE ${schema}.post_notifications (id serial PRIMARY KEY, "postId" varchar NOT NULL,
        "commentId" varchar(255), text varchar NOT NULL);
    `);
    const notifications = {
      createNotification: jest.fn(() => Promise.resolve()),
      renderMentionsForPush: jest.fn((t: string) => Promise.resolve(t)),
      resolveActorName: jest.fn(() => Promise.resolve('Name')),
      resolveMentionedUserIds: jest.fn(() => [] as string[]),
      mentionRecipientsOf: jest.fn(() => Promise.resolve([] as string[])),
    };
    interactions = new PostInteractionsService(
      ds.getRepository(Post),
      notifications as never,
      { notifyContent: jest.fn(() => Promise.resolve()) } as never,
      { release: jest.fn(() => Promise.resolve()) } as never,
      { serve: jest.fn((rows: unknown[]) => Promise.resolve(rows)) } as never
    );
    moderation = new ModerationService(ds.getRepository(ContentReport), {} as never, {} as never);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('an add racing a moderation delete: the removed comment stays gone, the new comment stays', async () => {
    const postId = '40000000-0000-4000-8000-000000000001';
    await seed(postId, [
      { id: 'c1', userId: 'u1', text: 'moderated', parentId: null },
      { id: 'r1', userId: 'u2', text: 'reply', parentId: 'c1' },
      { id: 'keep', userId: 'u3', text: 'other thread', parentId: null },
    ]);
    // The add is a reply to a comment the delete leaves alone, the delete takes c1's thread.
    const [added] = await raceUnderHeldLock<unknown>(postId, [
      () => interactions.addComment(postId, { userId: 'u4', text: 'new', parentId: 'keep' }),
      () => moderation.deleteCommentById('c1', () => true),
    ]);
    const after = await stored(postId);
    const newId = (added as { comment: { id: string } }).comment.id;
    expect(after.map((c) => c.id)).toEqual(['keep', newId]);
  });

  it('the other order: the delete queued first, the add after - same answer', async () => {
    const postId = '40000000-0000-4000-8000-000000000002';
    await seed(postId, [
      { id: 'c1', userId: 'u1', text: 'moderated', parentId: null },
      { id: 'keep', userId: 'u3', text: 'other thread', parentId: null },
    ]);
    const [, added] = await raceUnderHeldLock<unknown>(postId, [
      () => moderation.deleteCommentById('c1', () => true),
      () => interactions.addComment(postId, { userId: 'u4', text: 'new', parentId: 'keep' }),
    ]);
    const newId = (added as { comment: { id: string } }).comment.id;
    expect((await stored(postId)).map((c) => c.id)).toEqual(['keep', newId]);
  });

  it('a reply to the comment being deleted is refused or taken - never left an orphan', async () => {
    const postId = '40000000-0000-4000-8000-000000000003';
    await seed(postId, [{ id: 'c1', userId: 'u1', text: 'moderated', parentId: null }]);
    const outcomes = await raceUnderHeldLock<unknown>(postId, [
      () => moderation.deleteCommentById('c1', () => true),
      () =>
        interactions
          .addComment(postId, { userId: 'u4', text: 'late reply', parentId: 'c1' })
          .catch((e: unknown) => e),
    ]);
    // Whichever the lock let in first: the delete first, and the reply finds no parent (404) and
    // writes nothing; the reply first, and the delete meets it and takes it with the thread.
    const reply = outcomes[1] as { status?: number; comment?: unknown };
    expect(reply.comment !== undefined || reply.status === 404).toBe(true);
    expect(await stored(postId)).toEqual([]);
  });

  it('two likes on the same comment both count', async () => {
    const postId = '40000000-0000-4000-8000-000000000004';
    await seed(postId, [{ id: 'c1', userId: 'u1', text: 'liked', parentId: null, likes: [] }]);
    await raceUnderHeldLock(postId, [
      () => interactions.likeComment(postId, 'c1', 'a'),
      () => interactions.likeComment(postId, 'c1', 'b'),
    ]);
    expect(((await stored(postId))[0].likes as string[]).sort()).toEqual(['a', 'b']);
  });

  it('a save of a post loaded before a comment landed does not write the stale array back', async () => {
    // Every other writer of the row (a reaction, an edit of the post, a hide) saves the entity it
    // loaded; `comments` is `update: false`, so that save cannot undo a comment written meanwhile.
    const postId = '40000000-0000-4000-8000-000000000005';
    await seed(postId, []);
    const repo = ds.getRepository(Post);
    const stale = (await repo.findOne({ where: { id: postId } }))!;
    await interactions.addComment(postId, { userId: 'u4', text: 'landed meanwhile' });
    stale.reactions = { u9: 'like' };
    await repo.save(stale);
    expect((await stored(postId)).map((c) => c.text)).toEqual(['landed meanwhile']);
    const row = (await client.query(`SELECT reactions FROM posts WHERE id = $1`, [postId])).rows[0];
    expect(row.reactions).toEqual({ u9: 'like' });
  });
});
