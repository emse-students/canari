import { AssociationsService } from './associations.service';
import { Association } from './entities/association.entity';
import { AssociationCalendarEvent } from './entities/association-calendar-event.entity';
import { AssociationMember } from './entities/association-member.entity';
import { of } from 'rxjs';
import { retireForms } from '../forms/retire-forms';

jest.mock('../forms/retire-forms', () => ({
  retireForms: jest.fn(() => Promise.resolve({ archived: 1, deleted: 0 })),
}));

/**
 * Deleting an association deletes its forms IN THE SAME TRANSACTION. Found on dev 2026-10-07: the
 * paid form of a deleted institution stayed alive and was shown as "Personnel", because
 * `forms.associationId` carries no foreign key and `remove` never touched the table.
 */
function makeService(posters: { id: string }[] = [], stillCited: { id: string }[] = []) {
  const manager = { delete: jest.fn(() => Promise.resolve({ affected: 1 })) };
  const assoRepo = {
    manager: {
      transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)),
      // The first read lists the association's posters; the second, after the commit, which of
      // them a surviving space still cites.
      query: jest.fn((sql: string) =>
        Promise.resolve(sql.includes('ANY($1)') ? stillCited : posters)
      ),
    },
  };
  const count = jest.fn(() => Promise.resolve(2));
  const redis = { scan: jest.fn(), del: jest.fn() };
  const httpService = { post: jest.fn(() => of({ data: { changed: posters.length } })) };
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
    httpService as never, // httpService
    undefined as never, // notifications
    undefined as never // userTagService
  );
  jest
    .spyOn(
      service as unknown as { invalidatePostListCaches: () => Promise<void> },
      'invalidatePostListCaches'
    )
    .mockResolvedValue(undefined);
  return { service, manager, assoRepo, httpService };
}

describe('AssociationsService.remove - the forms go with the association', () => {
  it('deletes events, forms, members and the association through ONE transaction', async () => {
    const { service, manager, assoRepo } = makeService();

    await expect(service.remove('asso-1', 'admin-1')).resolves.toEqual({ ok: true });

    expect(assoRepo.manager.transaction).toHaveBeenCalledTimes(1);
    expect(manager.delete.mock.calls).toEqual([
      [AssociationCalendarEvent, { associationId: 'asso-1' }],
      [AssociationMember, { associationId: 'asso-1' }],
      [Association, 'asso-1'],
    ]);
    // Forms go through `retireForms`: archived when they hold submissions (`submissions_form_fk`),
    // deleted otherwise - never a bare `manager.delete(Form, ...)`, which the key would refuse.
    expect(retireForms).toHaveBeenCalledWith(manager, { associationId: 'asso-1' });
  });
});

describe('AssociationsService.remove - its booking spaces go, and their posters are released', () => {
  it('releases every poster of its spaces to the idle sweep once the association is gone', async () => {
    const { service, assoRepo, httpService } = makeService([
      { id: 'poster-1' },
      { id: 'poster-2' },
    ]);

    await expect(service.remove('asso-1', 'admin-1')).resolves.toEqual({ ok: true });

    expect(assoRepo.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM booking_spaces'),
      ['asso-1']
    );
    expect(httpService.post).toHaveBeenCalledTimes(1);
    expect(httpService.post.mock.calls[0]).toEqual([
      expect.stringContaining('media/internal/retention-class'),
      { mediaIds: ['poster-1', 'poster-2'], retentionClass: 'ephemeral' },
      expect.anything(),
    ]);
  });

  it('keeps a poster another space still cites (review of #2045)', async () => {
    const { service, httpService } = makeService(
      [{ id: 'poster-1' }, { id: 'poster-2' }],
      [{ id: 'poster-2' }]
    );

    await service.remove('asso-1', 'admin-1');

    expect(httpService.post).toHaveBeenCalledTimes(1);
    expect((httpService.post.mock.calls[0] as unknown[])[1]).toEqual({
      mediaIds: ['poster-1'],
      retentionClass: 'ephemeral',
    });
  });

  it('asks the media service nothing when no space had a poster', async () => {
    const { service, httpService } = makeService();
    await service.remove('asso-1', 'admin-1');
    expect(httpService.post).not.toHaveBeenCalled();
  });
});
