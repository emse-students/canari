import { PaymentService } from './payment.service';
import type { PlatformService, PlatformConfigPublic } from '../platform/platform.service';

function makeService(paymentProvider: 'stripe' | 'lydia') {
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
  it('resolves to stripe when platform_config.paymentProvider is stripe', async () => {
    const service = makeService('stripe');
    await expect(service.getActiveProviderId()).resolves.toBe('stripe');
  });

  it('resolves to lydia when platform_config.paymentProvider is lydia', async () => {
    const service = makeService('lydia');
    await expect(service.getActiveProviderId()).resolves.toBe('lydia');
  });

  it('re-reads platform_config on every call, so a toggle takes effect without a restart', async () => {
    const config: PlatformConfigPublic = {
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: '0.0.0',
      paymentProvider: 'stripe',
    };
    const platformService = {
      getConfig: jest.fn().mockResolvedValue(config),
    } as unknown as PlatformService;
    const service = new PaymentService(platformService);

    await expect(service.getActiveProviderId()).resolves.toBe('stripe');
    config.paymentProvider = 'lydia';
    await expect(service.getActiveProviderId()).resolves.toBe('lydia');
  });
});
