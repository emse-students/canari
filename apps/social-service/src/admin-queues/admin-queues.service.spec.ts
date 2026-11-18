import { Logger } from '@nestjs/common';
import { AdminQueuesService } from './admin-queues.service';
import { AdminQueuesController } from './admin-queues.controller';
import { REPORT_IS_FIRST_PENDING_SQL } from './admin-queue-sql';
import { socialDeepLink } from '../push/push-target';

/**
 * The unit half of the admin queues (owner, 2026-11-18): which queues a caller is counted for, and
 * who the notice of a new item reaches. The SQL itself - the reach of each count, the bell gate that
 * clears a notice for every admin - is proved against PostgreSQL in `bde-moderation.integration.spec`
 * and `bell-target-rows.integration.spec`.
 */
describe('AdminQueuesService', () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function make(opts: {
    moderates?: boolean;
    validates?: boolean;
    admins?: string[];
    first?: boolean;
    row?: Record<string, number>;
  }) {
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      if (sql === REPORT_IS_FIRST_PENDING_SQL) return [{ first: opts.first ?? true }];
      if (sql.includes('FROM users WHERE admin = true')) {
        return (opts.admins ?? []).filter((id) => id !== params[0]).map((id) => ({ id }));
      }
      return [opts.row ?? {}];
    });
    const associations = {
      isContentModerator: jest.fn().mockResolvedValue(opts.moderates ?? false),
      isUserBdeAdmin: jest.fn().mockResolvedValue(opts.validates ?? false),
    };
    const notifications = {
      createNotifications: jest.fn(async (d: { recipientIds: string[] }) => d.recipientIds.length),
    };
    const service = new AdminQueuesService(
      { manager: { query } } as never,
      associations as never,
      notifications as never
    );
    return { service, query, associations, notifications };
  }

  describe('pendingCounts', () => {
    it('counts all three queues for a global admin, unscoped, without asking any door', async () => {
      const { service, query, associations } = make({
        row: { 'profile-corrections': 2, moderation: 1, agenda: 4 },
      });
      expect(await service.pendingCounts('adm', true)).toEqual({
        'profile-corrections': 2,
        moderation: 1,
        agenda: 4,
      });
      expect(associations.isContentModerator).not.toHaveBeenCalled();
      expect(query.mock.calls[0][1]).toEqual(['adm', true]);
    });

    it('counts a BDE moderator its reports only, through the queue scope, and never the corrections', async () => {
      const { service, query } = make({ moderates: true, row: { moderation: 3 } });
      expect(await service.pendingCounts('mod', false)).toEqual({ moderation: 3 });
      const sql = query.mock.calls[0][0];
      expect(sql).toContain('content_reports');
      expect(sql).not.toContain('profile_correction_requests');
      expect(sql).not.toContain('association_calendar_events');
      expect(query.mock.calls[0][1]).toEqual(['mod', false]);
    });

    it('counts an event validator the agenda only', async () => {
      const { service, query } = make({ validates: true, row: { agenda: 1 } });
      expect(await service.pendingCounts('val', false)).toEqual({ agenda: 1 });
      expect(query.mock.calls[0][0]).not.toContain('content_reports');
    });

    it('answers nothing, and reads nothing, for a member with no tier', async () => {
      const { service, query } = make({});
      expect(await service.pendingCounts('member', false)).toEqual({});
      expect(query).not.toHaveBeenCalled();
    });

    it('the route reads the global-admin header nginx sets, and nothing else', async () => {
      const { service } = make({ row: { moderation: 0 } });
      const spy = jest.spyOn(service, 'pendingCounts');
      const route = new AdminQueuesController(service);
      await route.counts('u', 'true');
      await route.counts('u', 'TRUE');
      await route.counts('u', undefined);
      expect(spy.mock.calls.map((c) => c[1])).toEqual([true, false, false]);
    });
  });

  describe('the notices', () => {
    it('tells every GLOBAL admin of a filed correction, as the platform, with no text, opening the queue', async () => {
      const { service, notifications } = make({ admins: ['a1', 'a2'] });
      expect(await service.announceProfileCorrection('req-1', 'person')).toBe(2);
      expect(notifications.createNotifications).toHaveBeenCalledWith({
        recipientIds: ['a1', 'a2'],
        type: 'admin_profile_correction',
        postId: 'req-1',
        actorId: 'system',
        actorName: 'Canari',
        text: '',
        pushData: { target: 'admin-profile-corrections' },
      });
      expect(socialDeepLink({ target: 'admin-profile-corrections' })).toBe(
        'fr.emse.canari://admin-profile-corrections'
      );
    });

    it('never tells the person who asked, even an admin', async () => {
      const { service, notifications, query } = make({ admins: ['a1', 'a2'] });
      await service.announceProfileCorrection('req-1', 'a2');
      expect(query.mock.calls[0][1]).toEqual(['a2']);
      expect(notifications.createNotifications.mock.calls[0][0].recipientIds).toEqual(['a1']);
    });

    it('writes nothing when there is no admin to tell', async () => {
      const { service, notifications } = make({ admins: [] });
      expect(await service.announceProfileCorrection('req-1', 'p')).toBe(0);
      expect(notifications.createNotifications).not.toHaveBeenCalled();
    });

    it("announces a report only as its subject's first pending one, opening the moderation queue", async () => {
      const first = make({ admins: ['a1'], first: true });
      await first.service.announceReport({ id: 'rep-1', reporterId: 'r' });
      expect(first.notifications.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'admin_report',
          postId: 'rep-1',
          pushData: { target: 'admin-moderation' },
        })
      );
      expect(socialDeepLink({ target: 'admin-moderation' })).toBe(
        'fr.emse.canari://admin-moderation'
      );
      const again = make({ admins: ['a1'], first: false });
      await again.service.announceReport({ id: 'rep-2', reporterId: 'r' });
      expect(again.notifications.createNotifications).not.toHaveBeenCalled();
    });

    it('a report whose notice fails is still filed: the failure is logged at error, never thrown', async () => {
      const { service, notifications } = make({ admins: ['a1'] });
      notifications.createNotifications.mockRejectedValue(new Error('db down'));
      await expect(
        service.announceReport({ id: 'rep-1', reporterId: 'r' })
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT announced'));
    });
  });
});
