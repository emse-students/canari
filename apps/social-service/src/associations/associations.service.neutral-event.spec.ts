import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AssociationsController } from './associations.controller';
import { AssociationsService } from './associations.service';
import {
  AssociationCalendarEventKind,
  AssociationCalendarEventPresentation,
  AssociationCalendarEventStatus,
} from './entities/association-calendar-event.entity';
import { AssociationPermissionFlag } from './entities/association-member.entity';
import { CALENDAR_NEUTRAL_ERROR_CODES } from './event-presentation';
import { CALENDAR_PARTNER_ORGANISER_ONLY } from './event-write-side';
import {
  GlobalAdminOrAssociationRoleGuard,
  PERM_FLAG_KEY,
} from './guards/global-admin-or-association-role.guard';

/**
 * NEUTRAL CAMPUS EVENTS THROUGH THE SERVICE (owner, 2026-11-08): who may file one, what a reader
 * receives, and that the BDE's agenda managers keep editing and deleting it. The masking rules
 * themselves are pinned in `event-presentation.spec.ts`.
 */

type Overrides = Record<string, unknown>;

const BDE = '00000000-0000-4000-8000-0000000000b1';
const CLUB = '00000000-0000-4000-8000-0000000000c1';
const NEUTRAL = AssociationCalendarEventPresentation.Neutral;

/** POSITIONAL, AND FOURTEEN LONG - aligned with the constructor in `associations.service.ts`. */
function construct(repos: { assoRepo?: unknown; memberRepo?: unknown; calendarRepo?: unknown }) {
  return new AssociationsService(
    repos.assoRepo as never, // assoRepo
    repos.memberRepo as never, // memberRepo
    repos.calendarRepo as never, // calendarRepo
    { find: jest.fn(async () => []) } as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // productRepo
    undefined as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never, // userTagService
    { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
  );
}

describe('creating a neutral event', () => {
  function makeService(ownerIsBde: boolean) {
    const saved: Overrides[] = [];
    const calendarRepo = {
      create: jest.fn((e: Overrides) => ({ id: 'ev-new', ...e })),
      save: jest.fn(async (e: Overrides) => {
        saved.push({ ...e });
        return e;
      }),
    };
    const manager = { query: jest.fn(async () => []), getRepository: () => calendarRepo };
    Object.assign(calendarRepo, {
      manager: { transaction: async (work: (m: unknown) => unknown) => work(manager) },
    });
    const service = construct({ calendarRepo });
    Object.assign(service, {
      findById: jest.fn(async (id: string) => ({ id, isBDE: ownerIsBde })),
      detachLinksBeforeCreate: jest.fn(async () => undefined),
      serializeCalendarEvent: jest.fn((e: Overrides) => e),
      notifyEventValidatorsOfProposal: jest.fn().mockResolvedValue([]),
    });
    return { service, saved };
  }

  const CREATE = { title: 'Soiree', startsAt: '2026-11-20T19:00:00.000Z', presentation: NEUTRAL };

  it('is open only to who already files the association events: the route asks PROPOSE_EVENT', () => {
    // A reader outside the BDE's agenda managers never reaches the service: the role guard reads
    // this flag on `:id` (the deposit tier is read by the handler, in `associations.controller.spec.ts`).
    const handler = AssociationsController.prototype['createCalendarEvent'];
    expect(Reflect.getMetadata(PERM_FLAG_KEY, handler)).toBe(
      AssociationPermissionFlag.PROPOSE_EVENT
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      GlobalAdminOrAssociationRoleGuard
    );
  });

  it('is refused to a proposer of an association that is not a BDE, and nothing is written', async () => {
    const { service, saved } = makeService(false);
    const attempt = service.createCalendarEvent(CLUB, CREATE as never, 'club-member', {});
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.createCalendarEvent(CLUB, CREATE as never, 'club-member', {})
    ).rejects.toMatchObject({ response: { code: CALENDAR_NEUTRAL_ERROR_CODES.NOT_A_BDE } });
    expect(saved).toHaveLength(0);
  });

  it('is refused with co-organisers, before anything is written', async () => {
    const { service, saved } = makeService(true);
    await expect(
      service.createCalendarEvent(BDE, { ...CREATE, coOwnerIds: [CLUB] } as never, 'sec', {})
    ).rejects.toMatchObject({ response: { code: CALENDAR_NEUTRAL_ERROR_CODES.NO_PARTNERS } });
    expect(saved).toHaveLength(0);
  });

  it('is filed by a BDE proposer, pending like every event, with the BDE as its owner', async () => {
    const { service, saved } = makeService(true);
    await service.createCalendarEvent(BDE, CREATE as never, 'bde-secretary', {});
    expect(saved[0]).toMatchObject({
      associationId: BDE,
      presentation: NEUTRAL,
      createdBy: 'bde-secretary',
      status: AssociationCalendarEventStatus.Pending,
    });
  });

  it('defaults to the association presentation when the field is not sent', async () => {
    const { service, saved } = makeService(false);
    await service.createCalendarEvent(
      CLUB,
      { title: 'Perm', startsAt: '2026-11-20T19:00:00.000Z' } as never,
      'club-member',
      {}
    );
    expect(saved[0].presentation).toBe(AssociationCalendarEventPresentation.Association);
  });
});

describe('reading a neutral event', () => {
  function neutralRow(): Overrides {
    return {
      id: 'ev-neutral',
      associationId: BDE,
      title: 'Soiree',
      description: null,
      startsAt: new Date('2026-11-20T19:00:00Z'),
      endsAt: null,
      createdBy: 'bde-secretary',
      createdAt: new Date('2026-11-08T10:00:00Z'),
      kind: AssociationCalendarEventKind.Event,
      presentation: NEUTRAL,
      status: AssociationCalendarEventStatus.Validated,
      validatedAt: new Date('2026-11-09T10:00:00Z'),
      validatedBy: 'bde-validator',
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      linkedFormId: null,
      imageUrl: null,
      imageMediaId: null,
    };
  }

  /**
   * `proposing` / `validating`: the associations the reader holds PROPOSE_EVENT in and validates
   * events for; `governing`, those a BDE where they hold MANAGE_ASSO governs (the super-admin tier
   * of `mayAct`); `memberOf`, associations where they hold some OTHER flag (the pending queue's door).
   */
  function makeService(
    rows: Overrides[],
    proposing: string[],
    validating: string[],
    governing: string[] = [],
    memberOf: string[] = []
  ) {
    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
      'select',
      'addSelect',
      'setParameters',
    ]) {
      qb[method] = jest.fn(() => qb);
    }
    qb.getMany = jest.fn(async () => rows);
    // The aggregated feed reads raw columns, owner identity included.
    qb.getRawMany = jest.fn(async () =>
      rows.map((r) => ({
        ...r,
        associationName: 'BDE',
        associationSlug: 'bde',
        associationColor: '#123456',
        associationLogoUrl: '/api/media/public/bde-logo',
      }))
    );
    const memberRepo = {
      count: jest.fn(async () => 0),
      // The member bitmask: `mayActOnAny`'s last tier, and the pending queue's memberships.
      find: jest.fn(async () => [
        ...proposing.map((associationId) => ({
          associationId,
          permissions: AssociationPermissionFlag.PROPOSE_EVENT,
        })),
        ...memberOf.map((associationId) => ({
          associationId,
          permissions: AssociationPermissionFlag.MANAGE_MEMBERS,
        })),
      ]),
      // `associationsUnderBdeFlag` (user + flag) and `associationsUnderBdeAgendaRight` (user).
      query: jest.fn(async (_sql: string, params: unknown[]) =>
        (params.length === 2 ? governing : validating).map((id) => ({ id }))
      ),
    };
    const assoRepo = {
      findOne: jest.fn(async () => ({ id: BDE, parentAssociationId: null })),
      find: jest.fn(async () => [
        {
          id: BDE,
          name: 'BDE',
          slug: 'bde',
          color: '#123456',
          logoUrl: '/api/media/public/bde-logo',
        },
      ]),
    };
    const calendarRepo = {
      createQueryBuilder: jest.fn(() => qb),
      manager: { query: jest.fn(async () => []) },
    };
    return construct({ assoRepo, memberRepo, calendarRepo });
  }

  const STUDENT = { viewer: { userId: 'student' } };

  it('names no association in the whole agenda a member reads', async () => {
    const service = makeService([neutralRow()], [], []);
    const rows = await service.listAggregatedCalendarFeed(undefined, undefined, undefined, STUDENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      presentation: NEUTRAL,
      associationId: '',
      associationName: '',
      associationSlug: '',
      associationColor: null,
      associationLogoUrl: null,
      createdBy: '',
      validatedBy: null,
    });
    expect(JSON.stringify(rows)).not.toContain(BDE);
    expect(JSON.stringify(rows)).not.toMatch(/bde/i);
  });

  it('names none to the anonymous `.ics` read either', async () => {
    const service = makeService([neutralRow()], [], []);
    const rows = await service.listAggregatedCalendarFeed(undefined, undefined, undefined, {});
    expect(rows[0].associationId).toBe('');
    expect(JSON.stringify(rows)).not.toMatch(/bde/i);
  });

  it('is not on the BDE own agenda for a member, where the list would name its owner', async () => {
    const service = makeService([neutralRow()], [], []);
    expect(await service.listCalendarEvents(BDE, undefined, undefined, STUDENT)).toEqual([]);
    expect(await service.listAggregatedCalendarFeed(undefined, undefined, BDE, STUDENT)).toEqual(
      []
    );
  });

  it('stays whole for the BDE agenda managers: who files its events and who validates them', async () => {
    for (const [proposing, validating] of [
      [[BDE], []],
      [[], [BDE]],
    ]) {
      const service = makeService([neutralRow()], proposing, validating);
      const [ev] = await service.listCalendarEvents(BDE, undefined, undefined, {
        viewer: { userId: 'manager' },
      });
      expect(ev).toMatchObject({
        associationId: BDE,
        associationName: 'BDE',
        createdBy: 'bde-secretary',
        presentation: NEUTRAL,
      });
    }
  });

  it('stays whole for a MANAGE_ASSO-only member of the BDE - the same tiers as who may write it', async () => {
    // Holds neither PROPOSE_EVENT nor the agenda right, only MANAGE_ASSO in the BDE: `mayAct` lets
    // them file and edit the BDE's events, so they are shown what they may edit.
    const service = makeService([neutralRow()], [], [], [BDE]);
    const [ev] = await service.listCalendarEvents(BDE, undefined, undefined, {
      viewer: { userId: 'bde-president' },
    });
    expect(ev).toMatchObject({ associationId: BDE, associationName: 'BDE', presentation: NEUTRAL });
  });

  it('is masked in the pending queue for a BDE member who is no steward', async () => {
    const pending = { ...neutralRow(), status: AssociationCalendarEventStatus.Pending };
    const service = makeService([pending], [], [], [], [BDE]);
    const rows = await service.listPendingCalendarEvents('bde-treasurer', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      presentation: NEUTRAL,
      associationId: '',
      associationName: '',
      createdBy: '',
    });
    expect(JSON.stringify(rows)).not.toMatch(/bde/i);
  });

  it('is whole in the pending queue for its validator', async () => {
    const pending = { ...neutralRow(), status: AssociationCalendarEventStatus.Pending };
    const service = makeService([pending], [], [BDE]);
    const [row] = await service.listPendingCalendarEvents('bde-validator', {});
    expect(row).toMatchObject({ associationId: BDE, createdBy: 'bde-secretary' });
  });
});

describe('a MANAGE_ASSO-only member of the BDE may write the neutral event they are shown', () => {
  it('passes `assertMayWriteEvent` through the super-admin tier', async () => {
    const service = construct({
      calendarRepo: { findOne: jest.fn(async () => ({ id: 'ev-1', associationId: BDE })) },
    });
    Object.assign(service, {
      mayValidateEvent: jest.fn(async () => false),
      holdsBdeFlagOver: jest.fn(
        async (_u: string, _a: string, flag: number) =>
          flag === AssociationPermissionFlag.MANAGE_ASSO
      ),
      callerHasFlag: jest.fn(async () => false),
    });
    await expect(service.assertMayWriteEvent('bde-president', false, BDE, 'ev-1')).resolves.toEqual(
      { isGlobalAdmin: false, isBde: false, side: 'organiser' }
    );
  });
});

describe('a post and a neutral event', () => {
  const NEUTRAL_EV = {
    id: 'ev-1',
    associationId: BDE,
    status: AssociationCalendarEventStatus.Validated,
    presentation: NEUTRAL,
  };

  it('the composer is refused the link, typed, reading the event FOR SHARE in the post write', async () => {
    const txRepo = { findOne: jest.fn(async () => NEUTRAL_EV) };
    const manager = { getRepository: jest.fn(() => txRepo) };
    const service = construct({ calendarRepo: { findOne: jest.fn() } });
    await expect(
      service.resolvePostCalendarEventLink(BDE, 'ev-1', manager as never)
    ).rejects.toMatchObject({ response: { code: CALENDAR_NEUTRAL_ERROR_CODES.LINKED_POST } });
    // The lock that conflicts with the presentation switch's `FOR NO KEY UPDATE`.
    expect(txRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_read' } })
    );
  });

  it('the two forward post readers read an association-presented event only', async () => {
    const wheres: [string, Record<string, unknown> | undefined][] = [];
    const qb = {
      where: jest.fn((sql: string, params?: Record<string, unknown>) => {
        wheres.push([sql, params]);
        return qb;
      }),
      andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
        wheres.push([sql, params]);
        return qb;
      }),
      getOne: jest.fn(async () => null),
    };
    const calendarRepo = { createQueryBuilder: jest.fn(() => qb) };
    const postRepo = {
      findOne: jest.fn(async () => ({ id: 'p1', linkedCalendarEventId: 'ev-1' })),
    };
    const service = construct({ calendarRepo });
    Object.assign(service, { postRepo });
    await expect(service.findCalendarEventByLinkedPost('p1', 'reader-1')).resolves.toBeNull();
    await expect(service.findValidatedCalendarEventSummary('ev-1', 'reader-1')).resolves.toBeNull();
    expect(calendarRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    const presented = wheres.filter(([sql]) => sql.includes('e.presentation'));
    expect(presented).toHaveLength(2);
    for (const [, params] of presented) {
      expect(params?.presented).toBe(AssociationCalendarEventPresentation.Association);
    }
    // Each read also asks the event's own predicate of the reader (an institution's reach).
    const gated = wheres.filter(([sql]) => sql.includes('"reachPublic" IS NULL'));
    expect(gated.map(([, params]) => params?.cardViewerId)).toEqual(['reader-1', 'reader-1']);
  });
});

describe('managing a neutral event', () => {
  function makeService(event: Overrides) {
    const saved: Overrides[] = [];
    const row: Overrides = {
      id: 'ev-1',
      associationId: BDE,
      title: 'Soiree',
      description: null,
      startsAt: new Date('2026-11-20T19:00:00.000Z'),
      endsAt: null,
      createdBy: 'bde-secretary',
      kind: AssociationCalendarEventKind.Event,
      presentation: NEUTRAL,
      status: AssociationCalendarEventStatus.Validated,
      validatedAt: new Date('2026-11-09T09:00:00.000Z'),
      validatedBy: 'bde-validator',
      linkedFormId: null,
      ...event,
    };
    const calendarRepo = {
      save: jest.fn(async (e: Overrides) => {
        saved.push({ ...e });
        return e;
      }),
      findOne: jest.fn(async () => row),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    // The facts the presentation check reads: the owner is a BDE, nobody co-organises, no post.
    const manager = {
      query: jest.fn(async () => [{ ownerIsBde: true, partnerCount: 0, linkedByPost: false }]),
    };
    const service = construct({ calendarRepo });
    Object.assign(service, {
      findById: jest.fn(async (id: string) => ({ id, isBDE: true })),
      withEventLock: async (_id: string, work: (repo: unknown, m: unknown) => unknown) =>
        work(calendarRepo, manager),
      findCalendarEventForAssociation: jest.fn(async () => row),
      batchLoadCoOwners: jest.fn(async () => new Map()),
      serializeCalendarEvent: jest.fn((e: Overrides) => e),
    });
    return { service, saved, calendarRepo, manager };
  }

  it('lets a BDE agenda manager edit it, and it stays neutral', async () => {
    const { service, saved } = makeService({});
    await service.updateCalendarEvent(BDE, 'ev-1', { title: 'Soiree d hiver' } as never, {
      callerUserId: 'bde-secretary',
    });
    expect(saved[0]).toMatchObject({ title: 'Soiree d hiver', presentation: NEUTRAL });
  });

  it('lets a manager turn it back into a BDE event, and checks nothing for that', async () => {
    const { service, saved, manager } = makeService({});
    await service.updateCalendarEvent(
      BDE,
      'ev-1',
      { presentation: AssociationCalendarEventPresentation.Association } as never,
      { callerUserId: 'bde-secretary' }
    );
    expect(saved[0].presentation).toBe(AssociationCalendarEventPresentation.Association);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('refuses to make it neutral while a post links it', async () => {
    const { service, saved, manager } = makeService({
      presentation: AssociationCalendarEventPresentation.Association,
    });
    manager.query.mockResolvedValueOnce([
      { ownerIsBde: true, partnerCount: 0, linkedByPost: true },
    ]);
    await expect(
      service.updateCalendarEvent(BDE, 'ev-1', { presentation: NEUTRAL } as never, {
        callerUserId: 'bde-secretary',
      })
    ).rejects.toMatchObject({ response: { code: CALENDAR_NEUTRAL_ERROR_CODES.LINKED_POST } });
    expect(saved).toHaveLength(0);
  });

  it('refuses a partner changing how it is presented - the organiser side only', async () => {
    const { service, saved } = makeService({});
    await expect(
      service.updateCalendarEvent(
        CLUB,
        'ev-1',
        { presentation: AssociationCalendarEventPresentation.Association } as never,
        { callerUserId: 'club-member' }
      )
    ).rejects.toMatchObject({ response: { code: CALENDAR_PARTNER_ORGANISER_ONLY } });
    expect(saved).toHaveLength(0);
  });

  it('refuses turning the event of an association that is not a BDE neutral', async () => {
    const { service, saved, manager } = makeService({
      presentation: AssociationCalendarEventPresentation.Association,
    });
    manager.query.mockResolvedValueOnce([
      { ownerIsBde: false, partnerCount: 0, linkedByPost: false },
    ]);
    await expect(
      service.updateCalendarEvent(BDE, 'ev-1', { presentation: NEUTRAL } as never, {
        callerUserId: 'bde-secretary',
      })
    ).rejects.toMatchObject({ response: { code: CALENDAR_NEUTRAL_ERROR_CODES.NOT_A_BDE } });
    expect(saved).toHaveLength(0);
  });

  it('keeps an already neutral event editable once its owner is no longer a BDE', async () => {
    const { service, saved, manager } = makeService({});
    manager.query.mockResolvedValueOnce([
      { ownerIsBde: false, partnerCount: 0, linkedByPost: false },
    ]);
    await service.updateCalendarEvent(BDE, 'ev-1', { title: 'Soiree d ete' } as never, {
      callerUserId: 'bde-secretary',
    });
    expect(saved[0]).toMatchObject({ title: 'Soiree d ete', presentation: NEUTRAL });
  });

  it('refuses linking a form to it', async () => {
    const { service, saved } = makeService({});
    await expect(
      service.updateCalendarEvent(
        BDE,
        'ev-1',
        { linkedFormId: '00000000-0000-4000-8000-0000000000f1' } as never,
        { callerUserId: 'bde-secretary' }
      )
    ).rejects.toMatchObject({ response: { code: CALENDAR_NEUTRAL_ERROR_CODES.NO_FORM } });
    expect(saved).toHaveLength(0);
  });

  it('lets a BDE agenda manager delete it', async () => {
    const { service, calendarRepo } = makeService({});
    Object.assign(service, {
      findCalendarEventForAssociation: jest.fn(async () => ({ id: 'ev-1', associationId: BDE })),
    });
    await expect(
      service.deleteCalendarEvent(BDE, 'ev-1', { callerUserId: 'bde-secretary' })
    ).resolves.toEqual({ ok: true });
    expect(calendarRepo.delete).toHaveBeenCalledWith({ id: 'ev-1' });
  });
});
