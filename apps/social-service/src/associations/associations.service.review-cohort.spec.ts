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
 * memberships and roles read as empty across the boundary - and for a review account read with no
 * session.
 */
describe('association profiles and rosters and the review cohort', () => {
  const saved = process.env.SERVICE_ACCOUNT_USER_ID;
  beforeEach(() => {
    process.env.SERVICE_ACCOUNT_USER_ID = 'reviewer';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
    else process.env.SERVICE_ACCOUNT_USER_ID = saved;
  });

  it('never lists a review account on a public roster', async () => {
    const raw = (userId: string) => ({ m_id: userId, m_userId: userId, m_permissions: 0 });
    const qb: Record<string, jest.Mock> = {};
    for (const step of ['select', 'addSelect', 'leftJoin', 'where', 'orderBy', 'addOrderBy']) {
      qb[step] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn(() => Promise.resolve([raw('member'), raw('reviewer')]));
    const memberRepo = { createQueryBuilder: jest.fn(() => qb) };
    const service = new AssociationsService(
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
    const listed = await service.listMembersPublic('asso1');
    expect(listed.map((m) => m.userId)).toEqual(['member']);
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
      {} as never
    );
    return { controller, listMemberships, listRoleHistory };
  }

  it.each([
    ['a member reading a review account', 'reviewer', 'member'],
    ['a review account reading a member', 'member', 'reviewer'],
    ['nobody signed in reading a review account', 'reviewer', undefined],
  ])("reads %s's memberships and roles as empty", async (_case, target, viewer) => {
    const { controller, listMemberships, listRoleHistory } = profileController();
    expect(await controller.listUserMemberships(target, viewer)).toEqual([]);
    expect(await controller.listUserRoleHistory(target, viewer)).toEqual([]);
    expect(listMemberships).not.toHaveBeenCalled();
    expect(listRoleHistory).not.toHaveBeenCalled();
  });

  it("reads a member's memberships to a member and to nobody signed in", async () => {
    const { controller } = profileController();
    expect(await controller.listUserMemberships('member', 'other')).toHaveLength(1);
    expect(await controller.listUserRoleHistory('member', undefined)).toHaveLength(1);
  });
});
