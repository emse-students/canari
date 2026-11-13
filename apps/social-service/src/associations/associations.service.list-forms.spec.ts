/**
 * The association's forms route returns the WHOLE form, named and flagged like the managers' list
 * (`FormsService.list`): a global admin's Formulaires tab then draws the same row as `/forms` -
 * the preview link and the unpublished-changes badge included - from ONE read, with no per-form
 * follow-up. An archived form is in no list.
 */
import { IsNull } from 'typeorm';
import { AssociationsService } from './associations.service';

function build(forms: Array<{ id: string }>, changed: string[]) {
  const find = jest.fn(async () => forms);
  const query = jest.fn(async () => changed.map((formId) => ({ formId })));
  const service = Object.create(AssociationsService.prototype) as AssociationsService;
  Object.assign(service, {
    formRepo: { find, manager: { query } },
    findById: jest.fn(async () => ({ id: 'a1', name: 'Club' })),
  });
  return { service, find, query };
}

describe('AssociationsService.listFormsByAssociation', () => {
  it('returns full rows with the association name and the unpublished flag, archived excluded', async () => {
    const { service, find } = build([{ id: 'f1' }, { id: 'f2' }], ['f2']);
    const rows = await service.listFormsByAssociation('a1');
    expect(find).toHaveBeenCalledWith({
      where: { associationId: 'a1', deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    expect(rows).toEqual([
      { id: 'f1', associationName: 'Club', hasUnpublishedChanges: false },
      { id: 'f2', associationName: 'Club', hasUnpublishedChanges: true },
    ]);
  });

  it('asks for no unpublished flags of an association with no form', async () => {
    const { service, query } = build([], []);
    expect(await service.listFormsByAssociation('a1')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
