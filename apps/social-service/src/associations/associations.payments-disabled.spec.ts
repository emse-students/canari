import { BadRequestException } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import { PAYMENTS_DISABLED_MESSAGE } from './payment-delegation.util';
import type { Association } from './entities/association.entity';

/**
 * assertPaymentsReady only touches `assoRepo` and `resolvePaymentTarget`, so it is exercised on a
 * bare prototype instance rather than the 40-dependency constructor.
 */
describe('AssociationsService.assertPaymentsReady when the platform disables payments', () => {
  const makeService = (provider: 'stripe' | 'disabled') => {
    const asso = {
      id: 'club',
      stripeAccountId: 'acct_club',
      stripeOnboardingComplete: true,
      lydiaAccountId: null,
      lydiaOnboardingComplete: false,
      paymentParentAssociationId: null,
      paymentDelegationStatus: null,
    } as unknown as Association;
    const service = Object.create(AssociationsService.prototype) as AssociationsService;
    Object.assign(service, {
      assoRepo: { findOne: jest.fn().mockResolvedValue(asso) },
      getActivePaymentProvider: jest.fn().mockResolvedValue(provider),
    });
    return service;
  };

  it('refuses with the disabled message even though the club has a ready Stripe account', async () => {
    const service = makeService('disabled');
    const err = await service.assertPaymentsReady('club').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe(PAYMENTS_DISABLED_MESSAGE);
    await expect(service.getPaymentAccountId('club')).resolves.toBeNull();
  });

  it('still accepts a ready Stripe account when Stripe is active', async () => {
    await expect(makeService('stripe').assertPaymentsReady('club')).resolves.toBeUndefined();
  });
});
