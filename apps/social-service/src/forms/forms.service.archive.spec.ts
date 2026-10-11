import { NotFoundException } from '@nestjs/common';
import { FormsService } from './forms.service';

/**
 * AN ARCHIVED FORM (`deletedAt` set) IS GONE FOR RESPONDENTS AND LISTS, AND STILL THERE FOR STAFF.
 *
 * Migration 081 puts a RESTRICT foreign key on `submissions.formId`, so a form holding submissions
 * is archived instead of deleted. The repo fake below HONOURS the `deletedAt: IsNull()` condition,
 * which is the only thing these tests are about: a fake that ignored `where` would pass a service
 * that forgot the filter.
 */
describe('FormsService - archived forms', () => {
  const stored: Record<string, unknown> = {
    id: 'f1',
    ownerId: 'u-owner',
    associationId: null,
    isPublic: true,
    anonymous: false,
    opensAt: new Date(Date.now() + 3_600_000),
    items: [],
    deletedAt: new Date('2026-10-01T00:00:00Z'),
  };

  function makeService() {
    const formRepo: any = {
      findOne: jest.fn((opts: { where: Record<string, unknown> }) => {
        const wantsLive =
          (opts.where.deletedAt as { type?: string } | undefined)?.type === 'isNull';
        return Promise.resolve(wantsLive && stored.deletedAt ? null : stored);
      }),
      find: jest.fn(() => Promise.resolve([])),
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          where: jest.fn(() => qb),
          andWhere: jest.fn(() => qb),
          orderBy: jest.fn(() => qb),
          getMany: () => Promise.resolve([]),
        };
        return qb;
      }),
      manager: {},
    };
    const submissionRepo: any = {
      count: jest.fn(() => Promise.resolve(0)),
      find: jest.fn(() => Promise.resolve([{ id: 's1', formId: 'f1', userId: null }])),
      manager: { query: jest.fn(() => Promise.resolve([])) },
    };
    const associationsService: any = {
      associationsWhereUserHasFlag: jest.fn(() => Promise.resolve([{ id: 'a1', name: 'A' }])),
      namesByIds: jest.fn(() => Promise.resolve(new Map())),
    };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      { findOne: jest.fn(), save: jest.fn() } as any,
      { get: jest.fn() } as any,
      associationsService,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { service, formRepo, submissionRepo };
  }

  it('answers 404 to a member reading it', async () => {
    const { service } = makeService();
    await expect(service.get('f1')).rejects.toThrow(NotFoundException);
  });

  it('answers 404 to a guest on its public link', async () => {
    const { service } = makeService();
    await expect(service.getPublic('f1')).rejects.toThrow(NotFoundException);
  });

  it('refuses a submission, for a member and for a guest', async () => {
    const { service } = makeService();
    await expect(service.submit('f1', { answers: {} }, 'member')).rejects.toThrow(
      NotFoundException
    );
    await expect(service.submit('f1', { answers: {} }, 'guest')).rejects.toThrow(NotFoundException);
  });

  it('takes no reminder subscription', async () => {
    const { service } = makeService();
    await expect(service.subscribeReminder('f1', 'u1')).rejects.toThrow(NotFoundException);
  });

  it('reports no right to submit', async () => {
    const { service } = makeService();
    const state = await service.hasSubmission('f1', 'u1');
    expect(state.maySubmit).toBe(false);
  });

  it('is filtered out of every list: admin, owned and the association scan', async () => {
    const { service, formRepo } = makeService();
    await service.list();
    await service.list('u1');
    const wheres = formRepo.find.mock.calls.map((c: any[]) => c[0].where);
    expect(wheres).toHaveLength(2);
    for (const where of wheres) expect(where.deletedAt.type).toBe('isNull');
    const qb = formRepo.createQueryBuilder.mock.results[0].value;
    expect(qb.andWhere).toHaveBeenCalledWith('"f"."deletedAt" IS NULL');
  });

  it('keeps its submissions readable for staff', async () => {
    const { service, formRepo } = makeService();
    // The staff gate finds an archived form: it does not filter on deletedAt.
    await expect(service.assertFormManager('f1', 'u-owner', false)).resolves.toBe(stored);
    expect(formRepo.findOne.mock.calls[0][0].where).toEqual({ id: 'f1' });
    const subs = await service.getSubmissions('f1');
    expect(subs).toHaveLength(1);
  });
});
