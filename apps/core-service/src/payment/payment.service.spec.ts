import axios from 'axios';
import { PaymentService } from './payment.service';
import { signLydiaParams } from './lydia-signature';
import type { PlatformService, PlatformConfigPublic } from '../platform/platform.service';

function makeService(paymentProvider: 'lydia' | 'disabled') {
  const config: PlatformConfigPublic = {
    maintenanceEnabled: false,
    maintenanceMessage: null,
    minClientVersion: '0.0.0',
    paymentProvider,
    callsMode: 'off',
    livesMode: 'off',
    pushMode: 'full',
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
      callsMode: 'off',
      livesMode: 'off',
      pushMode: 'full',
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

describe('PaymentService.getVerifiedCheckoutRequestState', () => {
  const KEY = 'business-key-for-test';
  const UUID = '077f2efc5b53d37086e25a19d87ceb29';
  const signed = (amount: string) => signLydiaParams({ amount, request_uuid: UUID }, KEY);

  afterEach(() => jest.restoreAllMocks());

  /** The service with the Business key social-service answers, and the provider's raw answer. */
  function withKeyAndAnswer(key: string | null, answer?: { state: string; signature?: string }) {
    const service = makeService('lydia');
    const post = jest.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (url.includes('lydia-callback-key')) return { data: { businessPrivateToken: key } };
      throw new Error(`unexpected call to ${url}`);
    });
    const read = jest
      .spyOn(service, 'getCheckoutRequestState')
      .mockResolvedValue(
        answer
          ? { state: answer.state as 'paid', raw: '1', signature: answer.signature ?? null }
          : (undefined as never)
      );
    return { service, post, read };
  }

  it('answers verified when the signature covers the expected amount and the uuid', async () => {
    const { service } = withKeyAndAnswer(KEY, { state: 'paid', signature: signed('12.50') });
    await expect(
      service.getVerifiedCheckoutRequestState({ requestUuid: UUID }, 'vendor', 1250)
    ).resolves.toEqual({ verification: 'verified', state: 'paid', raw: '1' });
  });

  it('answers mismatch when the request was issued for another amount', async () => {
    const { service } = withKeyAndAnswer(KEY, { state: 'paid', signature: signed('99.00') });
    await expect(
      service.getVerifiedCheckoutRequestState({ requestUuid: UUID }, 'vendor', 1250)
    ).resolves.toMatchObject({ verification: 'mismatch', state: 'paid' });
  });

  it('answers unsigned when Lydia returned no signature', async () => {
    const { service } = withKeyAndAnswer(KEY, { state: 'paid' });
    await expect(
      service.getVerifiedCheckoutRequestState({ requestUuid: UUID }, 'vendor', 1250)
    ).resolves.toMatchObject({ verification: 'unsigned' });
  });

  it('does not ask Lydia at all when no Business key is stored', async () => {
    const { service, read } = withKeyAndAnswer(null);
    await expect(
      service.getVerifiedCheckoutRequestState({ requestUuid: UUID }, 'vendor', 1250)
    ).resolves.toEqual({ verification: 'no-key' });
    expect(read).not.toHaveBeenCalled();
  });

  it('throws when the key cannot be read: not a verdict', async () => {
    const service = makeService('lydia');
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('social unreachable'));
    const read = jest.spyOn(service, 'getCheckoutRequestState');
    await expect(
      service.getVerifiedCheckoutRequestState({ requestUuid: UUID }, 'vendor', 1250)
    ).rejects.toThrow('social unreachable');
    expect(read).not.toHaveBeenCalled();
  });
});
