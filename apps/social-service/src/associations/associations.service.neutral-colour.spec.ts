import { ForbiddenException } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import { AssociationPermissionFlag } from './entities/association-member.entity';
import { AssociationCalendarEventPresentation } from './entities/association-calendar-event.entity';
import { rightsAskedBy } from './association-update-rights';
import {
  CALENDAR_NEUTRAL_ERROR_CODES,
  neutralColourOfRow,
  presentEventsForReader,
  NO_EVENT_STEWARDSHIP,
} from './event-presentation';

/**
 * EACH BDE CHOOSES THE COLOUR OF ITS NEUTRAL EVENTS (owner, 2026-11-14).
 *
 * The setting rides `PATCH /associations/:id` as `neutralEventColor`, so the right it asks is the
 * one table's: EDIT_PROFILE, the same as `color` and the logo. The service refuses it on an
 * association that is not a BDE, and the colour survives the masking of a neutral row (the one
 * field a reader needs to paint it) while never appearing on an association event.
 */
const BDE = '00000000-0000-4000-8000-0000000000b1';
const CLUB = '00000000-0000-4000-8000-0000000000c1';

function makeService(isBDE: boolean) {
  const update = jest.fn(async () => undefined);
  const service = new AssociationsService(
    { update } as never, // assoRepo
    undefined as never, // memberRepo
    undefined as never, // calendarRepo
    undefined as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // productRepo
    undefined as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never, // userTagService
    undefined as never // lydiaNotifier
  );
  Object.assign(service, {
    findById: jest.fn(async (id: string) => ({ id, isBDE, slug: 'x' })),
    invalidatePostListCaches: jest.fn(async () => undefined),
  });
  return { service, update };
}

describe('the right the setting asks', () => {
  it('is EDIT_PROFILE, the right of the association colour and logo', () => {
    const asked = rightsAskedBy({ neutralEventColor: '#112233' });
    expect([...asked.flags.keys()]).toEqual([AssociationPermissionFlag.EDIT_PROFILE]);
    expect(asked.unknown).toEqual([]);
  });
});

describe('writing neutralEventColor', () => {
  it('stores the colour on a BDE', async () => {
    const { service, update } = makeService(true);
    await service.update(BDE, { neutralEventColor: '#112233' });
    expect(update).toHaveBeenCalledWith(
      BDE,
      expect.objectContaining({ neutralEventColor: '#112233' })
    );
  });

  it('clears it back to null (the derived accent) on a blank or null', async () => {
    const { service, update } = makeService(true);
    await service.update(BDE, { neutralEventColor: '' });
    await service.update(BDE, { neutralEventColor: null });
    expect(update).toHaveBeenNthCalledWith(
      1,
      BDE,
      expect.objectContaining({ neutralEventColor: null })
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      BDE,
      expect.objectContaining({ neutralEventColor: null })
    );
  });

  it('refuses it on an association that is not a BDE, typed, and writes nothing', async () => {
    const { service, update } = makeService(false);
    const refused = service.update(CLUB, { neutralEventColor: '#112233' });
    await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refused).rejects.toMatchObject({
      response: { code: CALENDAR_NEUTRAL_ERROR_CODES.COLOUR_NOT_A_BDE },
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('the colour on the payload', () => {
  const NEUTRAL = AssociationCalendarEventPresentation.Neutral;
  const ASSOCIATION = AssociationCalendarEventPresentation.Association;

  it('is the BDE colour on a neutral row and null on an association row', () => {
    expect(neutralColourOfRow({ presentation: NEUTRAL }, '#112233')).toBe('#112233');
    expect(neutralColourOfRow({ presentation: ASSOCIATION }, '#112233')).toBeNull();
    expect(neutralColourOfRow({ presentation: NEUTRAL }, null)).toBeNull();
  });

  it('survives the masking a non-steward reads, while the owner stays hidden', () => {
    const row = {
      associationId: BDE,
      presentation: NEUTRAL,
      createdBy: 'u1',
      validatedBy: null,
      rejectedBy: null,
      coOwners: [],
      associationName: 'BDE',
      associationColor: '#abcdef',
      neutralEventColor: '#112233',
    };
    const [masked] = presentEventsForReader([row], NO_EVENT_STEWARDSHIP, { listedFor: null });
    expect(masked.neutralEventColor).toBe('#112233');
    expect(masked.associationId).toBe('');
    expect(masked.associationColor).toBeNull();
  });
});
