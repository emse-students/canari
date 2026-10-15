import { FormFileRetentionScheduler } from './form-file-retention.scheduler';
import {
  fileRetentionDeadline,
  isFileRetentionDue,
  purgeExpiredFiles,
} from './file-retention-purge';

/**
 * THE PURGE OF FORM FILES, RUN AGAINST A FAKE OF ITS TWO STORES: the `form_files` rows (the state)
 * and the media service (the blobs, with its allowlist).
 *
 * What must hold: the ANSWER stays and only the file goes; a second run changes nothing; a blob that
 * will not delete keeps its row and does not spin the run; an id that is not a form file of its
 * uploader is never deleted, even sitting in an answer; an unsent upload goes with its row.
 */

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

interface Row {
  id: string;
  formId: string;
  uploaderId: string;
  submissionId: string | null;
  attachedAt: Date | null;
  purgedAt: Date | null;
  createdAt: Date;
}

interface Blob {
  ownerId: string;
  retentionClass: string;
}

function makeWorld(opts: {
  rows: Row[];
  blobs: Record<string, Blob>;
  retentionDays?: number;
  failing?: string[];
  /** What PostgreSQL's NOW() answers; this box's clock by default. */
  dbNow?: Date;
}) {
  const dbNow = opts.dbNow ?? new Date();
  const rows = opts.rows;
  const blobs = opts.blobs;
  const deletedBlobs: string[] = [];
  const days = opts.retentionDays ?? 7;

  const fileRepo: any = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      const excluded = new Set((params[0] as string[] | undefined) ?? []);
      // The database's clock: the one instant the run is judged at.
      if (sql.includes('SELECT NOW() AS now')) {
        return Promise.resolve([{ now: dbNow.toISOString() }]);
      }
      if (sql.includes('JOIN forms')) {
        const now = (params[2] as Date).getTime();
        return Promise.resolve(
          rows
            .filter(
              (r) =>
                !r.purgedAt &&
                r.submissionId &&
                r.attachedAt &&
                r.attachedAt.getTime() + days * DAY <= now &&
                !excluded.has(r.id)
            )
            .map((r) => ({ id: r.id, uploaderId: r.uploaderId, start: r.attachedAt, days }))
        );
      }
      if (sql.includes('"createdAt" <= $4::timestamptz')) {
        const windowDays = params[2] as number;
        const now = (params[3] as Date).getTime();
        return Promise.resolve(
          rows
            .filter(
              (r) =>
                !r.purgedAt &&
                !r.submissionId &&
                r.createdAt.getTime() <= now - windowDays * DAY &&
                !excluded.has(r.id)
            )
            .map((r) => ({
              id: r.id,
              uploaderId: r.uploaderId,
              start: r.createdAt,
              days: windowDays,
            }))
        );
      }
      if (sql.includes('UPDATE form_files SET "purgedAt"')) {
        const row = rows.find((r) => r.id === params[0] && !r.purgedAt && r.submissionId);
        if (row) row.purgedAt = new Date();
        return Promise.resolve(row ? [{ id: row.id }] : []);
      }
      if (sql.includes('WHERE id = $1 AND "submissionId" IS NULL')) {
        const i = rows.findIndex((r) => r.id === params[0] && !r.submissionId && !r.purgedAt);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve(i >= 0 ? [{ id: params[0] }] : []);
      }
      if (sql.includes('"purgedAt" IS NOT NULL RETURNING')) {
        const gone = rows.filter((r) => !r.submissionId && r.purgedAt);
        for (const r of gone) rows.splice(rows.indexOf(r), 1);
        return Promise.resolve(gone.map((r) => ({ id: r.id })));
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };

  // The media service's own rule: class `form-file` AND the named uploader, or `refused`.
  const files: any = {
    purgeBlobs: jest.fn((items: Array<{ mediaId: string; ownerId: string }>) => {
      const out: Record<string, string> = {};
      for (const { mediaId, ownerId } of items) {
        const blob = blobs[mediaId];
        if (!blob) out[mediaId] = 'absent';
        else if (blob.retentionClass !== 'form-file' || blob.ownerId !== ownerId)
          out[mediaId] = 'refused';
        else if (opts.failing?.includes(mediaId)) out[mediaId] = 'failed';
        else {
          delete blobs[mediaId];
          deletedBlobs.push(mediaId);
          out[mediaId] = 'deleted';
        }
      }
      return Promise.resolve(out);
    }),
  };

  const scheduler = new FormFileRetentionScheduler(fileRepo, files);
  const logs: string[] = [];
  const logger = (scheduler as any).logger;
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(logger, level).mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
  }
  return { scheduler, rows, blobs, deletedBlobs, files, fileRepo, logs };
}

const answerRow = (id: string, daysAgo: number, uploaderId = 'alice'): Row => ({
  id,
  formId: 'f1',
  uploaderId,
  submissionId: `sub-${id}`,
  attachedAt: ago(daysAgo),
  purgedAt: null,
  createdAt: ago(daysAgo),
});

describe('FormFileRetentionScheduler', () => {
  it('deletes a due answer file, KEEPS the row as "purged", and a second run changes nothing', async () => {
    const world = makeWorld({
      rows: [answerRow('due', 8), answerRow('fresh', 2)],
      blobs: {
        due: { ownerId: 'alice', retentionClass: 'form-file' },
        fresh: { ownerId: 'alice', retentionClass: 'form-file' },
      },
    });

    const first = await world.scheduler.purgeOnce();
    expect(first.answerFiles).toEqual({ due: 1, gone: 1 });
    expect(world.deletedBlobs).toEqual(['due']);
    const due = world.rows.find((r) => r.id === 'due')!;
    expect(due.purgedAt).toBeInstanceOf(Date);
    expect(due.submissionId).toBe('sub-due');
    expect(world.rows.find((r) => r.id === 'fresh')!.purgedAt).toBeNull();
    expect(world.logs.some((l) => l.includes('file=due deleted'))).toBe(true);

    const second = await world.scheduler.purgeOnce();
    expect(second.answerFiles).toEqual({ due: 0, gone: 0 });
    expect(world.deletedBlobs).toEqual(['due']);
    expect(world.files.purgeBlobs).toHaveBeenCalledTimes(1);
  });

  it('keeps the row of a blob that fails to delete, does not spin, and retries next run', async () => {
    const world = makeWorld({
      rows: [answerRow('stuck', 9), answerRow('ok', 9)],
      blobs: {
        stuck: { ownerId: 'alice', retentionClass: 'form-file' },
        ok: { ownerId: 'alice', retentionClass: 'form-file' },
      },
      failing: ['stuck'],
    });

    const report = await world.scheduler.purgeOnce();
    expect(report.answerFiles).toEqual({ due: 2, gone: 1 });
    expect(report.kept).toBe(1);
    expect(world.rows.find((r) => r.id === 'stuck')!.purgedAt).toBeNull();
    expect(world.rows.find((r) => r.id === 'ok')!.purgedAt).toBeInstanceOf(Date);
    // One batch, then a second query that excluded `stuck` and found nothing: no loop.
    expect(world.files.purgeBlobs).toHaveBeenCalledTimes(1);
    expect(world.logs.some((l) => l.includes('file=stuck could not be deleted'))).toBe(true);

    const retry = await world.scheduler.purgeOnce();
    expect(retry.answerFiles.due).toBe(1);
  });

  // The id in an answer is not a licence: a row citing a chat photo of the same member is refused
  // by the media service, and its blob survives.
  it('never deletes an object of another class, even when a row names it', async () => {
    const world = makeWorld({
      rows: [answerRow('chat-photo', 30)],
      blobs: { 'chat-photo': { ownerId: 'alice', retentionClass: 'ephemeral' } },
    });
    const report = await world.scheduler.purgeOnce();
    expect(report.blobs.refused).toBe(1);
    expect(world.blobs['chat-photo']).toBeDefined();
    expect(world.rows[0].purgedAt).toBeNull();
    expect(world.logs.some((l) => l.includes('refused by the media service'))).toBe(true);
  });

  it('purges an unsent upload past its window WITH its row, and leaves a fresh one', async () => {
    const world = makeWorld({
      rows: [
        { ...answerRow('old', 0), submissionId: null, attachedAt: null, createdAt: ago(2) },
        { ...answerRow('new', 0), submissionId: null, attachedAt: null, createdAt: ago(0.5) },
      ],
      blobs: {
        old: { ownerId: 'alice', retentionClass: 'form-file' },
        new: { ownerId: 'alice', retentionClass: 'form-file' },
      },
    });
    const report = await world.scheduler.purgeOnce();
    expect(report.unsent).toEqual({ due: 1, gone: 1 });
    expect(world.rows.map((r) => r.id)).toEqual(['new']);
    expect(world.blobs.new).toBeDefined();
  });

  it('treats a blob already gone (a rerun after a crash) as done and clears its row', async () => {
    const world = makeWorld({ rows: [answerRow('half-done', 10)], blobs: {} });
    const report = await world.scheduler.purgeOnce();
    expect(report.blobs.absent).toBe(1);
    expect(world.rows[0].purgedAt).toBeInstanceOf(Date);
  });

  // Selection and re-check read ONE clock. The database runs an hour ahead of this box; a file due
  // 30 minutes from now by the box is due by the database, and must be purged rather than logged as
  // "selected but not due" every hour.
  it('judges at the database clock, so a skewed box never calls a selected file early', async () => {
    const world = makeWorld({
      rows: [{ ...answerRow('edge', 0), attachedAt: ago(7 - 0.5 / 24) }],
      blobs: { edge: { ownerId: 'alice', retentionClass: 'form-file' } },
      dbNow: new Date(Date.now() + 60 * 60 * 1000),
    });
    const report = await world.scheduler.purgeOnce();
    expect(report.answerFiles).toEqual({ due: 1, gone: 1 });
    expect(world.logs.some((l) => l.includes('selected but not due'))).toBe(false);
  });

  it('skips a tick while the previous run is still going', async () => {
    const world = makeWorld({ rows: [], blobs: {} });
    (world.scheduler as any).running = true;
    await world.scheduler.purgeExpiredFormFiles();
    expect(world.fileRepo.query).not.toHaveBeenCalled();
  });
});

describe('purgeExpiredFiles - the starting date is a parameter', () => {
  const logger: any = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const start = new Date('2026-10-01T18:00:00Z');

  it('counts N days from the start it is given (a slot end, an answer date)', () => {
    expect(fileRetentionDeadline(start, 7).toISOString()).toBe('2026-10-08T18:00:00.000Z');
    const c = { fileId: 'x', ownerId: 'a', start, retentionDays: 7 };
    expect(isFileRetentionDue(c, new Date('2026-10-08T17:59:59Z'))).toBe(false);
    expect(isFileRetentionDue(c, new Date('2026-10-08T18:00:00Z'))).toBe(true);
  });

  it('refuses to delete a candidate not due by its own clock, whatever selected it', async () => {
    const deps = { deleteBlobs: jest.fn(), markGone: jest.fn() };
    const res = await purgeExpiredFiles(
      [{ fileId: 'x', ownerId: 'a', start, retentionDays: 7 }],
      new Date('2026-10-02T00:00:00Z'),
      deps,
      logger,
      '[T]'
    );
    expect(res.kept).toEqual(['x']);
    expect(deps.deleteBlobs).not.toHaveBeenCalled();
  });

  it('keeps everything when the media service does not answer', async () => {
    const deps = {
      deleteBlobs: jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
      markGone: jest.fn(),
    };
    const res = await purgeExpiredFiles(
      [{ fileId: 'x', ownerId: 'a', start, retentionDays: 1 }],
      new Date('2026-10-20T00:00:00Z'),
      deps,
      logger,
      '[T]'
    );
    expect(res.kept).toEqual(['x']);
    expect(deps.markGone).not.toHaveBeenCalled();
  });

  it('keeps a file whose blob is gone but whose row could not be updated', async () => {
    const deps = {
      deleteBlobs: jest.fn(() => Promise.resolve({ x: 'deleted' as const })),
      markGone: jest.fn(() => Promise.reject(new Error('db down'))),
    };
    const res = await purgeExpiredFiles(
      [{ fileId: 'x', ownerId: 'a', start, retentionDays: 1 }],
      new Date('2026-10-20T00:00:00Z'),
      deps,
      logger,
      '[T]'
    );
    expect(res).toEqual(expect.objectContaining({ gone: [], kept: ['x'] }));
  });
});
