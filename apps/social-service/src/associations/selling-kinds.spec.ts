import { AssociationPermissionFlag as F } from './entities/association-member.entity';
import { kindMaySell, SELLING_ONLY_FLAGS, writablePermissions } from './selling-kinds';

describe('selling kinds', () => {
  it('lets only an association sell', () => {
    expect(kindMaySell('association')).toBe(true);
    expect(kindMaySell('list')).toBe(false);
    expect(kindMaySell('institution')).toBe(false);
    expect(kindMaySell('anything-new')).toBe(false);
  });

  it('strips the shop and payout rights from a bitmask written for a list or an institution', () => {
    const all = F.MANAGE_MEMBERS | F.MANAGE_FORMS | F.MANAGE_PRODUCTS | F.MANAGE_PAYOUT_ACCOUNT;
    for (const type of ['list', 'institution']) {
      const written = writablePermissions(type, all);
      expect(written & SELLING_ONLY_FLAGS).toBe(0);
      expect(written).toBe(F.MANAGE_MEMBERS | F.MANAGE_FORMS);
    }
  });

  it('leaves an association bitmask whole', () => {
    const all = F.MANAGE_PRODUCTS | F.MANAGE_PAYOUT_ACCOUNT | F.MANAGE_MEMBERS;
    expect(writablePermissions('association', all)).toBe(all);
  });
});
