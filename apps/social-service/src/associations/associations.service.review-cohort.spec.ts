import { AssociationsService } from './associations.service';
import { AssociationsController } from './associations.controller';
import type { ProductsService } from './products.service';
import type { PartnershipsService } from './partnerships.service';
import type { FollowsService } from '../follows/follows.service';
import type { UserTagService } from '../users/user-tag.service';
import type { UserProfileService } from './user-profile.service';

/**
 * A REVIEW ACCOUNT HAS NO PUBLIC IDENTITY, AND A PROFILE SHOWS NOTHING ACROSS THE BOUNDARY
 * (review-cohort.ts): the public roster of an association never lists one, and a profile's
 * memberships and roles read as empty across the boundary. Since 2026-11-02 a profile is read with a
 * session only (anonymous-surface-closed.spec.ts).
 */
describe('association profiles and rosters and the review cohort', () => {
  const saved = process.env.SERVICE_ACCOUNT_USER_ID;
  const savedFrontend = process.env.FRONTEND_URL;
  beforeEach(() => {
    process.env.SERVICE_ACCOUNT_USER_ID = 'reviewer';
    process.env.FRONTEND_URL = 'https://canari.example/';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
    else process.env.SERVICE_ACCOUNT_USER_ID = saved;
    if (savedFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = savedFrontend;
  });

  /** The service with only its member repository wired: the one dependency these reads touch. */
  function serviceWith(memberRepo: unknown) {
    return new AssociationsService(
      undefined as never,
      memberRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { enabled: () => false, tell: async () => 0 } as never
    );
  }

  it('never lists a review account on a public roster', async () => {
    const raw = (userId: string) => ({ m_id: `row-${userId}`, m_userId: userId, m_permissions: 0 });
    const qb: Record<string, jest.Mock> = {};
    for (const step of ['select', 'addSelect', 'leftJoin', 'where', 'orderBy', 'addOrderBy']) {
      qb[step] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn(() => Promise.resolve([raw('member'), raw('reviewer')]));
    const service = serviceWith({ createQueryBuilder: jest.fn(() => qb) });
    const listed = await service.listMembersPublic('asso1');
    expect(listed.map((m) => m.userId)).toEqual(['member']);
    // The photo is the ROW's, absolute on Canari's public origin (anonymous-surface.md).
    expect(listed[0].avatarUrl).toBe('https://canari.example/api/public/members/row-member/avatar');
  });

  describe('the account behind a public roster row (the photo relay)', () => {
    const ROW = '0b6f3c2e-1111-4222-8333-123456789abc';

    it('answers the account of a row on a public roster', async () => {
      const findOne = jest.fn(() => Promise.resolve({ userId: 'member' }));
      expect(await serviceWith({ findOne }).publicMemberUserId(ROW)).toBe('member');
    });

    it('answers nobody for a review account, whose face is never public', async () => {
      const findOne = jest.fn(() => Promise.resolve({ userId: 'reviewer' }));
      expect(await serviceWith({ findOne }).publicMemberUserId(ROW)).toBeNull();
    });

    it('answers nobody for a malformed id, without asking the database', async () => {
      const findOne = jest.fn();
      expect(await serviceWith({ findOne }).publicMemberUserId('not-a-uuid')).toBeNull();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('answers nobody for a row that does not exist', async () => {
      const findOne = jest.fn(() => Promise.resolve(null));
      expect(await serviceWith({ findOne }).publicMemberUserId(ROW)).toBeNull();
    });
  });

  describe('the photo URLs of the carte cards', () => {
    const ASSO = '1a2b3c4d-1111-4222-8333-123456789abc';

    it('gives each card on a roster its row photo, and none to a review account', async () => {
      const find = jest.fn(() =>
        Promise.resolve([
          { id: 'row-1', associationId: ASSO, userId: 'member' },
          { id: 'row-2', associationId: ASSO, userId: 'reviewer' },
        ])
      );
      const urls = await serviceWith({ find }).publicAvatarUrlsFor([
        { associationId: ASSO, userId: 'member' },
        { associationId: ASSO, userId: 'reviewer' },
      ]);
      expect([...urls.entries()]).toEqual([
        [`${ASSO}:member`, 'https://canari.example/api/public/members/row-1/avatar'],
      ]);
    });

    it('never asks the database about a malformed association id', async () => {
      const find = jest.fn(() => Promise.resolve([]));
      const urls = await serviceWith({ find }).publicAvatarUrlsFor([
        { associationId: 'not-a-uuid', userId: 'member' },
      ]);
      expect(urls.size).toBe(0);
      expect(find).not.toHaveBeenCalled();
    });

    it('asks only about the well-formed pairs', async () => {
      const find = jest.fn((_q: { where: unknown[] }) => Promise.resolve([]));
      await serviceWith({ find }).publicAvatarUrlsFor([
        { associationId: ASSO, userId: 'member' },
        { associationId: 'bad', userId: 'member' },
      ]);
      expect(find.mock.calls[0][0].where).toEqual([{ associationId: ASSO, userId: 'member' }]);
    });
  });

  function profileController() {
    const listMemberships = jest.fn(() => Promise.resolve([{ associationId: 'a' }]));
    const listRoleHistory = jest.fn(() => Promise.resolve([{ id: 'r' }]));
    const controller = new AssociationsController(
      {} as never,
      {} as ProductsService,
      {} as PartnershipsService,
      {} as FollowsService,
      {} as UserTagService,
      { listMemberships, listRoleHistory } as unknown as UserProfileService,
      {} as never,
      {} as never
    );
    return { controller, listMemberships, listRoleHistory };
  }

  it.each([
    ['a member reading a review account', 'reviewer', 'member'],
    ['a review account reading a member', 'member', 'reviewer'],
  ])("reads %s's memberships and roles as empty", async (_case, target, viewer) => {
    const { controller, listMemberships, listRoleHistory } = profileController();
    expect(await controller.listUserMemberships(target, viewer)).toEqual([]);
    expect(await controller.listUserRoleHistory(target, viewer)).toEqual([]);
    expect(listMemberships).not.toHaveBeenCalled();
    expect(listRoleHistory).not.toHaveBeenCalled();
  });

  it("reads a member's memberships and roles to another member", async () => {
    const { controller } = profileController();
    expect(await controller.listUserMemberships('member', 'other')).toHaveLength(1);
    expect(await controller.listUserRoleHistory('member', 'other')).toHaveLength(1);
  });
});
