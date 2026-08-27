import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
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
    manager: { query: jest.Mock };
  };
  let muteRepo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock; find: jest.Mock };

  beforeEach(() => {
    reportRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((row) => row),
      save: jest.fn().mockImplementation((row) => Promise.resolve({ id: 'r1', ...row })),
      count: jest.fn().mockResolvedValue(1),
      manager: { query: jest.fn().mockResolvedValue([]) },
    };
    muteRepo = { findOne: jest.fn(), save: jest.fn(), create: jest.fn(), find: jest.fn() };
    service = new ModerationService(
      reportRepo as unknown as Repository<ContentReport>,
      muteRepo as unknown as Repository<UserModeration>
    );
  });

  describe('createReport', () => {
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
