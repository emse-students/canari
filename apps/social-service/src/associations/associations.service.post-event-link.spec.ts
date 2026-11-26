import { BadRequestException } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import {
  AssociationCalendarEventPresentation,
  AssociationCalendarEventStatus,
} from './entities/association-calendar-event.entity';
import { POST_EVENT_NOT_OF_AUTHOR_ASSOCIATION } from './post-event-link';

/**
 * WHICH AGENDA EVENT A POST MAY LINK (`post-event-link.ts`): the author's own, or one it
 * co-organises. Any other is refused with a STABLE CODE the composer words - the composer used to
 * show nothing for a bare 400, so the author could not tell why the post would not go out.
 */

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';

function event(associationId: string) {
  return {
    id: 'ev-1',
    associationId,
    status: AssociationCalendarEventStatus.Validated,
    presentation: AssociationCalendarEventPresentation.Association,
  };
}

function construct(ev: unknown, coOrganiser: unknown) {
  const calendarRepo = { findOne: jest.fn(async () => ev) };
  const coOwnerRepo = { findOne: jest.fn(async () => coOrganiser), find: jest.fn(async () => []) };
  const service = new AssociationsService(
    undefined as never, // assoRepo
    undefined as never, // memberRepo
    calendarRepo as never,
    coOwnerRepo as never,
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
  return { service, coOwnerRepo };
}

describe('a post linking an agenda event', () => {
  it("accepts the author's own event, without asking who co-organises", async () => {
    const { service, coOwnerRepo } = construct(event(A), null);
    await expect(service.resolvePostCalendarEventLink(A, 'ev-1')).resolves.toBe('ev-1');
    expect(coOwnerRepo.findOne).not.toHaveBeenCalled();
  });

  it('accepts an event of another association that the author CO-ORGANISES', async () => {
    const { service, coOwnerRepo } = construct(event(B), { id: 'co-1' });
    await expect(service.resolvePostCalendarEventLink(A, 'ev-1')).resolves.toBe('ev-1');
    expect(coOwnerRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: 'ev-1', associationId: A } })
    );
  });

  it("refuses another association's event with the stable code, in the error envelope", async () => {
    const { service } = construct(event(B), null);
    const refusal: unknown = await service
      .resolvePostCalendarEventLink(A, 'ev-1')
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getStatus()).toBe(400);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({
      code: POST_EVENT_NOT_OF_AUTHOR_ASSOCIATION,
    });
  });

  it('an event that does not exist or is not validated stays an untyped 400', async () => {
    const { service } = construct(null, null);
    await expect(service.resolvePostCalendarEventLink(A, 'ev-1')).rejects.toMatchObject({
      response: { message: expect.stringContaining('not found') },
    });
  });
});
