import { describe, expect, it, vi } from 'vitest';
import { AssociationPermissionFlag, type Association } from './api';
import { formManagedAssociations, withRequestedAssociation } from './requestedAssociation';

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

describe('formManagedAssociations', () => {
  // Owner, 2026-11-14: only the members holding "gérer les formulaires" manage an association's
  // forms - a plain membership is not offered as a form's association.
  it('keeps the memberships holding MANAGE_FORMS, and only those', () => {
    const mine = [
      { ...asso('plain'), permissions: 0 },
      { ...asso('forms'), permissions: AssociationPermissionFlag.MANAGE_FORMS },
      { ...asso('members'), permissions: AssociationPermissionFlag.MANAGE_MEMBERS },
      asso('none'),
    ];
    expect(formManagedAssociations(mine).map((a) => a.id)).toEqual(['forms']);
  });
});
