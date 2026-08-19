import { PaymentService } from './payment.service';
import { signLydiaParams } from './lydia-signature';
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

describe('PaymentService.verifyLydiaRequestCallback', () => {
  const prevToken = process.env.LYDIA_PROVIDER_PRIVATE_TOKEN;

  beforeEach(() => {
    process.env.LYDIA_PROVIDER_PRIVATE_TOKEN = 'provider-private-token';
  });

  afterEach(() => {
    process.env.LYDIA_PROVIDER_PRIVATE_TOKEN = prevToken;
  });

  it('verifies against the Lydia provider regardless of which provider is currently active', () => {
    // Active provider is 'stripe' here on purpose - a Lydia payment already in flight must still
    // verify even if the admin flipped the platform switch back before it resolved.
    const service = makeService('stripe');
    const fields = { request_id: 'req-1', amount: '12.00', currency: 'EUR', order_ref: 'form:s1' };
    const sig = signLydiaParams(fields, 'provider-private-token');
    expect(service.verifyLydiaRequestCallback(fields, sig)).toBe(true);
    expect(service.verifyLydiaRequestCallback(fields, 'wrong')).toBe(false);
  });
});
