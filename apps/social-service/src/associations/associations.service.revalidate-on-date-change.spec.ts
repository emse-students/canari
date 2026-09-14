import { AssociationsService } from './associations.service';
import {
  AssociationCalendarEventKind,
  AssociationCalendarEventStatus,
} from './entities/association-calendar-event.entity';

/**
 * A VALIDATED EVENT WHOSE DATES MOVE GOES BACK INTO THE QUEUE.
 *
 * `updateCalendarEvent` wrote seven columns and never `status`, so an association admin could have
 * an event approved for a Tuesday, move it to the Saturday of the gala, and keep it on the public
 * agenda with nobody told. The BDE validated a DATE; changing the date spends a validation that was
 * never given for it.
 *
 * Three things decide the behaviour and each has a case here.
 *
 * **The trigger is a date that MOVED, not a field that was SENT.** Both modals submit every field
 * they render, so keying off `dto.startsAt !== undefined` would demote an event whose author fixed
 * a typo in the title - which would put every correction in front of the BDE and teach it to
 * approve without reading.
 *
 * **Only the dates do it.** A title, a description or a linked form change nothing the BDE reasoned
 * about when it said yes.
 *
 * **AND THERE IS NO EXCEPTION FOR THE AUTHORITY ITSELF.** A BDE or global-admin caller used to
 * re-validate in place, on the argument that they are the authority the demotion would route to.
 * That argument re-opened by a second door what `createCalendarEvent` closes at the front: propose,
 * validate, then move the date, and the event keeps a stamp nobody read the new shape to earn.
 * Since 2026-09-14 no path validates an event without somebody deciding it (user: *"Un evenement
 * ne doit jamais etre valide automatiquement ... y compris par un admin systeme ou un admin BDE"*),
 * so every validated event whose dates move is demoted and re-enters the queue, whoever moved them.
 *
 * The service's private collaborators are replaced rather than mocked through repositories: what is
 * under test is the status decision, and routing it through `findById`, `syncCoOwners` and
 * `serializeCalendarEvent` would assert those instead.
 */

type Overrides = Record<string, unknown>;

function makeService(event: Overrides) {
  const saved: Overrides[] = [];
  const calendarRepo = {
    save: jest.fn(async (e: Overrides) => {
      // A snapshot, because the service keeps mutating the same entity object afterwards.
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

  const row: Overrides = {
    id: 'ev-1',
    associationId: 'asso-1',
    title: 'Gala',
    description: null,
    startsAt: new Date('2026-10-06T18:00:00.000Z'),
    endsAt: new Date('2026-10-06T23:00:00.000Z'),
    createdBy: 'author-1',
    kind: AssociationCalendarEventKind.Event,
    status: AssociationCalendarEventStatus.Validated,
    validatedAt: new Date('2026-09-01T09:00:00.000Z'),
    validatedBy: 'bde-1',
    linkedFormId: null,
    ...event,
  };

  const notifiedValidators = jest.fn();
  const notifiedAssoAdmins = jest.fn();
  Object.assign(service, {
    findById: jest.fn(async () => ({ id: 'asso-1' })),
    findCalendarEventForAssociation: jest.fn(async () => row),
    batchLoadCoOwners: jest.fn(async () => new Map()),
    syncCoOwners: jest.fn(async () => []),
    serializeCalendarEvent: jest.fn((e: Overrides) => e),
    notifyEventValidatorsOfProposal: notifiedValidators,
    notifyAssocAdminsOfEventAction: notifiedAssoAdmins,
  });

  return { service, row, saved, notifiedValidators, notifiedAssoAdmins };
}

/** The one write this method makes, as the entity looked when it was handed over. */
const written = (saved: Overrides[]) => saved[0];

describe('updateCalendarEvent - a validated event asks again when its dates move', () => {
  it('returns the event to pending and clears the validation stamp', async () => {
    const { service, saved } = makeService({});

    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { startsAt: '2026-10-02T18:00:00.000Z' } as never,
      { callerUserId: 'admin-1' }
    );

    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Pending);
    expect(written(saved).validatedAt).toBeNull();
    expect(written(saved).validatedBy).toBeNull();
  });

  it('tells the validators, by the same route a fresh proposal takes', async () => {
    const { service, notifiedValidators, notifiedAssoAdmins } = makeService({});

    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { startsAt: '2026-10-02T18:00:00.000Z' } as never,
      { callerUserId: 'admin-1' }
    );

    // Without this the event leaves the public agenda for a queue nobody is told about - worse
    // than the defect it replaces, the event having at least been visible before.
    expect(notifiedValidators).toHaveBeenCalledWith('asso-1', 'admin-1', 'Gala');
    expect(notifiedAssoAdmins).toHaveBeenCalledWith('asso-1', 'admin-1', 'Gala', 'pending');
  });

  it('demotes on a change to endsAt alone - an event that now runs to 3am is a different ask', async () => {
    const { service, saved } = makeService({});

    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { endsAt: '2026-10-07T03:00:00.000Z' } as never,
      { callerUserId: 'admin-1' }
    );

    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Pending);
  });

  it('demotes when endsAt is CLEARED, which is a change like any other', async () => {
    const { service, saved } = makeService({});

    await service.updateCalendarEvent('asso-1', 'ev-1', { endsAt: '' } as never, {
      callerUserId: 'admin-1',
    });

    expect(written(saved).endsAt).toBeNull();
    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Pending);
  });

  it('leaves a validated event alone when the dates are RESENT unchanged', async () => {
    const { service, saved, notifiedValidators } = makeService({});

    // The whole point of comparing values rather than reading `dto.startsAt !== undefined`: both
    // modals submit every field they render, so an unchanged date arrives on every save.
    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      {
        title: 'Gala d automne',
        startsAt: '2026-10-06T18:00:00.000Z',
        endsAt: '2026-10-06T23:00:00.000Z',
      } as never,
      { callerUserId: 'admin-1' }
    );

    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Validated);
    expect(written(saved).title).toBe('Gala d automne');
    expect(notifiedValidators).not.toHaveBeenCalled();
  });

  it('leaves a validated event alone when only the title changes', async () => {
    const { service, saved } = makeService({});

    await service.updateCalendarEvent('asso-1', 'ev-1', { title: 'Gala 2026' } as never, {
      callerUserId: 'admin-1',
    });

    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Validated);
    expect(written(saved).validatedBy).toBe('bde-1');
  });

  it('demotes for a BDE caller too - the authority validates by deciding, never by typing', async () => {
    const { service, saved, notifiedValidators } = makeService({});

    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { startsAt: '2026-10-02T18:00:00.000Z' } as never,
      { isBde: true, callerUserId: 'bde-2' }
    );

    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Pending);
    // The stamp goes with the status: a pending row carrying a `validatedBy` reads as approved to
    // anything joining on it.
    expect(written(saved).validatedAt).toBeNull();
    expect(written(saved).validatedBy).toBeNull();
    // They are told like any other validator - `createNotifications` drops the actor, so the one
    // who moved the dates is not pushed their own request.
    expect(notifiedValidators).toHaveBeenCalled();
  });

  it('demotes for a global admin too - there is no system-level exception either', async () => {
    const { service, saved, notifiedValidators } = makeService({});

    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { startsAt: '2026-10-02T18:00:00.000Z' } as never,
      { isGlobalAdmin: true, callerUserId: 'root-1' }
    );

    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Pending);
    expect(written(saved).validatedAt).toBeNull();
    expect(written(saved).validatedBy).toBeNull();
    expect(notifiedValidators).toHaveBeenCalled();
  });

  it('does not touch a PENDING event, which has no validation to spend', async () => {
    const { service, saved, notifiedValidators } = makeService({
      status: AssociationCalendarEventStatus.Pending,
      validatedAt: null,
      validatedBy: null,
    });

    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { startsAt: '2026-10-02T18:00:00.000Z' } as never,
      { callerUserId: 'admin-1' }
    );

    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Pending);
    // It is already in the queue; a second proposal notice for the same event is noise.
    expect(notifiedValidators).not.toHaveBeenCalled();
  });

  it('does not resurrect a REJECTED event by moving its dates', async () => {
    const { service, saved } = makeService({
      status: AssociationCalendarEventStatus.Rejected,
      validatedAt: null,
      validatedBy: null,
    });

    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { startsAt: '2026-10-02T18:00:00.000Z' } as never,
      { callerUserId: 'admin-1' }
    );

    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Rejected);
  });

  it('compares instants, not object identity, when the column comes back as a string', async () => {
    // A `timestamptz` reaches this method as a `Date` through the driver and as a string through
    // some raw paths. Comparing the two forms with `!==` is true for the same moment, which would
    // demote an event nobody rescheduled.
    const { service, saved } = makeService({
      startsAt: '2026-10-06T18:00:00.000Z' as never,
      endsAt: '2026-10-06T23:00:00.000Z' as never,
    });

    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { startsAt: '2026-10-06T18:00:00.000Z' } as never,
      { callerUserId: 'admin-1' }
    );

    expect(written(saved).status).toBe(AssociationCalendarEventStatus.Validated);
  });
});
