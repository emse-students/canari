/**
 * The CanaReels list's "one picture and nothing else" clause, against a REAL PostgreSQL.
 *
 * `posts.service.reels.spec.ts` proves the clause reaches every feed arm; only a database proves
 * the `jsonb` arithmetic says what `single-photo-sql.ts` claims. The cases are the client's
 * (`frontend/src/lib/reels/fullScreenPost.test.ts`): one picture in, one picture with a legacy
 * row's `mimeType` only in, a video, two pictures, a file, text alone, a picture with a poll and a
 * picture with a form out.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here: skipped without a database,
 * never passing. CI's `test-social-integration` sets it and fails on a skipped test. Everything
 * happens in a throwaway schema, dropped at the end.
 */
import { Client } from 'pg';
import { SINGLE_PHOTO_POST_SQL } from './single-photo-sql';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const picture = { type: 'image', mediaId: 'm', mimeType: 'image/webp' };

maybe('the one-picture clause against PostgreSQL', () => {
  const schema = `single_photo_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // Only the columns the clause reads, with the production types and defaults.
    await client.query(`CREATE TABLE posts (
      id text PRIMARY KEY,
      kind varchar(16) NOT NULL DEFAULT 'post',
      images jsonb DEFAULT '[]'::jsonb,
      polls jsonb DEFAULT '[]'::jsonb,
      forms jsonb DEFAULT '[]'::jsonb,
      "attachedFormId" uuid NULL
    )`);
    const rows: Array<[string, unknown[], unknown[], unknown[], string | null]> = [
      ['one-picture', [picture], [], [], null],
      ['legacy-picture', [{ mediaId: 'm', mimeType: 'image/jpeg' }], [], [], null],
      ['one-video', [{ type: 'video', mediaId: 'm', mimeType: 'video/mp4' }], [], [], null],
      ['two-pictures', [picture, picture], [], [], null],
      ['one-file', [{ type: 'file', mediaId: 'm', mimeType: 'application/pdf' }], [], [], null],
      ['text-only', [], [], [], null],
      ['picture-and-poll', [picture], [{ id: 'p' }], [], null],
      ['picture-and-form', [picture], [], [{ id: 'f' }], null],
      ['picture-and-attached-form', [picture], [], [], '00000000-0000-4000-8000-000000000000'],
    ];
    for (const [id, images, polls, forms, attachedFormId] of rows) {
      await client.query(
        `INSERT INTO posts (id, images, polls, forms, "attachedFormId") VALUES ($1, $2, $3, $4, $5)`,
        [id, JSON.stringify(images), JSON.stringify(polls), JSON.stringify(forms), attachedFormId]
      );
    }
    // A NULL column, as a row older than its default could carry.
    await client.query(
      `INSERT INTO posts (id, images, polls, forms) VALUES ('nulls', NULL, NULL, NULL)`
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('keeps exactly the posts whose only content is one picture', async () => {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM posts WHERE ${SINGLE_PHOTO_POST_SQL} ORDER BY id`
    );
    expect(res.rows.map((r) => r.id)).toEqual(['legacy-picture', 'one-picture']);
  });
});
