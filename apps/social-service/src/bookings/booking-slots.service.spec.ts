import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  BOOKINGS_INSIDE_CHANGE,
  BookingSlotsService,
  MAX_SLOT_RANGE_DAYS,
} from './booking-slots.service';
import { addDays } from './zoned-time';

/** A repository stub answering `find`/`findOneBy` with fixed rows. */
const repo = (rows: unknown[] = [], one: unknown = null) => ({
  find: jest.fn().mockResolvedValue(rows),
  findOneBy: jest.fn().mockResolvedValue(one),
});

const SPACE = {
  id: 's1',
  timeZone: 'Europe/Paris',
  slotMode: 'step',
  stepMinutes: 30,
  maxSteps: 4,
};

function service(
  parts: Partial<
    Record<
      'spaces' | 'resources' | 'rules' | 'exceptions' | 'blocks' | 'bookings',
      ReturnType<typeof repo>
    >
  > = {}
) {
  const r = {
    spaces: repo([], SPACE),
    resources: repo([{ id: 'r1', spaceId: 's1' }]),
    rules: repo([
      { resourceId: 'r1', weekday: 1, onDate: null, startTime: '18:00:00', endTime: '20:00:00' },
    ]),
    exceptions: repo(),
    blocks: repo(),
    bookings: repo(),
    ...parts,
  };
  return new BookingSlotsService(
    r.spaces as never,
    r.resources as never,
    r.rules as never,
    r.exceptions as never,
    r.blocks as never,
    r.bookings as never
  );
}

describe('BookingSlotsService.spaceSlots', () => {
  it('generates the units of each resource with their state', async () => {
    const live = {
      id: 'b1',
      resourceId: 'r1',
      startsAt: new Date('2026-10-26T17:30:00Z'),
      endsAt: new Date('2026-10-26T18:00:00Z'),
    };
    const out = await service({ bookings: repo([live]) }).spaceSlots(
      's1',
      '2026-10-26',
      '2026-10-26'
    );
    expect(out).toHaveLength(1);
    expect(out[0].units.map((u) => u.state)).toEqual(['free', 'booked', 'free', 'free']);
    expect(new Date(out[0].units[0].startMs).toISOString()).toBe('2026-10-26T17:00:00.000Z');
  });

  it('refuses a reversed range and one wider than the ceiling', async () => {
    await expect(service().spaceSlots('s1', '2026-10-26', '2026-10-25')).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      service().spaceSlots('s1', '2026-10-01', addDays('2026-10-01', MAX_SLOT_RANGE_DAYS))
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('says a missing space is missing', async () => {
    await expect(
      service({ spaces: repo([], null) }).spaceSlots('s1', '2026-10-26', '2026-10-26')
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BookingSlotsService.assertAvailabilityChangeAllowed (D29)', () => {
  const coming = {
    id: 'b1',
    resourceId: 'r1',
    startsAt: new Date('2026-10-26T17:00:00Z'),
    endsAt: new Date('2026-10-26T18:00:00Z'),
  };
  const config = {
    timeZone: 'Europe/Paris',
    slotMode: 'step' as const,
    stepMinutes: 30,
    maxSteps: 4,
  };
  const now = Date.parse('2026-10-20T10:00:00Z');

  it('lets a change through that keeps every coming booking', async () => {
    await expect(
      service({ bookings: repo([coming]) }).assertAvailabilityChangeAllowed(
        'r1',
        config,
        [{ weekday: 1, onDate: null, startTime: '17:00', endTime: '21:00' }],
        [],
        now
      )
    ).resolves.toBeUndefined();
  });

  it('refuses one that leaves a coming booking outside, naming it', async () => {
    const err = await service({ bookings: repo([coming]) })
      .assertAvailabilityChangeAllowed(
        'r1',
        config,
        [{ weekday: 2, onDate: null, startTime: '18:00', endTime: '20:00' }],
        [],
        now
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({
      code: BOOKINGS_INSIDE_CHANGE,
      bookingIds: ['b1'],
    });
  });
});
