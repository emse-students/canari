import { ForbiddenException } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import {
  AssociationCalendarEventKind,
  AssociationCalendarEventStatus,
} from './entities/association-calendar-event.entity';

/**
 * A SCHOOL-WIDE BREAK IS DECLARED BY THE AUTHORITY THAT SPEAKS FOR THE SCHOOL.
 *
 * `kind` was a free field. Any member holding `PROPOSE_EVENT` could send `kind: 'break'` and publish
 * a full-day background band across the whole school's calendar, and both write paths accepted it
 * with no check at all. A band is a statement about the SCHOOL - "there are no courses this week" -
 * so proposing one has no meaning, and validating one is the wrong question to put to a BDE.
 *
 * Two things decide the behaviour and each has cases here.
 *
 * **The gate is on the VALUE CHANGING, not on the field being SENT.** The event modal submits every
 * field it renders, so an ordinary edit resends the entry's existing `kind` on every save. Refusing
 * a field that was merely present would refuse every edit a non-BDE makes - which is the same trap
 * the date revalidation avoids, one method away.
 *
 * **It guards BOTH directions.** Turning a BDE's holiday band back into an association card
 * rewrites the same school-wide statement. One rule with no hole beats two rules with one.
 *
 * The service's private collaborators are replaced rather than mocked through repositories: what is
 * under test is the refusal, and routing it through `findById` and `syncCoOwners` would assert
 * those instead.
 */

type Overrides = Record<string, unknown>;

function makeService(event?: Overrides) {
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

  Object.assign(service, {
    findById: jest.fn(async () => ({ id: 'asso-1' })),
    findCalendarEventForAssociation: jest.fn(async () => row),
    assertFormBelongsToAssociation: jest.fn(async () => undefined),
    detachLinksBeforeCreate: jest.fn(async () => undefined),
    batchLoadCoOwners: jest.fn(async () => new Map()),
    syncCoOwners: jest.fn(async () => []),
    serializeCalendarEvent: jest.fn((e: Overrides) => e),
    notifyEventValidatorsOfProposal: jest.fn(),
    notifyAssocAdminsOfEventAction: jest.fn(),
  });

  return { service, row, saved, calendarRepo };
}

/** The minimum a create needs; `kind` is what each case varies. */
const CREATE = { title: 'Vacances de la Toussaint', startsAt: '2026-10-24T00:00:00.000Z' };

describe('createCalendarEvent - only a validator may declare a break', () => {
  it('refuses `break` from a caller who may not validate', async () => {
    const { service, saved } = makeService();

    await expect(
      service.createCalendarEvent(
        'asso-1',
        { ...CREATE, kind: AssociationCalendarEventKind.Break } as never,
        'member-1',
        {}
      )
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The refusal is BEFORE the write, so nothing reached the table.
    expect(saved).toHaveLength(0);
  });

  it('lets a BDE caller declare one', async () => {
    const { service, saved } = makeService();

    await service.createCalendarEvent(
      'asso-1',
      { ...CREATE, kind: AssociationCalendarEventKind.Break } as never,
      'bde-2',
      { isBde: true }
    );

    expect(saved[0].kind).toBe(AssociationCalendarEventKind.Break);
  });

  it('lets a global admin declare one', async () => {
    const { service, saved } = makeService();

    await service.createCalendarEvent(
      'asso-1',
      { ...CREATE, kind: AssociationCalendarEventKind.Break } as never,
      'root-1',
      { isGlobalAdmin: true }
    );

    expect(saved[0].kind).toBe(AssociationCalendarEventKind.Break);
  });

  it('leaves an ordinary proposal alone - `event` is what every member may ask for', async () => {
    const { service, saved } = makeService();

    await service.createCalendarEvent(
      'asso-1',
      { ...CREATE, kind: AssociationCalendarEventKind.Event } as never,
      'member-1',
      {}
    );

    expect(saved[0].kind).toBe(AssociationCalendarEventKind.Event);
  });

  it('treats an omitted `kind` as `event` rather than as an unchecked value', async () => {
    const { service, saved } = makeService();

    await service.createCalendarEvent('asso-1', CREATE as never, 'member-1', {});

    expect(saved[0].kind).toBe(AssociationCalendarEventKind.Event);
  });
});

describe('updateCalendarEvent - the gate is on the value changing, not the field being sent', () => {
  it('accepts an ordinary edit that RESENDS the kind unchanged', async () => {
    const { service, saved } = makeService();

    // The whole point: the modal submits every field it renders, so `kind` arrives on every save.
    await service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { title: 'Gala d automne', kind: AssociationCalendarEventKind.Event } as never,
      { callerUserId: 'member-1' }
    );

    expect(saved[0].title).toBe('Gala d automne');
    expect(saved[0].kind).toBe(AssociationCalendarEventKind.Event);
  });

  it('refuses a non-validator turning an event into a school-wide band', async () => {
    const { service, saved } = makeService();

    await expect(
      service.updateCalendarEvent(
        'asso-1',
        'ev-1',
        { kind: AssociationCalendarEventKind.Break } as never,
        { callerUserId: 'member-1' }
      )
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(saved).toHaveLength(0);
  });

  it('refuses a non-validator turning a BDE band back into an association card', async () => {
    const { service, saved } = makeService({ kind: AssociationCalendarEventKind.Break });

    await expect(
      service.updateCalendarEvent(
        'asso-1',
        'ev-1',
        { kind: AssociationCalendarEventKind.Event } as never,
        { callerUserId: 'member-1' }
      )
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(saved).toHaveLength(0);
  });

  it('leaves the entity as it was found when it refuses', async () => {
    const { service, row } = makeService();

    await expect(
      service.updateCalendarEvent(
        'asso-1',
        'ev-1',
        { title: 'Renamed', kind: AssociationCalendarEventKind.Break } as never,
        { callerUserId: 'member-1' }
      )
    ).rejects.toBeInstanceOf(ForbiddenException);

    // A refusal that had already applied the other fields would leave a half-edited entity for the
    // next request to save.
    expect(row.title).toBe('Gala');
    expect(row.kind).toBe(AssociationCalendarEventKind.Event);
  });

  it('lets a BDE caller change it, in both directions', async () => {
    const up = makeService();
    await up.service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { kind: AssociationCalendarEventKind.Break } as never,
      { isBde: true, callerUserId: 'bde-2' }
    );
    expect(up.saved[0].kind).toBe(AssociationCalendarEventKind.Break);

    const down = makeService({ kind: AssociationCalendarEventKind.Break });
    await down.service.updateCalendarEvent(
      'asso-1',
      'ev-1',
      { kind: AssociationCalendarEventKind.Event } as never,
      { isBde: true, callerUserId: 'bde-2' }
    );
    expect(down.saved[0].kind).toBe(AssociationCalendarEventKind.Event);
  });

  it('does not gate an edit that says nothing about the kind', async () => {
    const { service, saved } = makeService({ kind: AssociationCalendarEventKind.Break });

    await service.updateCalendarEvent('asso-1', 'ev-1', { title: 'Vacances' } as never, {
      callerUserId: 'member-1',
    });

    expect(saved[0].title).toBe('Vacances');
    expect(saved[0].kind).toBe(AssociationCalendarEventKind.Break);
  });
});
