import { retireForms } from './retire-forms';
import { FormsService } from './forms.service';

/**
 * A form is removed one of two ways and the choice belongs to the data, not the caller: submissions
 * make it an archive (`deletedAt`), none make it a delete. Both statements are scoped by the same
 * criterion and the submission test is a correlated EXISTS, so one call handles a whole association.
 */
function makeManager(affected: { update: number; delete: number }) {
  const calls: { kind: 'update' | 'delete'; where: string[]; params: unknown[]; set?: unknown }[] =
    [];
  const sub: any = {
    select: () => sub,
    from: () => sub,
    where: () => sub,
    // What TypeORM really returns: a bare SELECT, no parentheses (`retireForms` adds them).
    getQuery: () => 'SELECT 1 FROM "submissions" "s" WHERE "s"."formId" = "forms"."id"',
  };
  const builder = (kind: 'update' | 'delete') => {
    const call = {
      kind,
      where: [] as string[],
      params: [] as unknown[],
      set: undefined as unknown,
    };
    calls.push(call);
    const qb: any = {
      update: () => qb,
      delete: () => qb,
      from: () => qb,
      set: (v: unknown) => {
        call.set = v;
        return qb;
      },
      where: (w: string, p: unknown) => {
        call.where.push(w);
        call.params.push(p);
        return qb;
      },
      andWhere: (w: string) => {
        call.where.push(w);
        return qb;
      },
      execute: () => Promise.resolve({ affected: affected[kind] }),
    };
    return qb;
  };
  let n = 0;
  const manager: any = {
    // Order of use inside `retireForms`: update, its sub-query, delete, its sub-query.
    createQueryBuilder: jest.fn(() => {
      n += 1;
      if (n === 2 || n === 4) return sub;
      return n === 1 ? builder('update') : builder('delete');
    }),
  };
  return { manager, calls };
}

function serviceFor(formRepo: any) {
  return new FormsService(
    formRepo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

describe('retireForms', () => {
  it('archives forms that hold submissions and deletes the others, for one form id', async () => {
    const { manager, calls } = makeManager({ update: 1, delete: 0 });
    await expect(retireForms(manager, { formId: 'f1' })).resolves.toEqual({
      archived: 1,
      deleted: 0,
    });
    const [update, del] = calls;
    expect(update.kind).toBe('update');
    expect(update.where).toEqual([
      '"id" = :value',
      '"deletedAt" IS NULL',
      expect.stringMatching(/^EXISTS \(SELECT .*\)$/),
    ]);
    expect(update.params[0]).toEqual({ value: 'f1' });
    expect(typeof (update.set as { deletedAt: () => string }).deletedAt).toBe('function');
    expect(del.kind).toBe('delete');
    expect(del.where).toEqual([
      '"id" = :value',
      expect.stringMatching(/^NOT EXISTS \(SELECT .*\)$/),
    ]);
  });

  it('scopes both statements to an association', async () => {
    const { manager, calls } = makeManager({ update: 2, delete: 3 });
    await expect(retireForms(manager, { associationId: 'a1' })).resolves.toEqual({
      archived: 2,
      deleted: 3,
    });
    expect(calls[0].where[0]).toBe('"associationId" = :value');
    expect(calls[1].where[0]).toBe('"associationId" = :value');
  });
});

describe('FormsService.delete', () => {
  it('retires through the repository manager once the caller is proven a manager', async () => {
    const { manager, calls } = makeManager({ update: 0, delete: 1 });
    const formRepo: any = {
      findOne: jest.fn(() => Promise.resolve({ id: 'f1', ownerId: 'u1', associationId: null })),
      remove: jest.fn(),
      manager,
    };
    await expect(serviceFor(formRepo).delete('f1', 'u1', false)).resolves.toEqual({ ok: true });
    expect(calls.map((c) => c.kind)).toEqual(['update', 'delete']);
    expect(calls[1].params[0]).toEqual({ value: 'f1' });
    // Never a plain `remove`: that is what orphaned 29 submissions.
    expect(formRepo.remove).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not a manager, touching nothing', async () => {
    const { manager, calls } = makeManager({ update: 0, delete: 0 });
    const formRepo: any = {
      findOne: jest.fn(() => Promise.resolve({ id: 'f1', ownerId: 'u1', associationId: null })),
      manager,
    };
    await expect(serviceFor(formRepo).delete('f1', 'intruder', false)).rejects.toThrow(
      /not allowed/
    );
    expect(calls).toHaveLength(0);
  });
});
