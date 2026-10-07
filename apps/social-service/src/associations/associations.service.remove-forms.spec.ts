import { AssociationsService } from './associations.service';
import { Association } from './entities/association.entity';
import { AssociationCalendarEvent } from './entities/association-calendar-event.entity';
import { AssociationMember } from './entities/association-member.entity';
import { Form } from '../forms/entities/form.entity';

/**
 * Deleting an association deletes its forms IN THE SAME TRANSACTION. Found on dev 2026-10-07: the
 * paid form of a deleted institution stayed alive and was shown as "Personnel", because
 * `forms.associationId` carries no foreign key and `remove` never touched the table.
 */
function makeService() {
  const manager = { delete: jest.fn(() => Promise.resolve({ affected: 1 })) };
  const assoRepo = {
    manager: { transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)) },
  };
  const count = jest.fn(() => Promise.resolve(2));
  const redis = { scan: jest.fn(), del: jest.fn() };
  const service = new AssociationsService(
    assoRepo as never, // assoRepo
    { count } as never, // memberRepo
    { count } as never, // calendarRepo
    undefined as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    { count } as never, // formRepo
    undefined as never, // productRepo
    redis as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never // userTagService
  );
  jest
    .spyOn(
      service as unknown as { invalidatePostListCaches: () => Promise<void> },
      'invalidatePostListCaches'
    )
    .mockResolvedValue(undefined);
  return { service, manager, assoRepo };
}

describe('AssociationsService.remove - the forms go with the association', () => {
  it('deletes events, forms, members and the association through ONE transaction', async () => {
    const { service, manager, assoRepo } = makeService();

    await expect(service.remove('asso-1', 'admin-1')).resolves.toEqual({ ok: true });

    expect(assoRepo.manager.transaction).toHaveBeenCalledTimes(1);
    expect(manager.delete.mock.calls).toEqual([
      [AssociationCalendarEvent, { associationId: 'asso-1' }],
      [Form, { associationId: 'asso-1' }],
      [AssociationMember, { associationId: 'asso-1' }],
      [Association, 'asso-1'],
    ]);
  });
});
