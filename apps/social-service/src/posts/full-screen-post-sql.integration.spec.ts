/**
 * The CanaReels list's full-screen clause, against a REAL PostgreSQL.
 *
 * `posts.service.reels.spec.ts` proves the clause reaches every feed arm; only a database proves
 * the `jsonb` arithmetic says what `full-screen-post-sql.ts` claims. The cases are the client's
 * (`frontend/src/lib/reels/fullScreenPost.test.ts`): one picture in, one picture with a legacy
 * row's `mimeType` only in, a video, two pictures, a file, text alone, a picture with a poll and a
 * picture with a form out; a linked calendar event out; a link in the text IN (owner, 2026-11-06,
 * the only rule since the older switches went on 2026-11-11); a column holding JSON `null` or a
 * scalar read as empty, never raising.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here: skipped without a database,
 * never passing. CI's `test-social-integration` sets it and fails on a skipped test. Everything
 * happens in a throwaway schema, dropped at the end.
 */
import { Client } from 'pg';
import { CAROUSEL_MAX_MEDIA, FULL_SCREEN_POST_SQL, singleMediaSql } from './full-screen-post-sql';

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
      "attachedFormId" uuid NULL,
      "linkedCalendarEventId" uuid NULL,
      markdown text NULL
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
    // JSON `null` and scalars: `jsonb_array_length` raises on them, which would fail the page.
    await client.query(
      `INSERT INTO posts (id, images, polls, forms) VALUES ('json-null-images', 'null'::jsonb, '[]', '[]')`
    );
    const one = JSON.stringify([picture]);
    await client.query(
      `INSERT INTO posts (id, images, polls, forms) VALUES ('picture-scalar-polls', $1, 'null'::jsonb, '3'::jsonb)`,
      [one]
    );
    await client.query(
      `INSERT INTO posts (id, images, "linkedCalendarEventId") VALUES ('picture-and-event', $1, '00000000-0000-4000-8000-000000000001')`,
      [one]
    );
    await client.query(
      `INSERT INTO posts (id, images, markdown) VALUES ('picture-and-link', $1, 'voir https://example.org')`,
      [one]
    );
    await client.query(
      `INSERT INTO posts (id, images, markdown) VALUES ('picture-and-caption', $1, 'Soiree au foyer')`,
      [one]
    );
    // A video, by its `type` or - a legacy row - by its `mimeType` alone, with the exclusions.
    const clip = JSON.stringify([{ type: 'video', mediaId: 'v', mimeType: 'video/mp4' }]);
    await client.query(
      `INSERT INTO posts (id, images) VALUES ('legacy-video', '[{"mediaId":"v","mimeType":"video/quicktime"}]')`
    );
    await client.query(
      `INSERT INTO posts (id, images, markdown) VALUES ('video-and-caption', $1, 'Soiree au foyer')`,
      [clip]
    );
    await client.query(
      `INSERT INTO posts (id, images, markdown) VALUES ('video-and-link', $1, 'voir https://example.org')`,
      [clip]
    );
    await client.query(
      `INSERT INTO posts (id, images, polls) VALUES ('video-and-poll', $1, '[{"id":"p"}]')`,
      [clip]
    );
    await client.query(
      `INSERT INTO posts (id, images, "linkedCalendarEventId") VALUES ('video-and-event', $1, '00000000-0000-4000-8000-000000000002')`,
      [clip]
    );
    await client.query(`INSERT INTO posts (id, images) VALUES ('video-and-picture', $1)`, [
      JSON.stringify([JSON.parse(clip)[0], picture]),
    ]);
    // Carousels (2026-11-06): several pictures and videos, with every exclusion of the single rule,
    // a file or an audio among them, a legacy element typed by its mime alone, and the size bounds.
    const video = JSON.parse(clip)[0];
    const many = (n: number) => JSON.stringify(Array.from({ length: n }, () => picture));
    const carousels: Array<[string, string, string | null]> = [
      ['carousel-max', many(CAROUSEL_MAX_MEDIA), null],
      ['carousel-too-many', many(CAROUSEL_MAX_MEDIA + 1), null],
      ['carousel-mixed-caption', JSON.stringify([picture, video, picture]), 'Soiree au foyer'],
      ['carousel-and-link', JSON.stringify([picture, picture]), 'voir https://example.org'],
      [
        'carousel-legacy-mime',
        JSON.stringify([
          { mediaId: 'm', mimeType: 'image/png' },
          { mediaId: 'v', mimeType: 'video/mp4' },
        ]),
        null,
      ],
      [
        'carousel-and-file',
        JSON.stringify([picture, { type: 'file', mediaId: 'f', mimeType: 'application/pdf' }]),
        null,
      ],
      [
        'carousel-and-audio',
        JSON.stringify([picture, { type: 'audio', mediaId: 'a', mimeType: 'audio/ogg' }]),
        null,
      ],
      ['carousel-untyped-unknown', JSON.stringify([picture, { mediaId: 'x' }]), null],
    ];
    for (const [id, images, markdown] of carousels) {
      await client.query(`INSERT INTO posts (id, images, markdown) VALUES ($1, $2, $3)`, [
        id,
        images,
        markdown,
      ]);
    }
    const two = JSON.stringify([picture, video]);
    await client.query(
      `INSERT INTO posts (id, images, polls) VALUES ('carousel-and-poll', $1, '[{"id":"p"}]')`,
      [two]
    );
    await client.query(
      `INSERT INTO posts (id, images, forms) VALUES ('carousel-and-form', $1, '[{"id":"f"}]')`,
      [two]
    );
    await client.query(
      `INSERT INTO posts (id, images, "attachedFormId") VALUES ('carousel-and-attached-form', $1, '00000000-0000-4000-8000-000000000003')`,
      [two]
    );
    await client.query(
      `INSERT INTO posts (id, images, "linkedCalendarEventId") VALUES ('carousel-and-event', $1, '00000000-0000-4000-8000-000000000004')`,
      [two]
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('keeps exactly the full-screen posts: one or 2..10 pictures and videos, a link allowed, nothing else', async () => {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM posts WHERE ${FULL_SCREEN_POST_SQL} ORDER BY id`
    );
    expect(res.rows.map((r) => r.id)).toEqual(
      [
        // One picture or one video, by its `type` or a legacy row's `mimeType`, a caption allowed.
        'legacy-picture',
        'legacy-video',
        'one-picture',
        'one-video',
        'picture-and-caption',
        'picture-scalar-polls',
        'video-and-caption',
        // A carousel: 2..10 pictures and videos.
        'carousel-legacy-mime',
        'carousel-max',
        'carousel-mixed-caption',
        'two-pictures',
        'video-and-picture',
        // A link in the text comes too.
        'carousel-and-link',
        'picture-and-link',
        'video-and-link',
      ].sort()
    );
  });

  it('the one mode reads the same clause', async () => {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM posts WHERE ${singleMediaSql('carousel-links')} ORDER BY id`
    );
    const direct = await client.query<{ id: string }>(
      `SELECT id FROM posts WHERE ${FULL_SCREEN_POST_SQL} ORDER BY id`
    );
    expect(res.rows).toEqual(direct.rows);
    // A poll, a form, an attached form, a linked event, a file, an audio and an 11th media keep a
    // post out; JSON `null` and scalars never raise.
    for (const out of [
      'picture-and-poll',
      'picture-and-form',
      'picture-and-attached-form',
      'picture-and-event',
      'video-and-event',
      'video-and-poll',
      'carousel-and-event',
      'carousel-and-poll',
      'carousel-and-form',
      'carousel-and-attached-form',
      'carousel-and-file',
      'carousel-and-audio',
      'carousel-untyped-unknown',
      'carousel-too-many',
      'one-file',
      'text-only',
      'nulls',
      'json-null-images',
    ]) {
      expect(res.rows.map((r) => r.id)).not.toContain(out);
    }
  });
});
