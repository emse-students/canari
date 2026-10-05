import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminOrBdeSuperAdminGuard } from './guards/global-admin-or-bde-super-admin.guard';
import { AssociationsController } from './associations.controller';
import { AssociationsService } from './associations.service';
import { ProductsService } from './products.service';
import { PartnershipsService } from './partnerships.service';
import { FollowsService } from '../follows/follows.service';
import { UserTagService } from '../users/user-tag.service';
import { UserProfileService } from './user-profile.service';

describe('AssociationsController cotisation config gating (D5)', () => {
  function makeController() {
    const service = {
      // The controller asks ONE predicate now; the three tiers it folds in are tested against the
      // real implementation in associations.service.may-act.spec.ts.
      mayAct: jest.fn(() => Promise.resolve(false)),
      update: jest.fn((_id: string, patch: unknown) =>
        Promise.resolve({ id: 'asso1', cotisationEnabled: false, ...(patch as object) })
      ),
    };
    const productsService = {
      provisionCotisationProduct: jest.fn(() => Promise.resolve({ id: 'prod1' })),
    };
    const partnershipsService = {};
    const followsService = {};
    const userTagService = {};
    const userProfileService = {};

    const controller = new AssociationsController(
      service as unknown as AssociationsService,
      productsService as unknown as ProductsService,
      partnershipsService as PartnershipsService,
      followsService as FollowsService,
      userTagService as UserTagService,
      userProfileService as UserProfileService
    );

    return { controller, service, productsService };
  }

  it('rejects a cotisation config change from a member without MANAGE_PRODUCTS', async () => {
    const { controller, service } = makeController();

    await expect(
      controller.update('asso1', 'user1', undefined, {
        cotisationEnabled: true,
        cotisationMode: 'lifetime',
      })
    ).rejects.toThrow(ForbiddenException);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('allows a cotisation config change from a member holding MANAGE_PRODUCTS and provisions the product', async () => {
    const { controller, service, productsService } = makeController();
    service.mayAct.mockResolvedValue(true);

    const result = await controller.update('asso1', 'user1', undefined, {
      cotisationEnabled: true,
      cotisationMode: 'lifetime',
    });

    expect(service.update).toHaveBeenCalled();
    expect(productsService.provisionCotisationProduct).toHaveBeenCalled();
    expect(result.cotisationEnabled).toBe(true);
  });

  it('lets a global admin change cotisation config, through the same predicate', async () => {
    const { controller, service, productsService } = makeController();

    service.mayAct.mockResolvedValue(true);

    await controller.update('asso1', 'user1', 'true', {
      cotisationEnabled: true,
      cotisationMode: 'dated',
    });

    // The admin tier is inside the predicate, so the call still happens - what matters is that the
    // controller hands it the header instead of branching on it first.
    expect(service.mayAct).toHaveBeenCalledWith('user1', 'asso1', expect.any(Number), {
      isGlobalAdmin: true,
    });
    expect(service.update).toHaveBeenCalled();
    expect(productsService.provisionCotisationProduct).toHaveBeenCalled();
  });

  it('does not check MANAGE_PRODUCTS for updates that do not touch cotisation fields', async () => {
    const { controller, service, productsService } = makeController();

    await controller.update('asso1', 'user1', undefined, { name: 'New name' });

    expect(service.mayAct).not.toHaveBeenCalled();
    expect(service.update).toHaveBeenCalled();
    expect(productsService.provisionCotisationProduct).not.toHaveBeenCalled();
  });
});

/**
 * The three association reads all spread the entity, and none of them carries a guard, so the
 * document vault master key was reachable without a session at all.
 */
describe('AssociationsController secret stripping', () => {
  const row = {
    id: 'asso1',
    slug: 'bde',
    name: 'BDE',
    memberCount: 3,
    stripeOnboardingComplete: true,
    documentVaultKey: 'a'.repeat(64),
    notesCiphertext: 'encrypted-notes',
  };

  function makeController() {
    const service = {
      list: jest.fn(() => Promise.resolve([row])),
      findBySlug: jest.fn(() => Promise.resolve(row)),
      findById: jest.fn(() => Promise.resolve(row)),
    };
    return new AssociationsController(
      service as unknown as AssociationsService,
      {} as ProductsService,
      {} as PartnershipsService,
      {} as FollowsService,
      {} as UserTagService,
      {} as UserProfileService
    );
  }

  it.each([
    ['list', async (c: AssociationsController) => (await c.list('u1'))[0]],
    ['findBySlug', (c: AssociationsController) => c.findBySlug('bde')],
    ['findOne', (c: AssociationsController) => c.findOne('asso1')],
  ])('never lets %s answer with the vault key or the private notes', async (_name, read) => {
    const result = await read(makeController());

    expect(result.documentVaultKey).toBeNull();
    expect(result.notesCiphertext).toBeNull();
    // The rest of the row still has to reach the app - the fix is a strip, not an allowlist.
    expect(result).toMatchObject({ id: 'asso1', name: 'BDE', stripeOnboardingComplete: true });
  });
});

/**
 * THE DIRECTORY (D37) IS THE DEFAULT, THE CATALOGUE IS ASKED FOR BY NAME. The listing hands the
 * service a viewer only in the directory scope - that viewer is what narrows the SQL - and passes
 * the map filters through in either scope. A typo in a new parameter is a 400, never a silent
 * widening.
 */
describe('AssociationsController directory scope (D37)', () => {
  function makeController() {
    const service = { list: jest.fn(() => Promise.resolve([])) };
    const controller = new AssociationsController(
      service as unknown as AssociationsService,
      {} as ProductsService,
      {} as PartnershipsService,
      {} as FollowsService,
      {} as UserTagService,
      {} as UserProfileService
    );
    return { controller, service };
  }

  it('lists the caller directory by default', async () => {
    const { controller, service } = makeController();
    await controller.list('u1', 'list');
    expect(service.list).toHaveBeenCalledWith('list', {
      viewerId: 'u1',
      campus: null,
      formation: null,
    });
  });

  it('lists the whole catalogue with scope=all, filters kept', async () => {
    const { controller, service } = makeController();
    await controller.list('u1', undefined, 'all', 'gardanne', 'ISMIN');
    expect(service.list).toHaveBeenCalledWith(undefined, {
      viewerId: undefined,
      campus: 'gardanne',
      formation: 'ISMIN',
    });
  });

  it.each([
    ['scope', ['u1', undefined, 'everything']],
    ['campus', ['u1', undefined, undefined, 'paris']],
    ['formation', ['u1', undefined, undefined, undefined, 'MBA']],
  ] as const)('refuses an unknown %s', async (_name, args) => {
    const { controller, service } = makeController();
    await expect(
      controller.list(...(args as unknown as Parameters<typeof controller.list>))
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.list).not.toHaveBeenCalled();
  });
});

/**
 * Stripping the two secrets was only half the fix. The three reads still answer the whole row -
 * `stripeAccountId`, `createdBy`, the document quota, the cotisation configuration - and nginx
 * lets an anonymous request through `/api/associations` because `AuthController.check()` answers
 * 200 for anonymous. The guard is therefore load-bearing, and it is a decorator: nothing in the
 * type system notices when one goes missing, so the metadata Nest reads is what has to be asserted.
 */
describe('AssociationsController read guards', () => {
  it.each(['list', 'findBySlug', 'findOne'] as const)(
    '%s is behind NginxAuthGuard',
    (handlerName) => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        AssociationsController.prototype[handlerName]
      ) as unknown[] | undefined;

      expect(guards).toContain(NginxAuthGuard);
    }
  );
});

/**
 * DELETING AN ASSOCIATION IS THE ONE CALL HERE THAT DOES NOT COME BACK, AND ITS TIER MOVED.
 *
 * It was `GlobalAdminGuard` - the platform administrator alone - and on 2026-09-10 the user widened
 * it to the same tier that already CREATES an association: a global admin, or a BDE member holding
 * `MANAGE_ASSO`. A guard is a decorator, so nothing in the type system notices one being swapped
 * back or dropped; the metadata Nest actually reads is the only thing that can be asserted.
 *
 * The pair below is the point. Asserting the new guard alone would still pass if someone ADDED
 * `GlobalAdminGuard` beside it, which would silently restore the old behaviour - two guards are an
 * AND.
 */
describe('AssociationsController delete tier', () => {
  function makeController(governs: boolean) {
    const service = {
      remove: jest.fn(() => Promise.resolve({ ok: true })),
      isAssociationSuperAdminOf: jest.fn(() => Promise.resolve(governs)),
    };
    const controller = new AssociationsController(
      service as unknown as AssociationsService,
      {} as ProductsService,
      {} as PartnershipsService,
      {} as FollowsService,
      {} as UserTagService,
      {} as UserProfileService
    );
    return { controller, service };
  }

  it('is a signed-in route whose tier is checked in the handler, never a narrower guard', () => {
    // Indexed rather than dotted, like the read-guard block above: a bare `prototype.remove` is an
    // unbound method reference and the linter is right to say so, even though nothing calls it.
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AssociationsController.prototype['remove']
    ) as unknown[] | undefined;

    expect(guards).toContain(NginxAuthGuard);
    // The unscoped guard would admit a BDE of ANOTHER space (WP6c step 2).
    expect(guards).not.toContain(GlobalAdminOrBdeSuperAdminGuard);
    expect(guards).not.toContain(GlobalAdminGuard);
  });

  it('hands the caller down, because the service line that records the deletion needs a name', async () => {
    const { controller, service } = makeController(true);

    await controller.remove('asso1', 'user-42', undefined);

    expect(service.isAssociationSuperAdminOf).toHaveBeenCalledWith('user-42', 'asso1');
    expect(service.remove).toHaveBeenCalledWith('asso1', 'user-42');
  });

  it('refuses MANAGE_ASSO in the BDE of a space the association does not reach', async () => {
    const { controller, service } = makeController(false);

    await expect(controller.remove('asso1', 'user-42', undefined)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('lets a global admin delete without consulting any BDE', async () => {
    const { controller, service } = makeController(false);

    await controller.remove('asso1', 'admin', 'true');

    expect(service.isAssociationSuperAdminOf).not.toHaveBeenCalled();
    expect(service.remove).toHaveBeenCalledWith('asso1', 'admin');
  });
});

/**
 * THE TWO POSTER ROUTES ASKED NOBODY ANYTHING.
 *
 * `POST` and `DELETE :id/events/:eventId/image` carried `NginxAuthGuard` alone - proof that someone
 * is signed in, and nothing else - while their own doc comments claimed a permission was required
 * and the `PATCH` / `DELETE` beside them each spelled that check out by hand. So any account could
 * put a poster on any association's event, or wipe one. These pin the rule on all four, and that it
 * is ONE rule rather than four copies of it.
 */
describe('AssociationsController calendar event writes', () => {
  function makeController(mayAct: boolean, isBde = false) {
    // On the service's own prototype, so `assertMayWriteEvent` is the REAL rule (it moved into the
    // service so the co-organiser route shares it), run over the two answers mocked below - these
    // cases still pin the rule, not a stub of it.
    const service = Object.assign(Object.create(AssociationsService.prototype) as object, {
      mayAct: jest.fn(() => Promise.resolve(mayAct)),
      mayValidateEvent: jest.fn(() => Promise.resolve(isBde)),
      updateCalendarEvent: jest.fn(() => Promise.resolve({ id: 'ev1' })),
      deleteCalendarEvent: jest.fn(() => Promise.resolve({ ok: true })),
      setEventImageFromUpload: jest.fn(() => Promise.resolve({ id: 'ev1' })),
      clearEventImage: jest.fn(() => Promise.resolve({ id: 'ev1' })),
      logger: { debug: jest.fn() },
    });
    const controller = new AssociationsController(
      service as unknown as AssociationsService,
      {} as ProductsService,
      {} as PartnershipsService,
      {} as FollowsService,
      {} as UserTagService,
      {} as UserProfileService
    );
    return { controller, service };
  }

  const file = { buffer: Buffer.from('x'), mimetype: 'image/png', size: 3 } as never;

  it('refuses a poster upload from a signed-in account with no right on the association', async () => {
    const { controller, service } = makeController(false);
    await expect(
      controller.uploadEventImage('user1', undefined, 'asso1', 'ev1', file, 'Bearer t')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.setEventImageFromUpload).not.toHaveBeenCalled();
  });

  it('refuses a poster deletion from the same account', async () => {
    const { controller, service } = makeController(false);
    await expect(
      controller.deleteEventImage('user1', undefined, 'asso1', 'ev1', 'Bearer t')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.clearEventImage).not.toHaveBeenCalled();
  });

  it('accepts a poster upload from a PROPOSE_EVENT holder, and says it may not cross associations', async () => {
    const { controller, service } = makeController(true);
    await controller.uploadEventImage('user1', undefined, 'asso1', 'ev1', file, 'Bearer t');
    expect(service.setEventImageFromUpload).toHaveBeenCalledWith('asso1', 'ev1', file, 'Bearer t', {
      isGlobalAdmin: false,
      isBde: false,
    });
  });

  it('lets a global admin through without consulting the association at all', async () => {
    const { controller, service } = makeController(false);
    await controller.deleteEventImage('user1', 'true', 'asso1', 'ev1', 'Bearer t');
    expect(service.mayAct).not.toHaveBeenCalled();
    expect(service.clearEventImage).toHaveBeenCalledWith('asso1', 'ev1', 'Bearer t', {
      isGlobalAdmin: true,
      isBde: false,
    });
  });

  it('holds the same rule on the update and delete routes beside them', async () => {
    const { controller, service } = makeController(false);
    await expect(
      controller.updateCalendarEvent('user1', undefined, 'asso1', 'ev1', {} as never)
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.deleteCalendarEvent('user1', undefined, 'asso1', 'ev1')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it('crosses associations for a BDE governing THE EVENT, judged on the event id', async () => {
    const { controller, service } = makeController(false, true);
    await controller.updateCalendarEvent('user1', undefined, 'other-asso', 'ev1', {} as never);
    expect(service.mayValidateEvent).toHaveBeenCalledWith('user1', 'ev1');
    expect(service.updateCalendarEvent).toHaveBeenCalledWith(
      'other-asso',
      'ev1',
      {},
      {
        isGlobalAdmin: false,
        isBde: true,
        callerUserId: 'user1',
      }
    );
  });
});

/**
 * WP6c STEP 2: A VERDICT ON AN EVENT BELONGS TO THE BDE OF THE EVENT ASSOCIATION'S SPACE.
 *
 * The controller asks `mayValidateEvent(user, eventId)` - the event's own association, never the
 * one in the URL - and the SQL behind it is proven against PostgreSQL in `bde.integration.spec.ts`.
 */
describe('AssociationsController event verdicts and deposits (WP6c step 2)', () => {
  function makeController(governsEvent: boolean, governsTarget = governsEvent) {
    const service = {
      mayValidateEvent: jest.fn(() => Promise.resolve(governsEvent)),
      mayValidateEventsOf: jest.fn(() => Promise.resolve(governsTarget)),
      validateCalendarEvent: jest.fn(() => Promise.resolve({ id: 'ev1' })),
      rejectCalendarEvent: jest.fn(() => Promise.resolve({ id: 'ev1' })),
      createCalendarEvent: jest.fn(() => Promise.resolve({ id: 'ev2' })),
    };
    const controller = new AssociationsController(
      service as unknown as AssociationsService,
      {} as ProductsService,
      {} as PartnershipsService,
      {} as FollowsService,
      {} as UserTagService,
      {} as UserProfileService
    );
    return { controller, service };
  }

  it('lets the BDE of the event association space validate and reject', async () => {
    const { controller, service } = makeController(true);
    await controller.validateCalendarEvent('bde1', undefined, 'asso1', 'ev1');
    await controller.rejectCalendarEvent('bde1', undefined, 'asso1', 'ev1', { reason: 'no' });
    expect(service.mayValidateEvent).toHaveBeenCalledWith('bde1', 'ev1');
    expect(service.validateCalendarEvent).toHaveBeenCalledWith('asso1', 'ev1', 'bde1');
    expect(service.rejectCalendarEvent).toHaveBeenCalledWith('asso1', 'ev1', 'bde1', 'no');
  });

  it('refuses the BDE of another space, on both verdicts', async () => {
    const { controller, service } = makeController(false);
    await expect(
      controller.validateCalendarEvent('bde2', undefined, 'asso1', 'ev1')
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.rejectCalendarEvent('bde2', undefined, 'asso1', 'ev1', {})
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.validateCalendarEvent).not.toHaveBeenCalled();
    expect(service.rejectCalendarEvent).not.toHaveBeenCalled();
  });

  it('lets a global admin decide without asking any BDE', async () => {
    const { controller, service } = makeController(false);
    await controller.validateCalendarEvent('admin', 'true', 'asso1', 'ev1');
    expect(service.mayValidateEvent).not.toHaveBeenCalled();
    expect(service.validateCalendarEvent).toHaveBeenCalled();
  });

  it('reads the deposit grant on the TARGET association, not the one routed through', async () => {
    const { controller, service } = makeController(false, true);
    await controller.createCalendarEvent('bde1', undefined, 'bde-asso', {
      targetAssocId: 'club',
    } as never);
    expect(service.mayValidateEventsOf).toHaveBeenCalledWith('bde1', 'club');
    expect(service.createCalendarEvent).toHaveBeenCalledWith(
      'bde-asso',
      { targetAssocId: 'club' },
      'bde1',
      { isGlobalAdmin: false, isBde: true }
    );
  });

  it('refuses a deposit on an association the caller BDE does not govern, instead of filing it on :id', async () => {
    const { controller, service } = makeController(false, false);
    await expect(
      controller.createCalendarEvent('bde2', undefined, 'bde-asso', {
        targetAssocId: 'club',
      } as never)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('files a plain proposal on :id with the grant read on :id', async () => {
    const { controller, service } = makeController(false, false);
    await controller.createCalendarEvent('member', undefined, 'club', {} as never);
    expect(service.mayValidateEventsOf).toHaveBeenCalledWith('member', 'club');
    expect(service.createCalendarEvent).toHaveBeenCalledWith('club', {}, 'member', {
      isGlobalAdmin: false,
      isBde: false,
    });
  });
});

describe('AssociationsController feed.ics eventId', () => {
  const rows = [1, 2].map((n) => ({
    id: `ev${n}`,
    title: `Soiree ${n}`,
    description: null,
    startsAt: '2026-11-05T18:00:00.000Z',
    endsAt: null,
    associationName: 'BDE',
    associationSlug: 'bde',
  }));

  function makeController() {
    const service = { listAggregatedCalendarFeed: jest.fn(() => Promise.resolve(rows)) };
    return new AssociationsController(
      service as unknown as AssociationsService,
      {} as ProductsService,
      {} as PartnershipsService,
      {} as FollowsService,
      {} as UserTagService,
      {} as UserProfileService
    );
  }
  const res = { setHeader: jest.fn() } as never;

  it('keeps only the named event, so a phone can add ONE evening to its calendar', async () => {
    const body = await makeController().aggregatedCalendarFeedIcs(
      undefined,
      undefined,
      undefined,
      'ev2',
      res
    );
    expect(body).toContain('UID:ev2@canari');
    expect(body).not.toContain('UID:ev1@canari');
  });

  it('serves the whole window without an eventId', async () => {
    const body = await makeController().aggregatedCalendarFeedIcs(
      undefined,
      undefined,
      undefined,
      undefined,
      res
    );
    expect(body).toContain('UID:ev1@canari');
    expect(body).toContain('UID:ev2@canari');
  });
});
