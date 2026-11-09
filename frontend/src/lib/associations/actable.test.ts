import { beforeEach, describe, expect, it, vi } from 'vitest';

const admin = vi.hoisted(() => ({ global: false }));
vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => admin.global }));
vi.mock('./api', () => ({
  AssociationPermissionFlag: { POST_AS_ASSO: 1, MANAGE_BOOKINGS: 1 << 11 },
  // Mirrors the real value: a super-admin never inherits an association's voice.
  SUPER_ADMIN_EXCLUDED_FLAGS: 1,
  hasPermissionFlag: (permissions: number, flag: number) => (permissions & flag) !== 0,
  listAssociations: vi.fn(),
  listMyAssociations: vi.fn(),
  getMyBdeReach: vi.fn(),
}));

import { listActableAssociations } from './actable';
import { getMyBdeReach, listAssociations, listMyAssociations, type Association } from './api';

const asso = (id: string, permissions = 0) => ({ id, name: id, permissions }) as Association;
const BOOKINGS = 1 << 11;

beforeEach(() => {
  admin.global = false;
  vi.mocked(listMyAssociations).mockResolvedValue([asso('mine', BOOKINGS), asso('other', 1)]);
  vi.mocked(listAssociations).mockResolvedValue([asso('mine'), asso('other'), asso('child')]);
  vi.mocked(getMyBdeReach).mockResolvedValue({ validateEvents: [], manageAsso: ['child'] });
});

describe('listActableAssociations', () => {
  it('offers the whole directory to a global admin', async () => {
    admin.global = true;
    expect((await listActableAssociations(BOOKINGS)).map((a) => a.id)).toEqual([
      'mine',
      'other',
      'child',
    ]);
  });

  it('adds the associations under the BDE reach for a flag the super-admin inherits', async () => {
    const ids = (await listActableAssociations(BOOKINGS)).map((a) => a.id);
    expect(ids).toEqual(['mine', 'child']);
  });

  it('never adds the BDE reach for the excluded POST_AS_ASSO: posts keep their result', async () => {
    const ids = (await listActableAssociations(1)).map((a) => a.id);
    expect(ids).toEqual(['other']);
    expect(getMyBdeReach).not.toHaveBeenCalled();
  });
});
