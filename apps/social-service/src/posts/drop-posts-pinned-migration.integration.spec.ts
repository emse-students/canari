/**
 * MIGRATION 134 (the drop of `posts.pinned`, the retired global pin) against a REAL PostgreSQL: the
 * column goes, every other column and row of `posts` stays, a replay does nothing, and the per-space
 * pins of `post_space_pins` (migration 127) are untouched - they are what the column's meaning moved
 * into (migration 128).
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- drop-posts-pinned
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const POST = '00000000-0000-4000-8000-0000000000b1';
const SPACE = '00000000-0000-4000-8000-0000000000c1';

maybe('migration 134 against PostgreSQL', () => {
  const schema = `drop_posts_pinned_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  const columns = async (): Promise<string[]> =>
    (
      await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'posts' ORDER BY column_name`,
        [schema]
      )
    ).rows.map((r) => r.column_name);

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    // The columns the drop could disturb, as production has them, and the table 127 created.
    await client.query(`
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "hiddenByModeration" boolean NOT NULL DEFAULT false,
        pinned boolean NOT NULL DEFAULT false);
      CREATE TABLE post_space_pins (post_id uuid NOT NULL, space_id uuid NOT NULL,
        pinned_by varchar NOT NULL, pinned_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (post_id, space_id));
    `);
    await client.query(`INSERT INTO posts (id, "authorId", pinned) VALUES ($1, 'author', true)`, [
      POST,
    ]);
    await client.query(
      `INSERT INTO post_space_pins (post_id, space_id, pinned_by) VALUES ($1, $2, 'migration:128')`,
      [POST, SPACE]
    );
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client?.end();
  });

  it('drops the column, keeps the rows and the space pins, and a replay does nothing', async () => {
    expect(await columns()).toContain('pinned');

    await client.query(migration('134_drop_posts_pinned.sql'));
    expect(await columns()).toEqual(['authorId', 'hiddenByModeration', 'id']);

    // A replay (or a local stack whose synchronize already dropped it) is a no-op, not an error.
    await client.query(migration('134_drop_posts_pinned.sql'));
    expect(await columns()).toEqual(['authorId', 'hiddenByModeration', 'id']);

    const posts = await client.query(`SELECT id, "authorId" FROM posts`);
    expect(posts.rows).toEqual([{ id: POST, authorId: 'author' }]);
    const pins = await client.query(`SELECT post_id, space_id, pinned_by FROM post_space_pins`);
    expect(pins.rows).toEqual([{ post_id: POST, space_id: SPACE, pinned_by: 'migration:128' }]);
  });
});
