import 'reflect-metadata';

import { ForbiddenException } from '@nestjs/common';

import { ModerationController } from './moderation.controller';

/**
 * EVERY ADMIN PATH OF MODERATION REFUSES A CALLER WHO IS NOT A MODERATOR.
 *
 * The 2026-08-22 read of this controller found its authorisation correct and recorded that nothing
 * would NOTICE if that stopped being true ([mechanism-audit](docs/wiki/mechanism-audit.md)). This is
 * that watcher: each handler is called as a caller `isContentModerator` refuses and must throw 403
 * before the service is touched. The handler list is read from the prototype, so a route ADDED
 * without an entry in `EXPECTATIONS` fails the table check instead of passing unseen.
 */
describe('ModerationController - admin paths refuse a non-moderator', () => {
  /** Routes meant for any authenticated caller, each with the reason it is open. */
  const OPEN_BY_INTENT: Record<string, string> = {
    createReport: 'any member may report; the reporter id comes from the x-user-id header',
    myMuteStatus: 'a caller reads only their own mute status',
  };

  /** One call per admin handler, as a plain member with no admin header. */
  const ADMIN_CALLS: Record<string, (c: ModerationController) => Promise<unknown>> = {
    listReports: (c) => c.listReports('u1'),
    reviewReport: (c) => c.reviewReport('r1', 'u1', undefined, { action: 'dismiss' } as never),
    muteUser: (c) => c.muteUser('t1', 'u1', undefined, { reason: 'x' } as never),
    unmuteUser: (c) => c.unmuteUser('t1', 'u1', undefined),
    listMutedUsers: (c) => c.listMutedUsers('u1'),
    deleteReportedComment: (c) => c.deleteReportedComment('c1', 'u1', undefined),
  };

  const handlers = Object.getOwnPropertyNames(ModerationController.prototype).filter(
    (name) => name !== 'constructor' && name !== 'assertModerator'
  );

  const service = {
    listAllReports: jest.fn(),
    reviewReport: jest.fn(),
    muteUser: jest.fn(),
    unmuteUser: jest.fn(),
    listMutedUsers: jest.fn(),
    deleteCommentById: jest.fn(),
  };
  const assoc = { isContentModerator: jest.fn().mockResolvedValue(false) };
  const controller = new ModerationController(service as never, assoc as never);

  it('accounts for every handler, either as open by intent or as an admin call', () => {
    const unaccounted = handlers.filter((h) => !OPEN_BY_INTENT[h] && !ADMIN_CALLS[h]);
    expect(unaccounted).toEqual([]);
  });

  it.each(Object.keys(ADMIN_CALLS))(
    '%s answers 403 and never reaches the service',
    async (name) => {
      await expect(ADMIN_CALLS[name](controller)).rejects.toBeInstanceOf(ForbiddenException);
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    }
  );
});
