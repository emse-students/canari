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
    (name) => name !== 'constructor' && !name.startsWith('assert')
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
    '%s answers a typed 403 (never a 401, which may log out) and never reaches the service',
    async (name) => {
      await expect(ADMIN_CALLS[name](controller)).rejects.toMatchObject({
        status: 403,
        response: { code: 'MODERATOR_REQUIRED' },
      });
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    }
  );
});

/**
 * MODERATE IS SCOPED (owner, 2026-11-02): a BDE moderator passes the door, then acts only on what
 * lives in the spaces its BDE governs; a target outside is a typed 403 and never reaches the service.
 * The platform admin is never asked a scope.
 */
describe('ModerationController - the BDE scope', () => {
  const OUT = 'outsider';
  const IN = 'insider';
  function make() {
    const service = {
      listAllReports: jest
        .fn()
        .mockResolvedValue([{ id: 'r1', reporterId: IN, reportedUserId: OUT }]),
      reviewReport: jest.fn().mockResolvedValue({}),
      muteUser: jest.fn().mockResolvedValue({}),
      unmuteUser: jest.fn().mockResolvedValue({}),
      listMutedUsers: jest.fn().mockResolvedValue([]),
      findPostIdForComment: jest.fn().mockResolvedValue('p-out'),
      deleteCommentById: jest.fn().mockResolvedValue({ postId: 'p-out' }),
      commentsOfPost: jest.fn().mockResolvedValue([{ id: 'c1', userId: 'w' }]),
    };
    const assoc = {
      isContentModerator: jest.fn().mockResolvedValue(true),
      mayModerateUser: jest.fn((_u: string, target: string, o?: { isGlobalAdmin?: boolean }) =>
        Promise.resolve(o?.isGlobalAdmin === true || target === IN)
      ),
      moderatedUserIds: jest.fn((_u: string, ids: string[], o?: { isGlobalAdmin?: boolean }) =>
        Promise.resolve(new Set(ids.filter((id) => o?.isGlobalAdmin === true || id === IN)))
      ),
      mayModerateComment: jest.fn(
        (_u: string, _p: string, _c: string, o?: { isGlobalAdmin?: boolean }) =>
          Promise.resolve(o?.isGlobalAdmin === true)
      ),
      mayModerateReport: jest.fn((_u: string, _r: string, o?: { isGlobalAdmin?: boolean }) =>
        Promise.resolve(o?.isGlobalAdmin === true)
      ),
      refuseModeration: jest.fn(() =>
        Promise.reject(new ForbiddenException({ code: 'MODERATION_OUT_OF_SCOPE' }))
      ),
      moderatedAssociationIds: jest.fn((_u: string, ids: string[]) =>
        Promise.resolve(new Set(ids))
      ),
    };
    return {
      service,
      assoc,
      controller: new ModerationController(service as never, assoc as never),
    };
  }

  it('mutes a person of its spaces', async () => {
    const { controller, service } = make();
    await controller.muteUser(IN, 'bde', undefined, { reason: 'x' } as never);
    expect(service.muteUser).toHaveBeenCalledWith(IN, 'bde', 'x');
  });

  it('refuses to mute a person outside its spaces, with the typed 403', async () => {
    const { controller, service } = make();
    const refusal = await controller
      .muteUser(OUT, 'bde', undefined, { reason: 'x' } as never)
      .catch((e: unknown) => e);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({
      code: 'MODERATION_OUT_OF_SCOPE',
    });
    expect(service.muteUser).not.toHaveBeenCalled();
  });

  it('lets the platform admin mute anyone', async () => {
    const { controller, service } = make();
    await controller.muteUser(OUT, 'admin', 'true', { reason: 'x' } as never);
    expect(service.muteUser).toHaveBeenCalled();
  });

  it('refuses a report and a comment outside its scope before the service acts', async () => {
    const { controller, service } = make();
    await expect(
      controller.reviewReport('r1', 'bde', undefined, { action: 'dismissed' } as never)
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.deleteReportedComment('c1', 'bde', undefined)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(service.reviewReport).not.toHaveBeenCalled();
    expect(service.deleteCommentById).not.toHaveBeenCalled();
  });

  it('asks the COMMENT, not its post, and names the post in the typed refusal (owner, 2026-11-03)', async () => {
    // Moderating the post is not enough: an institution's or another BDE's comment under it is the
    // platform admin's, so the route asks `mayModerateComment` with the post and the comment.
    const { controller, assoc } = make();
    await controller.deleteReportedComment('c1', 'bde', undefined).catch(() => undefined);
    expect(assoc.mayModerateComment).toHaveBeenCalledWith('bde', 'p-out', 'c1', {
      isGlobalAdmin: false,
    });
    expect(assoc.refuseModeration).toHaveBeenCalledWith('bde', {
      kind: 'comment',
      id: 'c1',
      postId: 'p-out',
    });
  });

  it('lets the platform admin delete any comment, taking every descendant (it moderates them all)', async () => {
    const { controller, service } = make();
    await controller.deleteReportedComment('c1', 'admin', 'true');
    const [id, mayRemove] = service.deleteCommentById.mock.calls[0] as [
      string,
      (c: Record<string, unknown>) => boolean,
    ];
    expect(id).toBe('c1');
    expect(mayRemove({ id: 'r', userId: 'x', associationId: 'an-institution' })).toBe(true);
  });

  it('reads the queue in its scope and says which person on each row it may mute', async () => {
    const { controller, service } = make();
    const [row] = (await controller.listReports('bde')) as {
      canMuteReporter: boolean;
      canMuteReportedUser: boolean;
    }[];
    expect(service.listAllReports).toHaveBeenCalledWith(
      { userId: 'bde', isGlobalAdmin: false },
      50,
      0
    );
    expect(row.canMuteReporter).toBe(true);
    expect(row.canMuteReportedUser).toBe(false);
  });

  it('reads the muted list in its scope', async () => {
    const { controller, service } = make();
    await controller.listMutedUsers('bde');
    expect(service.listMutedUsers).toHaveBeenCalledWith({ userId: 'bde', isGlobalAdmin: false });
  });
});
