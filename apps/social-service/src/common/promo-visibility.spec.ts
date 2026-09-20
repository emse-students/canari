import type { EntityManager } from 'typeorm';
import { PROMO_CUTOFF_MONTH_DAY, promoCutoffFor } from './promo-visibility';

/**
 * `promoCutoffFor` decides how far back a reader's history goes, and it is now the ONE place that
 * decides it for both the posts feed and the agenda. These tests pin the three ways it declines to
 * cut anything - each of which used to be an `if` somewhere else - and the fact that it does not
 * swallow a database failure, which is the behaviour the posts feed had and should not have had.
 */
function managerReturning(rows: unknown[]): { manager: EntityManager; query: jest.Mock } {
  const query = jest.fn(() => Promise.resolve(rows));
  return { manager: { query } as unknown as EntityManager, query };
}

describe('promoCutoffFor', () => {
  it('cuts a viewer at the August their own promo opens on', async () => {
    const { manager, query } = managerReturning([{ promo: 2025 }]);
    await expect(promoCutoffFor(manager, 'u1', false)).resolves.toBe(
      `2025-${PROMO_CUTOFF_MONTH_DAY}`
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('never cuts a global admin, and does not even ask', async () => {
    const { manager, query } = managerReturning([{ promo: 2025 }]);
    await expect(promoCutoffFor(manager, 'u1', true)).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('never cuts an anonymous reader - both calendar routes are public and carry no identity', async () => {
    const { manager, query } = managerReturning([]);
    await expect(promoCutoffFor(manager, undefined, false)).resolves.toBeNull();
    await expect(promoCutoffFor(manager, '   ', false)).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('never cuts a viewer whose row carries no promo', async () => {
    const { manager } = managerReturning([{ promo: null }]);
    await expect(promoCutoffFor(manager, 'u1', false)).resolves.toBeNull();
    const missing = managerReturning([]);
    await expect(promoCutoffFor(missing.manager, 'u1', false)).resolves.toBeNull();
  });

  it('LETS A DATABASE FAILURE THROUGH - a swallowed one silently widens every feed', async () => {
    const query = jest.fn(() => Promise.reject(new Error('connection terminated')));
    const manager = { query } as unknown as EntityManager;
    await expect(promoCutoffFor(manager, 'u1', false)).rejects.toThrow('connection terminated');
  });
});
