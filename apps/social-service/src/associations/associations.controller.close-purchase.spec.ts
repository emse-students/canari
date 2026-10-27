import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
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
 * CLOSING A PAYMENT PAID AND NOT GRANTED IS AN ASSOCIATION'S OWN ACT (migration 113).
 *
 * A manager of association A must not close a purchase of association B, by either route: naming B
 * in the path (the guard refuses, the manager holds no right in B), or naming A with B's purchase id
 * (the controller hands the PATH's association to the service, which looks the record up within it
 * and answers 404 - `products.service.spec.ts`).
 */
describe('AssociationsController.closePaidNotGranted - one association closes only its own', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const PURCHASE_OF_B = '00000000-0000-4000-8000-0000000000b1';
  const handler = AssociationsController.prototype['closePaidNotGranted'];

  /** The real guard, over a service that grants MANAGE_PRODUCTS to `manager` in A only. */
  function guardFor() {
    const associations = {
      mayAct: jest.fn((userId: string, associationId: string, flag: number) =>
        Promise.resolve(
          userId === 'manager' &&
            associationId === A &&
            flag === AssociationPermissionFlag.MANAGE_PRODUCTS
        )
      ),
      isMember: jest.fn((userId: string, associationId: string) =>
        Promise.resolve(userId === 'manager' && associationId === A)
      ),
    };
    const guard = new GlobalAdminOrAssociationRoleGuard(
      new Reflector(),
      associations as unknown as AssociationsService
    );
    const context = (associationId: string) =>
      ({
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'x-user-id': 'manager' },
            params: { id: associationId, purchaseId: PURCHASE_OF_B },
          }),
        }),
      }) as unknown as ExecutionContext;
    return { guard, context };
  }

  it('is behind the sign-in guard and the association guard, asking MANAGE_PRODUCTS', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined;
    expect(guards).toContain(NginxAuthGuard);
    expect(guards).toContain(GlobalAdminOrAssociationRoleGuard);
    expect(Reflect.getMetadata(PERM_FLAG_KEY, handler)).toBe(
      AssociationPermissionFlag.MANAGE_PRODUCTS
    );
  });

  it('refuses a manager of A who names B in the path', async () => {
    const { guard, context } = guardFor();
    await expect(guard.canActivate(context(B))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("admits that manager on A's own path", async () => {
    const { guard, context } = guardFor();
    await expect(guard.canActivate(context(A))).resolves.toBe(true);
  });

  it("hands the PATH's association to the service, so B's purchase is looked up within A", async () => {
    const products = {
      closePaidNotGranted: jest.fn(() =>
        Promise.reject(new NotFoundException('Purchase not found'))
      ),
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

    await expect(
      controller.closePaidNotGranted(A, PURCHASE_OF_B, 'manager', { outcome: 'granted' })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(products.closePaidNotGranted).toHaveBeenCalledWith(
      A,
      PURCHASE_OF_B,
      'manager',
      'granted'
    );
  });
});
