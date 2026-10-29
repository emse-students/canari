import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { AssociationsController } from './associations.controller';
import { AssociationsService } from './associations.service';
import { AssociationPermissionFlag } from './entities/association-member.entity';
import {
  GlobalAdminOrAssociationRoleGuard,
  PERM_FLAG_KEY,
} from './guards/global-admin-or-association-role.guard';
import { ProductsService } from './products.service';

/**
 * THE CASH SALE'S QUOTE IS GUARDED EXACTLY LIKE THE SALE (user, 2026-10-29).
 *
 * The quote reveals what a beneficiary pays, which says which tier they hold: it is asked only by
 * whoever may record the sale, in the association named by the path. The scoping of the product to
 * that association is proven in `products.service.spec.ts` ("a product of ANOTHER association").
 */
describe('AssociationsController.quoteCashSale - the guards of the sale it quotes', () => {
  const quote = AssociationsController.prototype['quoteCashSale'];
  const grant = AssociationsController.prototype['grantProductPurchase'];

  it('is behind the sign-in guard and the association guard, asking MANAGE_PRODUCTS', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, quote) as unknown[] | undefined;
    expect(guards).toContain(NginxAuthGuard);
    expect(guards).toContain(GlobalAdminOrAssociationRoleGuard);
    expect(Reflect.getMetadata(PERM_FLAG_KEY, quote)).toBe(
      AssociationPermissionFlag.MANAGE_PRODUCTS
    );
  });

  it('CONTROL: carries the same guards and flag as the grant it quotes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, quote)).toEqual(
      Reflect.getMetadata(GUARDS_METADATA, grant)
    );
    expect(Reflect.getMetadata(PERM_FLAG_KEY, quote)).toBe(
      Reflect.getMetadata(PERM_FLAG_KEY, grant)
    );
  });

  it("hands the PATH's association to the service", async () => {
    const products = {
      quoteCashSale: jest.fn(() => Promise.resolve({ kind: 'typed' })),
    };
    const controller = new AssociationsController(
      {} as AssociationsService,
      products as unknown as ProductsService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await controller.quoteCashSale('asso-a', 'prod-1', 'user-1');
    expect(products.quoteCashSale).toHaveBeenCalledWith('asso-a', 'prod-1', 'user-1');
  });
});
