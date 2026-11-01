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
function makeService(posters: { id: string }[] = [], stillCited: string[] = []) {
  // The release re-reads, per poster and under its lock, whether a surviving space cites it.
  const manager = {
    delete: jest.fn(() => Promise.resolve({ affected: 1 })),
    query: jest.fn((sql: string, params: unknown[]) =>
      Promise.resolve(
        sql.includes('LIMIT 1') && stillCited.includes(params[0] as string) ? [1] : []
      )
    ),
  };
  const assoRepo = {
    manager: {
      transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)),
      // The association's posters, read before its delete.
      query: jest.fn(() => Promise.resolve(posters)),
    },
  };
  const count = jest.fn(() => Promise.resolve(2));
  const redis = { scan: jest.fn(), del: jest.fn() };
  const httpService = {
    post: jest.fn((_url: string, body: { mediaIds: string[] }) =>
      of({ data: { released: body.mediaIds, refused: [] } })
    ),
  };
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
    undefined as never, // userTagService
    { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
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

  it('locks the association FOR UPDATE before it deletes anything (the proposals lock order)', async () => {
    const { service, manager } = makeService();

    await service.remove('asso-1', 'admin-1');

    const lock = manager.query.mock.calls.findIndex(([sql]) =>
      sql.endsWith('FROM associations WHERE id = $1 FOR UPDATE')
    );
    expect(lock).toBeGreaterThan(-1);
    expect(manager.query.mock.calls[lock][1]).toEqual(['asso-1']);
    // Before the event delete, whose 074 trigger takes co-organisation proposals.
    expect(manager.query.mock.invocationCallOrder[lock]).toBeLessThan(
      manager.delete.mock.invocationCallOrder[0]
    );
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
    expect(httpService.post.mock.calls).toEqual([
      [
        expect.stringContaining('media/internal/poster-release'),
        { mediaIds: ['poster-1'] },
        expect.anything(),
      ],
      [
        expect.stringContaining('media/internal/poster-release'),
        { mediaIds: ['poster-2'] },
        expect.anything(),
      ],
    ]);
  });

  it('keeps a poster another space still cites (review of #2045)', async () => {
    const { service, httpService } = makeService(
      [{ id: 'poster-1' }, { id: 'poster-2' }],
      ['poster-2']
    );

    await service.remove('asso-1', 'admin-1');

    expect(httpService.post.mock.calls.map((c) => c[1])).toEqual([{ mediaIds: ['poster-1'] }]);
  });

  it('asks the media service nothing when no space had a poster', async () => {
    const { service, httpService } = makeService();
    await service.remove('asso-1', 'admin-1');
    expect(httpService.post).not.toHaveBeenCalled();
  });
});
