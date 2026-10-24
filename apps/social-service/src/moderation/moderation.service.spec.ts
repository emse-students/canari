import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import * as signature from '../lives/live-report-signature';
import { LIVE_KEY_ENCRYPTION_SECRET_ENV, sealLiveKey } from '../lives/live-key-at-rest';
import { ModerationService } from './moderation.service';
import type { ContentReport } from './entities/content-report.entity';
import type { UserModeration } from './entities/user-moderation.entity';

/**
 * What the 2026-08-27 report reform changed, and therefore what must not regress:
 * a report is filed ONCE whatever becomes of it, the refusal carries a code rather than a sentence,
 * a person can be reported, and listing reports no longer deletes anything.
 */
describe('ModerationService - reports', () => {
  let service: ModerationService;
  let reportRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    manager: { query: jest.Mock; transaction: jest.Mock };
  };
  let muteRepo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock; find: jest.Mock };

  beforeEach(() => {
    reportRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((row) => row),
      save: jest.fn().mockImplementation((row) => Promise.resolve({ id: 'r1', ...row })),
      count: jest.fn().mockResolvedValue(1),
      manager: { query: jest.fn().mockResolvedValue([]), transaction: jest.fn() },
    };
    // The hide and the republications it drops are one transaction, run on the same query mock.
    reportRepo.manager.transaction.mockImplementation((fn: (m: unknown) => unknown) =>
      fn(reportRepo.manager)
    );
    muteRepo = { findOne: jest.fn(), save: jest.fn(), create: jest.fn(), find: jest.fn() };
    service = new ModerationService(
      reportRepo as unknown as Repository<ContentReport>,
      muteRepo as unknown as Repository<UserModeration>
    );
  });

  describe('createReport', () => {
    it('takes the writer of a reported comment from the stored comment, never from the client', async () => {
      reportRepo.manager.query.mockResolvedValue([{ user_id: 'real-writer' }]);

      await service.createReport({
        reporterId: 'alice',
        contentType: 'comment',
        contentId: 'c1',
        reason: 'spam',
        reportedUserId: 'spoofed',
      });

      expect(reportRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reportedUserId: 'real-writer' })
      );
    });

    it('refuses a duplicate with a code, not with a sentence a client would have to read', async () => {
      reportRepo.findOne.mockResolvedValue({ id: 'r0', status: 'pending' });

      await expect(
        service.createReport({
          reporterId: 'alice',
          contentType: 'post',
          contentId: 'p1',
          reason: 'spam',
        })
      ).rejects.toMatchObject({
        response: { code: 'ALREADY_REPORTED' },
      });
    });

    it('answers 409 so the status alone classifies the refusal', async () => {
      reportRepo.findOne.mockResolvedValue({ id: 'r0', status: 'pending' });

      await expect(
        service.createReport({
          reporterId: 'alice',
          contentType: 'post',
          contentId: 'p1',
          reason: 'spam',
        })
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a second report even after the first was dismissed - a dismissal is an answer', async () => {
      // The check used to be scoped to `status: 'pending'`, which re-opened the door on every
      // dismissal and let one person file the same accusation indefinitely.
      reportRepo.findOne.mockResolvedValue({ id: 'r0', status: 'dismissed' });

      await expect(
        service.createReport({
          reporterId: 'alice',
          contentType: 'post',
          contentId: 'p1',
          reason: 'spam',
        })
      ).rejects.toBeInstanceOf(ConflictException);

      expect(reportRepo.findOne).toHaveBeenCalledWith({
        where: { reporterId: 'alice', contentId: 'p1' },
      });
    });

    it('accepts a report targeting a person', async () => {
      await service.createReport({
        reporterId: 'alice',
        contentType: 'user',
        contentId: 'bob',
        reason: 'harassment',
        reportedUserId: 'bob',
      });

      expect(reportRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'user', contentId: 'bob', reportedUserId: 'bob' })
      );
    });

    it('auto-hides a post at the threshold, and counts content_reports to decide it', async () => {
      reportRepo.count.mockResolvedValue(5);

      await service.createReport({
        reporterId: 'alice',
        contentType: 'post',
        contentId: 'p1',
        reason: 'spam',
      });

      expect(reportRepo.count).toHaveBeenCalledWith({
        where: { contentId: 'p1', status: 'pending' },
      });
      expect(reportRepo.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('hiddenByModeration'),
        ['p1']
      );
      // D38: hiding the original removes every republication, in the same transaction.
      expect(reportRepo.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM post_republications'),
        ['p1']
      );
    });

    it('leaves a post alone below the threshold', async () => {
      reportRepo.count.mockResolvedValue(4);

      await service.createReport({
        reporterId: 'alice',
        contentType: 'post',
        contentId: 'p1',
        reason: 'spam',
      });

      expect(reportRepo.manager.query).not.toHaveBeenCalled();
    });

    it('never auto-hides on a report that is not about a post', async () => {
      reportRepo.count.mockResolvedValue(50);

      await service.createReport({
        reporterId: 'alice',
        contentType: 'user',
        contentId: 'bob',
        reason: 'harassment',
      });

      expect(reportRepo.count).not.toHaveBeenCalled();
      expect(reportRepo.manager.query).not.toHaveBeenCalled();
    });
  });

  describe('createReport on a live (WP-L8)', () => {
    const LIVE = '22222222-2222-4222-8222-222222222222';

    it('stores the BROADCASTER read from the live, never the id the client sent, and hides nothing', async () => {
      reportRepo.manager.query
        .mockResolvedValueOnce([{ broadcasterId: 'bob', visible: true }]) // the live
        .mockResolvedValueOnce([]); // no block between alice and bob
      reportRepo.count.mockResolvedValue(50);

      await service.createReport({
        reporterId: 'alice',
        contentType: 'live',
        contentId: LIVE.toUpperCase(),
        reason: 'inappropriate',
        reportedUserId: 'mallory',
      });

      expect(reportRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'live', contentId: LIVE, reportedUserId: 'bob' })
      );
      // A live is CUT by staff, never auto-hidden by a count (no policy says otherwise).
      expect(reportRepo.count).not.toHaveBeenCalled();
    });

    it('lets a viewer the broadcaster REMOVED report the live itself - what they watched before is theirs', async () => {
      reportRepo.manager.query
        .mockResolvedValueOnce([{ broadcasterId: 'bob', visible: true }]) // the live
        .mockResolvedValueOnce([]); // no block between alice and bob

      await service.createReport({
        reporterId: 'alice',
        contentType: 'live',
        contentId: LIVE,
        reason: 'inappropriate',
      });

      // The removal is a chat-line predicate only: the live's own read never consults the list.
      expect(String(reportRepo.manager.query.mock.calls[0][0])).not.toContain(
        'live_removed_viewers'
      );
      expect(reportRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'live', reportedUserId: 'bob' })
      );
    });

    it.each([
      ['an id that is not a uuid', 'not-a-uuid', []],
      ['a live with no row', LIVE, []],
      [
        'a live the reporter cannot see (the rule of a post)',
        LIVE,
        [{ broadcasterId: 'bob', visible: false }],
      ],
    ])('answers 404 LIVE_NOT_FOUND for %s, and files nothing', async (_what, id, rows) => {
      reportRepo.manager.query.mockResolvedValueOnce(rows);

      await expect(
        service.createReport({
          reporterId: 'alice',
          contentType: 'live',
          contentId: id,
          reason: 'spam',
        })
      ).rejects.toMatchObject({ status: 404, response: { code: 'LIVE_NOT_FOUND' } });
      expect(reportRepo.save).not.toHaveBeenCalled();
    });

    it('answers 404 across a block, in either direction, as the live itself does', async () => {
      reportRepo.manager.query
        .mockResolvedValueOnce([{ broadcasterId: 'bob', visible: true }])
        .mockResolvedValueOnce([{ '?column?': 1 }]);

      await expect(
        service.createReport({
          reporterId: 'alice',
          contentType: 'live',
          contentId: LIVE,
          reason: 'spam',
        })
      ).rejects.toMatchObject({ status: 404, response: { code: 'LIVE_NOT_FOUND' } });
    });
  });

  describe('a live chat line (WP-L8b)', () => {
    const LIVE = '22222222-2222-4222-8222-222222222222';
    const MSG = '33333333-3333-4333-8333-333333333333';
    const CLIENT = '44444444-4444-4444-8444-444444444444';
    const report = {
      reporterId: 'alice',
      contentType: 'live_chat' as const,
      contentId: MSG,
      reason: 'spam' as const,
      message: 'hello',
    };

    /** Answers each statement by its table, so the order of the service's reads is free. */
    function answer(opts: { afterRemoval?: boolean }) {
      reportRepo.manager.query.mockImplementation((sql: string) => {
        if (sql.includes('"liveId"::text FROM live_chat_messages')) return [{ liveId: LIVE }];
        // The live's key as migration 110 stores it: sealed, so `openLiveKey` opens it silently.
        if (sql.includes('FROM lives'))
          return [
            {
              broadcasterId: 'bob',
              ...sealLiveKey(LIVE, '00'.repeat(32)),
              liveKey: null,
              visible: true,
            },
          ];
        if (sql.includes('FROM live_chat_messages'))
          return [
            {
              seq: 1,
              authorId: 'carol',
              clientId: CLIENT,
              sealed: Buffer.alloc(40),
              createdAt: new Date(),
              afterRemoval: !!opts.afterRemoval,
            },
          ];
        return [];
      });
    }

    beforeEach(() => {
      process.env.LIVE_REPORT_SIGNING_KEY = 'k'.repeat(64);
      process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV] = 's'.repeat(32);
    });

    afterEach(() => {
      delete process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV];
      jest.restoreAllMocks();
    });

    it('answers 404 LIVE_NOT_FOUND for a line written AFTER the reporter was removed from the live', async () => {
      answer({ afterRemoval: true });

      await expect(service.createReport(report)).rejects.toMatchObject({
        status: 404,
        response: { code: 'LIVE_NOT_FOUND' },
      });
      expect(reportRepo.save).not.toHaveBeenCalled();
    });

    it('lets a removed viewer report a line written BEFORE the removal (the text check then decides)', async () => {
      answer({ afterRemoval: false });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      // The sealed bytes are not a real seal, so passing the removal gate lands on the mismatch.
      await expect(service.createReport(report)).rejects.toMatchObject({
        status: 400,
        response: { code: 'LIVE_CHAT_REPORT_MISMATCH' },
      });
      const lineRead = reportRepo.manager.query.mock.calls.find(([sql]: [string]) =>
        sql.includes('AS "afterRemoval"')
      );
      expect(lineRead?.[1]).toEqual([MSG, 'alice']);
    });

    it('logs a content mismatch at warn ONCE per (reporter, message), then at debug', async () => {
      answer({});
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();

      for (let i = 0; i < 3; i++) {
        await expect(service.createReport(report)).rejects.toMatchObject({
          status: 400,
          response: { code: 'LIVE_CHAT_REPORT_MISMATCH' },
        });
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls.filter((c) => String(c[0]).includes('(repeat)'))).toHaveLength(2);

      await expect(service.createReport({ ...report, reporterId: 'dave' })).rejects.toMatchObject({
        status: 400,
      });
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('bounds the once-only set: past 1000 distinct pairs it is cleared, so the first pair warns again', async () => {
      answer({});
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest.spyOn(Logger.prototype, 'debug').mockImplementation();

      for (let i = 0; i < 1000; i++) {
        await expect(
          service.createReport({ ...report, reporterId: `r${i}` })
        ).rejects.toMatchObject({ status: 400 });
      }
      expect(warn).toHaveBeenCalledTimes(1000);
      // The first pair is still remembered while the set is full.
      await expect(service.createReport({ ...report, reporterId: 'r0' })).rejects.toMatchObject({
        status: 400,
      });
      expect(warn).toHaveBeenCalledTimes(1000);
      // The 1001st distinct pair clears the set, so the first pair warns once more.
      await expect(service.createReport({ ...report, reporterId: 'r1000' })).rejects.toMatchObject({
        status: 400,
      });
      await expect(service.createReport({ ...report, reporterId: 'r0' })).rejects.toMatchObject({
        status: 400,
      });
      expect(warn).toHaveBeenCalledTimes(1002);
    });

    it.each([
      ['verified', 'hello'],
      ['altered', null],
      ['key-rotated', null],
      ['unverifiable', null],
    ] as const)(
      'shows the staff preview of a kept line only when its content is verified (%s)',
      async (content, preview) => {
        reportRepo.find.mockResolvedValue([
          {
            id: 'r1',
            contentType: 'live_chat',
            contentId: MSG,
            reporterId: 'alice',
            reason: 'spam',
          },
        ]);
        reportRepo.manager.query.mockImplementation((sql: string) =>
          sql.includes('live_chat_reported_lines')
            ? [
                {
                  reportId: 'r1',
                  liveId: LIVE,
                  messageId: MSG,
                  seq: 1,
                  authorId: 'carol',
                  clientId: CLIENT,
                  sealedSha256: 'x',
                  text: Buffer.from('hello'),
                  messageCreatedAt: new Date(),
                  keptAt: new Date(),
                  authorName: 'Carol',
                },
              ]
            : []
        );
        jest
          .spyOn(signature, 'verifyReportedLine')
          .mockReturnValue({ content, author: 'verified', reporter: 'verified' });

        const [row] = await service.listAllReports();

        expect(row.contentPreview).toBe(preview);
        expect(row.liveChat?.text).toBe('hello');
      }
    );
  });

  describe('listAllReports', () => {
    it('deletes nothing - retention is the weekly cron and not a side effect of reading', async () => {
      reportRepo.find.mockResolvedValue([]);

      await service.listAllReports();

      const statements = reportRepo.manager.query.mock.calls.map((c) => String(c[0]));
      expect(statements.some((sql) => /DELETE/i.test(sql))).toBe(false);
    });

    it('previews a reported person by display name, so a moderator does not read a bare uuid', async () => {
      reportRepo.find.mockResolvedValue([
        { id: 'r1', contentType: 'user', contentId: 'bob', reason: 'harassment' },
      ]);
      reportRepo.manager.query.mockResolvedValue([{ id: 'bob', displayName: 'Bob Martin' }]);

      const [row] = await service.listAllReports();

      expect(row.contentPreview).toBe('Bob Martin');
      expect(row.postId).toBeNull();
    });

    it('falls back to the id when a reported account has no display name', async () => {
      reportRepo.find.mockResolvedValue([
        { id: 'r1', contentType: 'user', contentId: 'bob', reason: 'other' },
      ]);
      reportRepo.manager.query.mockResolvedValue([{ id: 'bob', displayName: null }]);

      const [row] = await service.listAllReports();

      expect(row.contentPreview).toBe('bob');
    });
  });
});
