import { describe, expect, it, vi } from 'vitest';
import type { Association } from './api';
import { withRequestedAssociation } from './requestedAssociation';

const asso = (id: string) => ({ id, name: id }) as Association;

describe('withRequestedAssociation', () => {
  it('offers the requested association to a user who is not a member of it', async () => {
    const fetchOne = vi.fn().mockResolvedValue(asso('b'));
    const list = await withRequestedAssociation([asso('a')], 'b', fetchOne);
    expect(list.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('does not fetch when the memberships already carry it, or nothing was requested', async () => {
    const fetchOne = vi.fn();
    expect(await withRequestedAssociation([asso('a')], 'a', fetchOne)).toHaveLength(1);
    expect(await withRequestedAssociation([asso('a')], '', fetchOne)).toHaveLength(1);
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it('leaves the list alone when the requested one cannot be loaded', async () => {
    const fetchOne = vi.fn().mockRejectedValue(new Error('404'));
    expect(await withRequestedAssociation([asso('a')], 'x', fetchOne)).toHaveLength(1);
  });
});
