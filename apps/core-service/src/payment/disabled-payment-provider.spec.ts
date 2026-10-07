import { BadRequestException } from '@nestjs/common';
import { DisabledPaymentProvider, PAYMENTS_DISABLED_MESSAGE } from './disabled-payment-provider';
import { UpdatePlatformConfigDto } from '../platform/dto/update-platform-config.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

describe('DisabledPaymentProvider', () => {
  const provider = new DisabledPaymentProvider();

  it('identifies as disabled and is never configured', () => {
    expect(provider.id).toBe('disabled');
    expect(provider.isConfigured()).toBe(false);
  });

  it('refuses every operation with one clear 400', async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => provider.createOnboarding(),
      () => provider.getAccountStatus(),
      () => provider.getConnectAccountStatus(),
      () => provider.getConnectBalance(),
      () => provider.createConnectDashboardLink(),
      () => provider.createCheckoutSession(),
      () => provider.retrieveSession(),
      () => provider.getOrCreateCustomer(),
      () => provider.createSetupCheckoutSession(),
      () => provider.listPaymentMethods(),
      () => provider.detachPaymentMethod(),
      () => provider.chargeWithSavedMethod(),
    ];
    for (const call of calls) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe(PAYMENTS_DISABLED_MESSAGE);
    }
  });
});

describe('UpdatePlatformConfigDto.paymentProvider', () => {
  const check = (value: string) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { paymentProvider: value }));

  it('accepts disabled alongside stripe and lydia', async () => {
    for (const v of ['stripe', 'lydia', 'disabled']) expect(await check(v)).toHaveLength(0);
  });

  it('rejects anything else', async () => {
    expect(await check('paypal')).toHaveLength(1);
  });
});
