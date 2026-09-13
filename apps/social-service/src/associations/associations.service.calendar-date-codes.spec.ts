import { BadRequestException } from '@nestjs/common';
import { AssociationsService, CALENDAR_ERROR_CODES } from './associations.service';
import {
  AssociationCalendarEventKind,
  AssociationCalendarEventStatus,
} from './entities/association-calendar-event.entity';

/**
 * EVERY DATE REFUSAL SAYS WHICH RULE WAS BROKEN, AS A CODE, ON BOTH WRITE PATHS.
 *
 * `endsAt must be after startsAt` was thrown with nothing but that sentence, and the global agenda's
 * deposit modal rendered it: `e instanceof Error ? e.message : <fallback>` picks the server's
 * English every time, so the localized half was dead code and a French reader met an English
 * sentence mid-form.
 *
 * The rule is the standing one about never branching on an error MESSAGE, applied one step earlier.
 * A distinction carried in prose is a distinction exactly one call site will make; carried as a code
 * it is one the client can act on, in any language.
 *
 * Three codes and not one, because they are three different mistakes and a reader can only fix the
 * one they made. Six cases and not three, because create and update check the same three things in
 * two different places - which is exactly how one of them comes to drift.
 */

type Overrides = Record<string, unknown>;

function makeService(event?: Overrides) {
  const calendarRepo = {
    create: jest.fn((e: Overrides) => ({ id: 'ev-new', ...e })),
    save: jest.fn(async (e: Overrides) => e),
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
    status: AssociationCalendarEventStatus.Pending,
    validatedAt: null,
    validatedBy: null,
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

  return service;
}

/** The code Nest will serialise as the body, which is what the client reads. */
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (e) {
    // A plain `throw` rather than an `expect`: an assertion inside a catch is one the runner cannot
    // tell from a branch that never ran, which is the whole point of the trailing throw below.
    if (!(e instanceof BadRequestException)) {
      throw new Error(`expected a BadRequestException, got ${String(e)}`);
    }
    return (e.getResponse() as { code?: string }).code;
  }
  throw new Error('expected a refusal, and nothing was thrown');
}

const VALID_START = '2026-10-06T18:00:00.000Z';

describe('createCalendarEvent - the date refusals carry a code', () => {
  it('names an unparseable start', async () => {
    const service = makeService();

    expect(
      await codeOf(() =>
        service.createCalendarEvent(
          'asso-1',
          { title: 'X', startsAt: 'nonsense' } as never,
          'u',
          {}
        )
      )
    ).toBe(CALENDAR_ERROR_CODES.INVALID_START);
  });

  it('names an unparseable end', async () => {
    const service = makeService();

    expect(
      await codeOf(() =>
        service.createCalendarEvent(
          'asso-1',
          { title: 'X', startsAt: VALID_START, endsAt: 'nonsense' } as never,
          'u',
          {}
        )
      )
    ).toBe(CALENDAR_ERROR_CODES.INVALID_END);
  });

  it('names an end that precedes its start', async () => {
    const service = makeService();

    expect(
      await codeOf(() =>
        service.createCalendarEvent(
          'asso-1',
          { title: 'X', startsAt: VALID_START, endsAt: '2026-10-06T09:00:00.000Z' } as never,
          'u',
          {}
        )
      )
    ).toBe(CALENDAR_ERROR_CODES.END_BEFORE_START);
  });
});

describe('updateCalendarEvent - the same three, checked in a different place', () => {
  it('names an unparseable start', async () => {
    const service = makeService();

    expect(
      await codeOf(() =>
        service.updateCalendarEvent('asso-1', 'ev-1', { startsAt: 'nonsense' } as never, {
          callerUserId: 'u',
        })
      )
    ).toBe(CALENDAR_ERROR_CODES.INVALID_START);
  });

  it('names an unparseable end', async () => {
    const service = makeService();

    expect(
      await codeOf(() =>
        service.updateCalendarEvent('asso-1', 'ev-1', { endsAt: 'nonsense' } as never, {
          callerUserId: 'u',
        })
      )
    ).toBe(CALENDAR_ERROR_CODES.INVALID_END);
  });

  it('names an end that precedes its start, including against the STORED start', async () => {
    const service = makeService();

    // Only `endsAt` is sent: the comparison is against the start already on the row, which is the
    // case a DTO-only check would miss.
    expect(
      await codeOf(() =>
        service.updateCalendarEvent(
          'asso-1',
          'ev-1',
          { endsAt: '2026-10-06T09:00:00.000Z' } as never,
          { callerUserId: 'u' }
        )
      )
    ).toBe(CALENDAR_ERROR_CODES.END_BEFORE_START);
  });
});
