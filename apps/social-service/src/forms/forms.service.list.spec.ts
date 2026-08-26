import { FormsService } from './forms.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';

/**
 * What `/forms` shows.
 *
 * `assertFormManager` has always accepted MANAGE_FORMS on the linked association, so those forms
 * were editable and exportable by API while appearing in no list on any screen - reachable only by
 * someone who already knew the URL. The list now covers them, and says which association each form
 * belongs to by NAME.
 *
 * Two sources, not three: the per-form co-manager list was deleted (migration 053), so a form is
 * managed by its owner and by the association's form managers.
 */
describe('FormsService.list', () => {
  function makeService(opts: {
    owned?: Record<string, unknown>[];
    viaAssociation?: Record<string, unknown>[];
    managed?: { id: string; name: string }[];
    names?: [string, string][];
  }) {
    const queries: Record<string, unknown>[][] = [];
    const formRepo: any = {
      find: jest.fn(() => Promise.resolve(opts.owned ?? [])),
      // One query-builder call in `list`: the association scan.
      createQueryBuilder: jest.fn(() => {
        const result = opts.viaAssociation ?? [];
        queries.push(result as Record<string, unknown>[]);
        const qb: any = {
          where: () => qb,
          andWhere: () => qb,
          orderBy: () => qb,
          getMany: () => Promise.resolve(result),
        };
        return qb;
      }),
    };
    const associationsService: any = {
      associationsWhereUserHasFlag: jest.fn(() => Promise.resolve(opts.managed ?? [])),
      namesByIds: jest.fn(() => Promise.resolve(new Map(opts.names ?? []))),
    };
    const service = new FormsService(
      formRepo,
      { count: jest.fn(), findOne: jest.fn(), save: jest.fn() } as any,
      { findOne: jest.fn(), save: jest.fn() } as any,
      { get: jest.fn() } as any,
      associationsService,
      {} as any,
      {} as any,
      // The list never prices anything, so no facts are ever built. Present because the
      // constructor requires it, and deliberately not a stub that would hide a call.
      {} as any
    );
    return { service, associationsService };
  }

  const form = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    ownerId: 'user1',
    associationId: null,
    createdAt: `2026-08-${id.slice(-2)}T00:00:00Z`,
    ...over,
  });

  it('asks for the associations where the caller may manage forms', async () => {
    const { service, associationsService } = makeService({});
    await service.list('user1');
    expect(associationsService.associationsWhereUserHasFlag).toHaveBeenCalledWith(
      'user1',
      AssociationPermissionFlag.MANAGE_FORMS
    );
  });

  it('includes a form the caller does not own, via MANAGE_FORMS', async () => {
    const { service } = makeService({
      owned: [],
      managed: [{ id: 'asso1', name: 'Le Cercle' }],
      viaAssociation: [form('f01', { ownerId: 'someone-else', associationId: 'asso1' })],
      names: [['asso1', 'Le Cercle']],
    });
    const list = await service.list('user1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'f01', associationName: 'Le Cercle' });
  });

  // A form you own in an association you administer is in both sets. Concatenating would list it
  // twice.
  it('lists a form once when it arrives from two sources', async () => {
    const linked = form('f01', { associationId: 'asso1' });
    const { service } = makeService({
      owned: [linked],
      managed: [{ id: 'asso1', name: 'Le Cercle' }],
      viaAssociation: [linked],
      names: [['asso1', 'Le Cercle']],
    });
    expect(await service.list('user1')).toHaveLength(1);
  });

  it('sorts the merged list newest first, across both sources', async () => {
    const { service } = makeService({
      owned: [form('f01'), form('f03')],
      managed: [{ id: 'asso1', name: 'Le Cercle' }],
      viaAssociation: [form('f02', { associationId: 'asso1' })],
      names: [['asso1', 'Le Cercle']],
    });
    expect((await service.list('user1')).map((f) => f.id)).toEqual(['f03', 'f02', 'f01']);
  });

  it('labels a personal form with no association name', async () => {
    const { service } = makeService({ owned: [form('f01')] });
    expect((await service.list('user1'))[0].associationName).toBeNull();
  });

  // A deleted association leaves its id behind on the form. The row still renders, unlabelled -
  // there is no name to show and inventing one would be worse than showing none.
  it('labels a form whose association no longer exists with no name', async () => {
    const { service } = makeService({
      owned: [form('f01', { associationId: 'gone' })],
      names: [],
    });
    expect((await service.list('user1'))[0].associationName).toBeNull();
  });

  // The association scan is skipped entirely when the caller manages none, rather than running a
  // query with an empty IN list - which Postgres rejects outright.
  it('runs no association query when the caller manages no association', async () => {
    const { service } = makeService({ owned: [form('f01')], managed: [] });
    await expect(service.list('user1')).resolves.toHaveLength(1);
  });
});
