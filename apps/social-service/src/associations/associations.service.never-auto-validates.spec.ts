import { AssociationsService } from './associations.service';
import {
  AssociationCalendarEventKind,
  AssociationCalendarEventStatus,
} from './entities/association-calendar-event.entity';

/**
 * NO EVENT IS EVER VALIDATED BY THE ACT OF CREATING IT.
 *
 * The user's rule, 2026-09-14: *"Un evenement ne doit jamais etre valide automatiquement, il doit
 * aller en pending, y compris par un admin systeme ou un admin BDE"* - and the words that matter
 * are the last six. A validation used to be a property of WHO TYPED: `createCalendarEvent` wrote
 * `validated` the moment `isGlobalAdmin` or `isBde` was set, so the pending queue only ever held
 * the events of members who happened not to hold the grant, and the one screen that reviews the
 * school's agenda could not see what its own managers had put on it.
 *
 * **THE CALLER SHAPES ARE THE TEST, NOT THE HAPPY PATH.** A rule with no exception is only proven
 * by the cases that used to be exceptions, so every shape `createCalendarEvent` accepts gets a case
 * here: ordinary proposer, BDE admin, global admin, and a BDE admin depositing on ANOTHER
 * association - the one path that additionally used to notify the target as `validated`.
 *
 * **THE THREE COLUMNS MOVE TOGETHER OR NOT AT ALL.** `status`, `validatedAt` and `validatedBy` are
 * one fact in three columns, and a row that is `pending` with a `validatedBy` would read as
 * approved to anything joining on the stamp. Asserting only `status` would have passed against the
 * old code with two of the three left behind.
 *
 * The service's private collaborators are replaced rather than mocked through repositories: what is
 * under test is the row that gets written, and routing it through `findById` and `syncCoOwners`
 * would assert those instead. Same shape as `associations.service.break-is-bde-only.spec.ts`.
 */

type Overrides = Record<string, unknown>;

function makeService() {
  const saved: Overrides[] = [];
  const calendarRepo = {
    create: jest.fn((e: Overrides) => ({ id: 'ev-new', ...e })),
    save: jest.fn(async (e: Overrides) => {
      saved.push({ ...e });
      return e;
    }),
  };

  // POSITIONAL, AND THIRTEEN LONG - keep these comments aligned with the parameter list in
  // `associations.service.ts`, and change them in the same commit that changes it.
  const service = new AssociationsService(
    undefined as never, // assoRepo
    undefined as never, // memberRepo
    calendarRepo as never, // calendarRepo
    undefined as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // productRepo
    undefined as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never // userTagService
  );

  const notifyEventValidatorsOfProposal = jest.fn();
  const notifyAssocAdminsOfEventAction = jest.fn();
  Object.assign(service, {
    findById: jest.fn(async () => ({ id: 'asso-1' })),
    assertFormBelongsToAssociation: jest.fn(async () => undefined),
    detachLinksBeforeCreate: jest.fn(async () => undefined),
    syncCoOwners: jest.fn(async () => []),
    serializeCalendarEvent: jest.fn((e: Overrides) => e),
    notifyEventValidatorsOfProposal,
    notifyAssocAdminsOfEventAction,
  });

  return { service, saved, notifyEventValidatorsOfProposal, notifyAssocAdminsOfEventAction };
}

/** The minimum a create needs. */
const CREATE = { title: 'Gala', startsAt: '2026-10-06T18:00:00.000Z' };

/**
 * The three columns that carry the rule, read as ONE value.
 *
 * They are one fact, so they are asserted as one object rather than one at a time: a row that is
 * `pending` while still carrying a `validatedBy` reads as approved to anything joining on the
 * stamp, and three separate `expect`s let a test pass with two of the three left behind.
 */
const validationOf = (row: Overrides) => ({
  status: row.status,
  validatedAt: row.validatedAt,
  validatedBy: row.validatedBy,
});

/** What every creation must look like, whoever asked for it. */
const PENDING = {
  status: AssociationCalendarEventStatus.Pending,
  validatedAt: null,
  validatedBy: null,
};

describe('createCalendarEvent - nothing is validated at creation', () => {
  it('a member holding PROPOSE_EVENT proposes', async () => {
    const { service, saved } = makeService();

    await service.createCalendarEvent('asso-1', CREATE as never, 'member-1', {});

    expect(validationOf(saved[0])).toEqual(PENDING);
  });

  it('a BDE admin proposes - the grant validates later, never here', async () => {
    const { service, saved } = makeService();

    await service.createCalendarEvent('asso-1', CREATE as never, 'bde-2', { isBde: true });

    expect(validationOf(saved[0])).toEqual(PENDING);
  });

  it('a global admin proposes - there is no system-level exception', async () => {
    const { service, saved } = makeService();

    await service.createCalendarEvent('asso-1', CREATE as never, 'root-1', {
      isGlobalAdmin: true,
    });

    expect(validationOf(saved[0])).toEqual(PENDING);
  });

  it('a BDE admin depositing on ANOTHER association still only proposes', async () => {
    const { service, saved } = makeService();

    await service.createCalendarEvent(
      'bde-asso',
      { ...CREATE, targetAssocId: 'asso-1' } as never,
      'bde-2',
      { isBde: true }
    );

    // The reach the grant buys is still there - the row lands on the target association.
    expect(saved[0].associationId).toBe('asso-1');
    expect(validationOf(saved[0])).toEqual(PENDING);
  });

  it('a BDE break is a proposal too - the kind gate is not a validation gate', async () => {
    const { service, saved } = makeService();

    await service.createCalendarEvent(
      'asso-1',
      { ...CREATE, kind: AssociationCalendarEventKind.Break } as never,
      'bde-2',
      { isBde: true }
    );

    expect(saved[0].kind).toBe(AssociationCalendarEventKind.Break);
    expect(validationOf(saved[0])).toEqual(PENDING);
  });
});

describe('createCalendarEvent - who is told about a creation', () => {
  it('tells the calendar managers on EVERY creation, the validators own included', async () => {
    const { service, notifyEventValidatorsOfProposal } = makeService();

    await service.createCalendarEvent('asso-1', CREATE as never, 'root-1', {
      isGlobalAdmin: true,
    });

    expect(notifyEventValidatorsOfProposal).toHaveBeenCalledWith('asso-1', 'root-1', 'Gala');
  });

  it('does NOT tell the target association its event is validated - nothing is', async () => {
    const { service, notifyAssocAdminsOfEventAction } = makeService();

    await service.createCalendarEvent(
      'bde-asso',
      { ...CREATE, targetAssocId: 'asso-1' } as never,
      'bde-2',
      { isBde: true }
    );

    // It hears from `validateCalendarEvent` or `rejectCalendarEvent`, once, when there is
    // something to hear. A creation-time `event_validated` would name a publication that has
    // not happened.
    expect(notifyAssocAdminsOfEventAction).not.toHaveBeenCalled();
  });
});
