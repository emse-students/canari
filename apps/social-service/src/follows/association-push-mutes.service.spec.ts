import { NotFoundException } from '@nestjs/common';
import { AssociationPushMutesService, MUTABLE_PUSH_TYPES } from './association-push-mutes.service';

describe('AssociationPushMutesService', () => {
  const rows: { userId: string; associationId: string }[] = [];
  const assos = [
    { id: 'a1', name: 'Zeta', slug: 'zeta', logoUrl: null },
    { id: 'a2', name: 'Alpha', slug: 'alpha', logoUrl: null },
  ];

  const repo = {
    upsert: jest.fn((row: { userId: string; associationId: string }) => {
      if (!rows.some((r) => r.userId === row.userId && r.associationId === row.associationId)) {
        rows.push(row);
      }
      return Promise.resolve();
    }),
    delete: jest.fn((where: { userId: string; associationId: string }) => {
      const keep = rows.filter(
        (r) => !(r.userId === where.userId && r.associationId === where.associationId)
      );
      rows.length = 0;
      rows.push(...keep);
      return Promise.resolve();
    }),
    exists: jest.fn(({ where }: { where: { userId: string; associationId: string } }) =>
      Promise.resolve(
        rows.some((r) => r.userId === where.userId && r.associationId === where.associationId)
      )
    ),
    find: jest.fn(({ where }: { where: { userId: string } }) =>
      Promise.resolve(rows.filter((r) => r.userId === where.userId))
    ),
  };
  const assoRepo = {
    exists: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(assos.some((a) => a.id === where.id))
    ),
    findBy: jest.fn(() => Promise.resolve(assos)),
  };

  function service() {
    return new AssociationPushMutesService(repo as never, assoRepo as never);
  }

  beforeEach(() => {
    rows.length = 0;
    jest.clearAllMocks();
  });

  it('mutes idempotently and only for the caller', async () => {
    await service().mute('u1', 'a1');
    await service().mute('u1', 'a1');
    expect(rows).toEqual([{ userId: 'u1', associationId: 'a1' }]);
    expect(await service().isMuted('u1', 'a1')).toBe(true);
    expect(await service().isMuted('u2', 'a1')).toBe(false);
  });

  it('refuses an association that does not exist', async () => {
    await expect(service().mute('u1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(0);
  });

  it('unmutes only the callers own row, and an unmute of nothing is not an error', async () => {
    await service().mute('u1', 'a1');
    await service().mute('u2', 'a1');
    await service().unmute('u1', 'a1');
    await expect(service().unmute('u1', 'a1')).resolves.toEqual({ ok: true });
    expect(rows).toEqual([{ userId: 'u2', associationId: 'a1' }]);
  });

  it('lists the callers muted associations by name', async () => {
    await service().mute('u1', 'a1');
    await service().mute('u1', 'a2');
    const list = await service().listMuted('u1');
    expect(list.map((a) => a.name)).toEqual(['Alpha', 'Zeta']);
    expect(await service().listMuted('nobody')).toEqual([]);
  });

  it('mutes only the types that reach a reader', () => {
    expect([...MUTABLE_PUSH_TYPES].sort()).toEqual(['association_post', 'association_repost']);
  });
});
