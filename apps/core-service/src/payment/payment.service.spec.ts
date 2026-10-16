import { PaymentService } from './payment.service';
import type { PlatformService, PlatformConfigPublic } from '../platform/platform.service';

function makeService(paymentProvider: 'lydia' | 'disabled') {
  const config: PlatformConfigPublic = {
    maintenanceEnabled: false,
    maintenanceMessage: null,
    minClientVersion: '0.0.0',
    paymentProvider,
  };
  const platformService = {
    getConfig: jest.fn().mockResolvedValue(config),
  } as unknown as PlatformService;
  return new PaymentService(platformService);
}

describe('PaymentService provider selection', () => {
  it('resolves to lydia when platform_config.paymentProvider is lydia', async () => {
    const service = makeService('lydia');
    await expect(service.getActiveProviderId()).resolves.toBe('lydia');
  });

  it('resolves to disabled, reports not configured and refuses every operation', async () => {
    const service = makeService('disabled');
    await expect(service.getActiveProviderId()).resolves.toBe('disabled');
    await expect(service.isConfigured()).resolves.toBe(false);
    await expect(
      service.createCheckoutSession({
        lineItems: [
          {
            quantity: 1,
            price_data: { currency: 'eur', unit_amount: 100, product_data: { name: 'x' } },
          },
        ],
        successUrl: 'https://x/ok',
        cancelUrl: 'https://x/ko',
      })
    ).rejects.toThrow('Payments are disabled on this platform');
  });

  it('re-reads platform_config on every call, so a toggle takes effect without a restart', async () => {
    const config: PlatformConfigPublic = {
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: '0.0.0',
      paymentProvider: 'disabled',
    };
    const platformService = {
      getConfig: jest.fn().mockResolvedValue(config),
    } as unknown as PlatformService;
    const service = new PaymentService(platformService);

    await expect(service.getActiveProviderId()).resolves.toBe('disabled');
    config.paymentProvider = 'lydia';
    await expect(service.getActiveProviderId()).resolves.toBe('lydia');
  });
});
