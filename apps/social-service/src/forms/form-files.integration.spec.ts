/**
 * THE FILE QUESTION'S SQL, against a REAL PostgreSQL - migration 085.
 *
 * The unit specs see the claim statement, the locked count and the purge predicates as strings; what
 * they DO is a fact about PostgreSQL. So `FormFilesService` and `FormFileRetentionScheduler` run here
 * on a real connection, with only the media service faked (an in-memory store applying the media
 * service's own allowlist): the claim window at its edge, another uploader, a purged row, two
 * submissions for one file (in turn and at the same instant), a reused pending answer, a download
 * asked of the wrong form, twelve uploads racing for ten pending slots, and the purge run twice.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- form-files.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { FormFile } from './entities/form-file.entity';
import {
  FORM_FILE_MAX_PENDING,
  FormFilesService,
  type FileBlobOutcome,
} from './form-files.service';
import { FormFileRetentionScheduler } from './form-file-retention.scheduler';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const PDF = Buffer.from('%PDF-1.7\n%%EOF\n');
const FORM_A = '00000000-0000-4000-8000-00000000f0a1';
const FORM_B = '00000000-0000-4000-8000-00000000f0b2';
const ITEMS = [{ id: 'q_cv', label: 'CV', type: 'file', required: true }];

maybe('form files against PostgreSQL (migration 085)', () => {
  const schema = `form_files_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let files: FormFilesService;
  let scheduler: FormFileRetentionScheduler;
  /** The media service: blob id -> owner. Its purge applies the class-and-owner allowlist. */
  const blobs = new Map<string, string>();
  const http = {
    post: jest.fn((url: string, body: any) => {
      if (url.endsWith('media/internal/form-file')) {
        const mediaId = randomUUID();
        // The multipart body names the owner; this store does not parse it, so a blob stored
        // through the route is marked 'uploader' and the purge below accepts its uploader's name.
        blobs.set(mediaId, 'uploader');
        return of({ data: { mediaId, sizeBytes: PDF.length } });
      }
      const results: Record<string, FileBlobOutcome> = {};
      for (const { mediaId, ownerId } of body.items as { mediaId: string; ownerId: string }[]) {
        const owner = blobs.get(mediaId);
        if (owner === undefined) results[mediaId] = 'absent';
        else if (owner !== ownerId && owner !== 'uploader') results[mediaId] = 'refused';
        else {
          blobs.delete(mediaId);
          results[mediaId] = 'deleted';
        }
      }
      return of({ data: { results } });
    }),
    get: jest.fn(() => of({ data: PDF })),
  };

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** A `form_files` row as the upload writes it, aged as asked. */
  async function upload(opts: {
    formId?: string;
    uploaderId?: string;
    ageHours?: number;
    submissionId?: string | null;
    purged?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO form_files (id, "formId", "itemId", "uploaderId", "contentType", "fileName",
         "sizeBytes", "submissionId", "attachedAt", "purgedAt", "createdAt")
       VALUES ($1, $2, 'q_cv', $3, 'application/pdf', 'cv.pdf', 10, $4,
         CASE WHEN $4::uuid IS NULL THEN NULL ELSE NOW() - make_interval(hours => $5::int) END,
         CASE WHEN $6 THEN NOW() ELSE NULL END,
         NOW() - make_interval(secs => $5::int * 3600))`,
      [
        id,
        opts.formId ?? FORM_A,
        opts.uploaderId ?? 'alice',
        opts.submissionId ?? null,
        opts.ageHours ?? 0,
        opts.purged ?? false,
      ]
    );
    return id;
  }

  async function submission(createdAt = new Date()): Promise<{ id: string; createdAt: Date }> {
    const id = randomUUID();
    await q(`INSERT INTO submissions (id, "createdAt") VALUES ($1, $2)`, [id, createdAt]);
    return { id, createdAt };
  }

  const attach = (
    sub: { id: string; createdAt: Date },
    fileId: string,
    uploaderId = 'alice',
    formId = FORM_A
  ) =>
    ds.transaction((m) => files.attach(m, sub, formId, uploaderId, [{ itemId: 'q_cv', fileId }]));

  const row = async (id: string) =>
    (
      (await q(`SELECT * FROM form_files WHERE id = $1`, [id])) as Array<{
        submissionId: string | null;
        attachedAt: Date | null;
        purgedAt: Date | null;
      }>
    )[0];

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [FormFile],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    // The two tables 085 alters and references, in the shape it needs of them.
    await q(`
      CREATE TABLE forms (id uuid PRIMARY KEY, items jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE submissions (id uuid PRIMARY KEY, "createdAt" timestamptz NOT NULL DEFAULT now());
    `);
    // Applied TWICE: the deploy re-runs every migration, so 085 must be a no-op the second time.
    await q(migration('085_form_files.sql'));
    await q(migration('085_form_files.sql'));
    await q(`INSERT INTO forms (id, items) VALUES ($1, $3), ($2, $3)`, [
      FORM_A,
      FORM_B,
      JSON.stringify(ITEMS),
    ]);

    const formRepo: any = {
      findOne: ({ where }: { where: { id: string } }) =>
        Promise.resolve({
          id: where.id,
          items: ITEMS,
          isPublic: false,
          opensAt: null,
          closedAt: null,
          deletedAt: null,
        }),
    };
    files = new FormFilesService(ds.getRepository(FormFile), formRepo, http as any);
    scheduler = new FormFileRetentionScheduler(ds.getRepository(FormFile), files);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await q(`DELETE FROM form_files`);
    await q(`DELETE FROM submissions`);
    blobs.clear();
  });

  it('holds the retention range in the database: 0 and 31 refused, 7 by default', async () => {
    expect(
      (await q(`SELECT "fileRetentionDays" AS d FROM forms WHERE id = $1`, [FORM_A]))[0].d
    ).toBe(7);
    await expect(
      q(`UPDATE forms SET "fileRetentionDays" = 0 WHERE id = $1`, [FORM_A])
    ).rejects.toThrow(/forms_file_retention_days_range/);
    await expect(
      q(`UPDATE forms SET "fileRetentionDays" = 31 WHERE id = $1`, [FORM_A])
    ).rejects.toThrow(/forms_file_retention_days_range/);
  });

  describe('the claim at submit', () => {
    it('claims the member own unsent file inside the window', async () => {
      const file = await upload({ ageHours: 23 });
      const sub = await submission();
      await attach(sub, file);
      expect((await row(file)).submissionId).toBe(sub.id);
    });

    it('refuses a file past the one-day window', async () => {
      const file = await upload({ ageHours: 25 });
      await expect(attach(await submission(), file)).rejects.toThrow(BadRequestException);
      expect((await row(file)).submissionId).toBeNull();
    });

    it('refuses another member file, and leaves it unclaimed', async () => {
      const file = await upload({ uploaderId: 'bob' });
      await expect(attach(await submission(), file, 'alice')).rejects.toThrow(BadRequestException);
      expect((await row(file)).submissionId).toBeNull();
    });

    it('refuses a purged file', async () => {
      const file = await upload({ purged: true });
      await expect(attach(await submission(), file)).rejects.toThrow(BadRequestException);
    });

    it('refuses a file uploaded for another form', async () => {
      const file = await upload({ formId: FORM_B });
      await expect(attach(await submission(), file, 'alice', FORM_A)).rejects.toThrow(
        BadRequestException
      );
    });

    it('lets one file be claimed by ONE submission - the second is refused', async () => {
      const file = await upload({});
      const first = await submission();
      await attach(first, file);
      await expect(attach(await submission(), file)).rejects.toThrow(BadRequestException);
      expect((await row(file)).submissionId).toBe(first.id);
    });

    it('settles two submissions claiming one file AT ONCE: one wins, one is refused', async () => {
      const file = await upload({});
      const [a, b] = [await submission(), await submission()];
      const outcomes = await Promise.allSettled([attach(a, file), attach(b, file)]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
      expect([a.id, b.id]).toContain((await row(file)).submissionId);
    });

    // A pending answer re-submitted keeps its old `createdAt`; the file's retention must count from
    // THIS answer, not from three days ago.
    it('counts a reused pending answer file from now, not from the answer old date', async () => {
      const old = await submission(new Date(Date.now() - 3 * 86_400_000));
      const file = await upload({});
      await attach(old, file);
      const attachedAt = (await row(file)).attachedAt!;
      expect(Date.now() - new Date(attachedAt).getTime()).toBeLessThan(60_000);
      // ...and the same submission may cite it again (the reuse), still from now.
      await attach(old, file);
      expect((await row(file)).submissionId).toBe(old.id);
    });
  });

  describe('the download', () => {
    it('is a 404 when the file was sent to another form', async () => {
      const sub = await submission();
      const file = await upload({ formId: FORM_A, submissionId: sub.id });
      await expect(files.download(FORM_B, file)).rejects.toThrow(NotFoundException);
      await expect(files.download(FORM_A, file)).resolves.toMatchObject({ fileName: 'cv.pdf' });
    });
  });

  describe('the pending cap', () => {
    // Twelve uploads at once for ten slots: the early count lets them all through, the count under
    // the advisory lock in the writing transaction lets exactly ten rows in.
    it('admits exactly the cap when uploads race, and takes back the losers blobs', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: FORM_FILE_MAX_PENDING + 2 }, () =>
          files.upload(
            FORM_A,
            'q_cv',
            { buffer: PDF, size: PDF.length, originalname: 'cv.pdf' },
            'carol'
          )
        )
      );
      const refused = results.filter((r) => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(FORM_FILE_MAX_PENDING);
      expect(refused).toHaveLength(2);
      for (const r of refused) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(HttpException);
        expect(((r as PromiseRejectedResult).reason as HttpException).getStatus()).toBe(429);
      }
      const [{ n }] = await q(
        `SELECT count(*)::int AS n FROM form_files WHERE "uploaderId" = 'carol'`
      );
      expect(n).toBe(FORM_FILE_MAX_PENDING);
      // Every blob left in the store is named by a row: the losers' were taken back.
      expect(blobs.size).toBe(FORM_FILE_MAX_PENDING);
    });
  });

  describe('the purge', () => {
    it('purges a due answer file and an expired upload, keeps the rest, and a rerun does nothing', async () => {
      const sub = await submission();
      const dueAnswer = await upload({ submissionId: sub.id, ageHours: 7 * 24 + 1 });
      const freshAnswer = await upload({ submissionId: sub.id, ageHours: 2 });
      const oldUpload = await upload({ ageHours: 25 });
      const newUpload = await upload({ ageHours: 1 });
      for (const id of [dueAnswer, freshAnswer, oldUpload, newUpload]) blobs.set(id, 'alice');

      const first = await scheduler.purgeOnce();
      expect(first.answerFiles).toEqual({ due: 1, gone: 1 });
      expect(first.unsent).toEqual({ due: 1, gone: 1 });
      expect((await row(dueAnswer)).purgedAt).not.toBeNull();
      expect((await row(dueAnswer)).submissionId).toBe(sub.id);
      expect(await row(oldUpload)).toBeUndefined();
      expect((await row(freshAnswer)).purgedAt).toBeNull();
      expect(await row(newUpload)).toBeDefined();
      expect([...blobs.keys()].sort()).toEqual([freshAnswer, newUpload].sort());

      const second = await scheduler.purgeOnce();
      expect(second.answerFiles).toEqual({ due: 0, gone: 0 });
      expect(second.unsent).toEqual({ due: 0, gone: 0 });
    });

    it('follows a LOWERED retention at once, with no confirmation', async () => {
      const sub = await submission();
      const file = await upload({ submissionId: sub.id, ageHours: 3 * 24 });
      blobs.set(file, 'alice');
      expect((await scheduler.purgeOnce()).answerFiles.gone).toBe(0);
      await q(`UPDATE forms SET "fileRetentionDays" = 2 WHERE id = $1`, [FORM_A]);
      try {
        expect((await scheduler.purgeOnce()).answerFiles.gone).toBe(1);
      } finally {
        await q(`UPDATE forms SET "fileRetentionDays" = 7 WHERE id = $1`, [FORM_A]);
      }
    });

    it('keeps the row of a blob the media service refuses (another member object)', async () => {
      const sub = await submission();
      const file = await upload({ submissionId: sub.id, ageHours: 8 * 24 });
      blobs.set(file, 'mallory');
      const report = await scheduler.purgeOnce();
      expect(report.blobs.refused).toBe(1);
      expect((await row(file)).purgedAt).toBeNull();
      expect(blobs.has(file)).toBe(true);
    });
  });
});
