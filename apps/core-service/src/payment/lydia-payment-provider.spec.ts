import axios from 'axios';
import { LydiaPaymentProvider } from './lydia-payment-provider';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeProvider() {
  return new LydiaPaymentProvider({
    LYDIA_ENV: 'homologation',
    LYDIA_PROVIDER_TOKEN: 'provider-token',
    LYDIA_PROVIDER_PRIVATE_TOKEN: 'provider-private-token',
  });
}

describe('LydiaPaymentProvider.createCheckoutSession', () => {
  afterEach(() => jest.clearAllMocks());

  it('posts request/do as form-urlencoded with the summed amount and target vendor_token', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { error: '0', request_uuid: 'req-uuid-1', mobile_url: 'https://lydia-app.com/pay/1' },
    });

    const provider = makeProvider();
    const result = await provider.createCheckoutSession({
      lineItems: [
        { productName: 'Cotisation', unitAmountCents: 1500, quantity: 1, currency: 'eur' },
      ],
      successUrl: 'https://canari.example/success',
      cancelUrl: 'https://canari.example/cancel',
      connectAccountId: 'vendor-token-abc',
      payerRecipient: { value: 'user@example.com', type: 'email' },
      idempotencyKey: 'submission-42',
    });

    expect(result).toEqual({ id: 'req-uuid-1', url: 'https://lydia-app.com/pay/1' });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://homologation.lydia-app.com/api/request/do.json');
    expect(config).toMatchObject({
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const sent = new URLSearchParams(body as string);
    expect(sent.get('amount')).toBe('15.00');
    expect(sent.get('currency')).toBe('EUR');
    expect(sent.get('vendor_token')).toBe('vendor-token-abc');
    expect(sent.get('provider_token')).toBe('provider-token');
    expect(sent.get('recipient')).toBe('user@example.com');
    expect(sent.get('type')).toBe('email');
    expect(sent.get('order_ref')).toBe('submission-42');
  });

  it('throws when no target vendor_token is given', async () => {
    const provider = makeProvider();
    await expect(
      provider.createCheckoutSession({
        lineItems: [{ productName: 'x', unitAmountCents: 100, quantity: 1, currency: 'eur' }],
        successUrl: 's',
        cancelUrl: 'c',
        payerRecipient: { value: 'user@example.com', type: 'email' },
      })
    ).rejects.toThrow(/vendor_token/);
  });

  it('throws when no payer recipient is given', async () => {
    const provider = makeProvider();
    await expect(
      provider.createCheckoutSession({
        lineItems: [{ productName: 'x', unitAmountCents: 100, quantity: 1, currency: 'eur' }],
        successUrl: 's',
        cancelUrl: 'c',
        connectAccountId: 'vendor-token-abc',
      })
    ).rejects.toThrow(/payerRecipient/);
  });

  it('surfaces a Lydia error response as an exception', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { error: '2', message: 'ERROR_INVALID_PHONE_FORMAT' },
    });

    const provider = makeProvider();
    await expect(
      provider.createCheckoutSession({
        lineItems: [{ productName: 'x', unitAmountCents: 100, quantity: 1, currency: 'eur' }],
        successUrl: 's',
        cancelUrl: 'c',
        connectAccountId: 'vendor-token-abc',
        payerRecipient: { value: '+33600000000', type: 'phone' },
      })
    ).rejects.toThrow(/ERROR_INVALID_PHONE_FORMAT/);
  });
});

describe('LydiaPaymentProvider.createOnboarding', () => {
  afterEach(() => jest.clearAllMocks());

  const legalProfile = {
    name: 'BDE Test',
    address: '1 rue des Mines',
    zipcode: '42000',
    city: 'Saint-Etienne',
    country: 'France',
    businessEmail: 'bde@test.example',
    businessPhone: '+33100000000',
  };

  it('posts business/create with the legal profile and returns the vendor token + dashboard url', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        error: '0',
        api_token: 'vendor-token-xyz',
        dashboard_url: 'https://lydia-app.com/console/xyz',
      },
    });

    const provider = makeProvider();
    const result = await provider.createOnboarding({
      associationId: 'assoc-1',
      refreshUrl: 'r',
      returnUrl: 'u',
      legalProfile,
    });

    expect(result).toEqual({
      url: 'https://lydia-app.com/console/xyz',
      accountId: 'vendor-token-xyz',
    });

    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://homologation.lydia-app.com/api/business/create.json');
    const sent = new URLSearchParams(body as string);
    expect(sent.get('provider_token')).toBe('provider-token');
    expect(sent.get('name')).toBe('BDE Test');
    expect(sent.get('business_email')).toBe('bde@test.example');
    expect(sent.get('business_phone')).toBe('+33100000000');
  });

  it('throws when the legal profile is missing', async () => {
    const provider = makeProvider();
    await expect(
      provider.createOnboarding({ associationId: 'assoc-1', refreshUrl: 'r', returnUrl: 'u' })
    ).rejects.toThrow(/legal profile/);
  });

  it('throws when the legal profile is incomplete', async () => {
    const provider = makeProvider();
    await expect(
      provider.createOnboarding({
        associationId: 'assoc-1',
        refreshUrl: 'r',
        returnUrl: 'u',
        legalProfile: { ...legalProfile, businessPhone: '' },
      })
    ).rejects.toThrow(/legal profile/);
  });
});

describe('LydiaPaymentProvider retired/unimplemented methods', () => {
  it('throws a clear error for saved-payment-method calls', async () => {
    const provider = makeProvider();
    await expect(provider.listPaymentMethods()).rejects.toThrow(/retired/);
    await expect(provider.getOrCreateCustomer()).rejects.toThrow(/no Customer object/);
  });

  it('throws a clear error for live status calls', async () => {
    const provider = makeProvider();
    await expect(provider.getConnectAccountStatus('vendor-token')).rejects.toThrow(
      /live account-status poll/
    );
  });
});

describe('LydiaPaymentProvider.verifyRequestCallback', () => {
  it('accepts a signature computed the same way Lydia computes it', () => {
    const provider = makeProvider();
    // md5("amount=12&request_id=124&YOUR_PRIVATE_TOKEN")-shaped check via the shared util,
    // just confirming the provider wires its own private token into the same signing scheme.
    const fields = { amount: '12', request_id: '124' };
    const { signLydiaParams } = jest.requireActual('./lydia-signature');
    const sig = signLydiaParams(fields, 'provider-private-token');
    expect(provider.verifyRequestCallback(fields, sig)).toBe(true);
    expect(provider.verifyRequestCallback(fields, 'wrong-signature')).toBe(false);
  });
});
