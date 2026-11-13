import { describe, it, expect, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listAssociationForms: vi.fn(),
  getForms: vi.fn(),
  getForm: vi.fn(),
}));
vi.mock('$lib/associations/api', () => ({ listAssociationForms: api.listAssociationForms }));
vi.mock('$lib/forms/api', () => ({ getForms: api.getForms, getForm: api.getForm }));

import { loadAssociationForms } from './associationForms';

describe('loadAssociationForms', () => {
  it('takes the full rows from the caller list, in the association route order', async () => {
    api.listAssociationForms.mockResolvedValue([{ id: 'b' }, { id: 'a' }]);
    api.getForms.mockResolvedValue([
      { id: 'a', title: 'A', associationName: 'Club' },
      { id: 'b', title: 'B', associationName: 'Club' },
      { id: 'z', title: 'Other association' },
    ]);
    const rows = await loadAssociationForms('asso-1');
    expect(rows.map((f) => f.id)).toEqual(['b', 'a']);
    expect(api.getForm).not.toHaveBeenCalled();
  });

  it('reads by id a form the caller list lacks (an admin who holds no form flag)', async () => {
    api.listAssociationForms.mockResolvedValue([{ id: 'a' }, { id: 'c' }]);
    api.getForms.mockResolvedValue([{ id: 'a', title: 'A' }]);
    api.getForm.mockResolvedValue({ id: 'c', title: 'C' });
    const rows = await loadAssociationForms('asso-1');
    expect(rows.map((f) => f.id)).toEqual(['a', 'c']);
    expect(api.getForm).toHaveBeenCalledWith('c');
  });
});
