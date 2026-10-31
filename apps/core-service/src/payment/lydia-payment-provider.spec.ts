import axios from 'axios';
import { BadRequestException, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LYDIA_CALL_TIMEOUT_MS,
  LYDIA_MAX_AMOUNT_CENTS,
  LYDIA_MIN_AMOUNT_CENTS,
  LYDIA_BUSINESS_CREATED_UNLINKED,
  LYDIA_BUSINESS_CREATE_UNCONFIRMED,
  LYDIA_ONBOARDING_STEP_TIMEOUT_MS,
  LYDIA_ORPHAN_LOG_TAG,
  LYDIA_ORPHAN_SUSPECT_LOG_TAG,
  LydiaCashierAddedUnconfirmedException,
  LydiaPaymentProvider,
  PAYMENTS_PROXY_READ_TIMEOUT_MS,
  PAYMENT_PROVIDER_REFUSED,
  LYDIA_BUSINESS_BLOCKED,
  LYDIA_BUSINESS_NOT_VALIDATED,
  LYDIA_BUSINESS_TOKEN_REJECTED,
  LYDIA_CASHIER_NOT_CONFIGURED,
  LYDIA_CASHIER_PERMISSIONS,
  LYDIA_CASHIER_ROLE_PERMISSIONS,
  cashierRightsDifference,
  LYDIA_CASHIER_HOLDER_RIGHTS_MISSING,
  LYDIA_CASHIER_READBACK_INVALID,
  parseCashierReading,
  LYDIA_CASHIER_PERMISSIONS_INVALID,
  LYDIA_CASHIER_PHONE_INVALID,
  LYDIA_CASHIER_RIGHTS_INCOMPLETE,
  LYDIA_SIGNATURE_REFUSED,
  LYDIA_UNREACHABLE,
  redactForLog,
} from './lydia-payment-provider';
import { signLydiaRequest } from './lydia-signature';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeProvider() {
  return new LydiaPaymentProvider({
    LYDIA_ENV: 'homologation',
    LYDIA_PROVIDER_TOKEN: 'provider-token',
  });
}

describe('LydiaPaymentProvider.createCheckoutSession', () => {
  afterEach(() => jest.clearAllMocks());

  /**
   * Social-service waits 120 s on core. Without a bound of its own, core could still be waiting on
   * Lydia when social gave up, and the two would disagree on whether the call was answered.
   */
  it('bounds request/do under the 120 s social waits, and rethrows a timeout as NOT an answer', async () => {
    mockedAxios.post.mockRejectedValue(
      Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' })
    );
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const attempt = makeProvider().createCheckoutSession({
      lineItems: [{ productName: 'Sweat', unitAmountCents: 1500, quantity: 1, currency: 'eur' }],
      successUrl: 'https://canari.example/success',
      cancelUrl: 'https://canari.example/cancel',
      connectAccountId: 'vendor-token-abc',
      payerRecipient: { value: 'user@example.com', type: 'email' },
      idempotencyKey: 'product:a:b',
    });
    // A refusal would be a 400 social RELEASES the attempt on; a lost call must stay an error.
    await expect(attempt).rejects.not.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow('timeout of 60000ms exceeded');
    const [, , config] = mockedAxios.post.mock.calls[0];
    expect(LYDIA_CALL_TIMEOUT_MS).toBeLessThan(120_000);
    expect(config).toMatchObject({ timeout: LYDIA_CALL_TIMEOUT_MS });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no response within 60 s'));
    error.mockRestore();
  });

  const anAttempt = () =>
    makeProvider().createCheckoutSession({
      lineItems: [{ productName: 'Sweat', unitAmountCents: 1500, quantity: 1, currency: 'eur' }],
      successUrl: 'https://canari.example/success',
      cancelUrl: 'https://canari.example/cancel',
      connectAccountId: 'vendor-token-abc',
      payerRecipient: { value: 'user@example.com', type: 'email' },
      idempotencyKey: 'product:a:b',
    });

  const httpFailure = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, data: {} },
    });

  it.each([400, 403, 404, 422])(
    'answers an HTTP %i from Lydia as a typed REFUSAL, which releases the attempt',
    async (status) => {
      mockedAxios.post.mockRejectedValue(httpFailure(status));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // The control: before, this came back as the raw axios error - a 5xx that left the attempt
      // open until its expiry although Lydia had answered that nothing was created.
      const refusal = await anAttempt().catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(BadRequestException);
      expect((refusal as BadRequestException).getResponse()).toMatchObject({
        code: PAYMENT_PROVIDER_REFUSED,
        providerCode: `http-${status}`,
      });
      warn.mockRestore();
    }
  );

  /**
   * A 4xx that does not say "refused": Lydia may have created the request all the same, and an
   * attempt released on it and then paid is recorded "closed but PAID" - a charge refunded by hand.
   */
  it.each([408, 409, 425, 429, 502])(
    'keeps an HTTP %i from Lydia a LOST call, never the refusal that releases the attempt',
    async (status) => {
      mockedAxios.post.mockRejectedValue(httpFailure(status));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const lost = await anAttempt().catch((e: unknown) => e);
      expect(lost).not.toBeInstanceOf(BadRequestException);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status}`));
      error.mockRestore();
    }
  );

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

    expect(result).toEqual({
      id: 'req-uuid-1',
      url: 'https://lydia-app.com/pay/1',
      requestId: null,
    });

    // Asserted through `mock.calls` rather than `expect(mockedAxios.post)`: handing the method
    // itself to a matcher detaches it from its receiver, which is what `unbound-method` warns
    // about, and the call list is the thing being asserted anyway.
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
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
    // The receiver for these lives in webhook.controller.ts (lydia-request-callback) - registered
    // per-request since Lydia has no global webhook config like Stripe's dashboard-configured one.
    expect(sent.get('confirm_url')).toContain(
      '/api/payments/lydia-request-callback?outcome=confirm'
    );
    expect(sent.get('cancel_url')).toContain('/api/payments/lydia-request-callback?outcome=cancel');
    expect(sent.get('expire_url')).toContain('/api/payments/lydia-request-callback?outcome=expire');
    // No lifetime asked for, none sent: Lydia's default applies.
    expect(sent.has('expire_time')).toBe(false);
  });

  // Measured on the sandbox 2026-10-15 (payments.md): `expire_time` is whole seconds, and request/do
  // answers the numeric `request_id` its callbacks and its cancel call carry, next to the uuid.
  it('sends the lifetime as expire_time and returns the numeric request_id', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        error: '0',
        request_id: 48213,
        request_uuid: 'req-uuid-1',
        mobile_url: 'https://lydia-app.com/pay/1',
      },
    });
    const result = await makeProvider().createCheckoutSession({
      lineItems: [{ productName: 'Gala', unitAmountCents: 1500, quantity: 1, currency: 'eur' }],
      successUrl: 's',
      cancelUrl: 'c',
      connectAccountId: 'vendor-token-abc',
      payerRecipient: { value: 'user@example.com', type: 'email' },
      expireAfterSeconds: 1800,
    });
    expect(result).toEqual({
      id: 'req-uuid-1',
      url: 'https://lydia-app.com/pay/1',
      requestId: '48213',
    });
    const sent = new URLSearchParams(mockedAxios.post.mock.calls[0][1] as string);
    expect(sent.get('expire_time')).toBe('1800');
  });

  // Lydia reads 0 as "never expires" and refuses the rest: none of them may reach it.
  it.each([0, -5, 1.5, Number.NaN])(
    'refuses expireAfterSeconds %p before calling Lydia',
    async (v) => {
      await expect(
        makeProvider().createCheckoutSession({
          lineItems: [{ productName: 'Gala', unitAmountCents: 1500, quantity: 1, currency: 'eur' }],
          successUrl: 's',
          cancelUrl: 'c',
          connectAccountId: 'vendor-token-abc',
          payerRecipient: { value: 'user@example.com', type: 'email' },
          expireAfterSeconds: v,
        })
      ).rejects.toThrow('expireAfterSeconds');
      expect(mockedAxios.post.mock.calls).toHaveLength(0);
    }
  );
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

  it.each([
    ['below the 0.50 EUR minimum', 49],
    ['above the 1000 EUR maximum', 100_001],
  ])('refuses an amount %s before calling Lydia', async (_label, cents) => {
    const provider = makeProvider();
    await expect(
      provider.createCheckoutSession({
        lineItems: [{ productName: 'x', unitAmountCents: cents, quantity: 1, currency: 'eur' }],
        successUrl: 's',
        cancelUrl: 'c',
        connectAccountId: 'vendor-token-abc',
        payerRecipient: { value: 'user@example.com', type: 'email' },
      })
    ).rejects.toThrow(/0\.50 to 1000\.00 EUR/);
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('answers an out-of-range amount with the typed code and BOTH bounds, not just a sentence', async () => {
    const provider = makeProvider();
    const err = await provider
      .createCheckoutSession({
        lineItems: [{ productName: 'x', unitAmountCents: 49, quantity: 1, currency: 'eur' }],
        successUrl: 's',
        cancelUrl: 'c',
        connectAccountId: 'vendor-token-abc',
        payerRecipient: { value: 'user@example.com', type: 'email' },
      })
      .catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'AMOUNT_OUT_OF_RANGE',
      minCents: 50,
      maxCents: 100_000,
      // The sentence is formatted from the constants, never a hardcoded copy of them.
      message: 'Lydia accepts payments from 0.50 to 1000.00 EUR (got 0.49)',
    });
  });

  it('holds the range the shared contract names, so social-service cannot drift from it', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'payment-amount-range.json'),
        'utf8'
      )
    ) as { minCents: number; maxCents: number };
    expect(LYDIA_MIN_AMOUNT_CENTS).toBe(contract.minCents);
    expect(LYDIA_MAX_AMOUNT_CENTS).toBe(contract.maxCents);
  });

  it('accepts both bounds of the range', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { error: '0', request_uuid: 'r', mobile_url: 'https://lydia-app.com/pay/r' },
    });
    const provider = makeProvider();
    for (const cents of [50, 100_000]) {
      await expect(
        provider.createCheckoutSession({
          lineItems: [{ productName: 'x', unitAmountCents: cents, quantity: 1, currency: 'eur' }],
          successUrl: 's',
          cancelUrl: 'c',
          connectAccountId: 'vendor-token-abc',
          payerRecipient: { value: 'user@example.com', type: 'email' },
        })
      ).resolves.toMatchObject({ id: 'r' });
    }
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

describe('LydiaPaymentProvider.getCheckoutRequestState', () => {
  afterEach(() => jest.clearAllMocks());

  // The pair measured on the sandbox 2026-10-15: request_uuid AND vendor_token.
  it('posts request/state with the uuid and the vendor_token', async () => {
    mockedAxios.post.mockResolvedValue({ data: { state: '1', used_ease_of_payment: '0' } });
    await makeProvider().getCheckoutRequestState({ requestUuid: 'req-uuid-1' }, 'vendor-token-abc');
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://homologation.lydia-app.com/api/request/state.json');
    const sent = new URLSearchParams(body as string);
    expect(Object.fromEntries(sent)).toEqual({
      request_uuid: 'req-uuid-1',
      vendor_token: 'vendor-token-abc',
    });
  });

  it.each([
    ['1', 'paid'],
    [1, 'paid'],
    ['6', 'cancelled-or-expired'],
    ['0', 'open'],
    // Measured on dev 2026-10-21: a payer's decline. It used to read `other`, which kept the
    // answer `pending` with no retry for up to 30 minutes.
    ['5', 'declined'],
    [5, 'declined'],
    ['7', 'unknown'],
    ['constructor', 'unknown'],
    [undefined, 'unknown'],
  ])('reads state %p as %s, never guessing an unmeasured code', async (raw, state) => {
    mockedAxios.post.mockResolvedValue({ data: { state: raw } });
    await expect(
      makeProvider().getCheckoutRequestState({ requestUuid: 'req-uuid-1' }, 'vendor-token-abc')
    ).resolves.toEqual({ state, raw: raw === undefined ? '' : String(raw), signature: null });
  });

  it('carries the signature Lydia answered, for PaymentService to verify', async () => {
    mockedAxios.post.mockResolvedValue({ data: { state: '1', signature: 'a'.repeat(32) } });
    await expect(
      makeProvider().getCheckoutRequestState({ requestUuid: 'req-uuid-1' }, 'vendor-token-abc')
    ).resolves.toEqual({ state: 'paid', raw: '1', signature: 'a'.repeat(32) });
  });

  // The pair measured on the sandbox 2026-10-15 to find the request too: order_ref + vendor_token.
  it('reads an attempt by its order_ref when it has no uuid, and nothing else', async () => {
    mockedAxios.post.mockResolvedValue({ data: { state: '0' } });
    await expect(
      makeProvider().getCheckoutRequestState({ orderRef: 'product:p:c' }, 'vendor-token-abc')
    ).resolves.toEqual({ state: 'open', raw: '0', signature: null });
    const sent = new URLSearchParams(mockedAxios.post.mock.calls[0][1] as string);
    expect(Object.fromEntries(sent)).toEqual({
      order_ref: 'product:p:c',
      vendor_token: 'vendor-token-abc',
    });
  });

  it('answers not-found to an order_ref no request carries (error 2, "Requete introuvable")', async () => {
    mockedAxios.post.mockResolvedValue({ data: { error: '2', message: 'Requete introuvable' } });
    await expect(
      makeProvider().getCheckoutRequestState({ orderRef: 'product:p:c' }, 'vendor-token-abc')
    ).resolves.toEqual({ state: 'not-found', raw: 'error 2', signature: null });
  });

  it('keeps error 2 a REFUSAL for a uuid, which Canari got from Lydia itself', async () => {
    // The control: answering not-found here would close an attempt Lydia did issue.
    mockedAxios.post.mockResolvedValue({ data: { error: '2', message: 'Requete introuvable' } });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(
      makeProvider().getCheckoutRequestState({ requestUuid: 'req-uuid-1' }, 'vendor-token-abc')
    ).rejects.toThrow('Requete introuvable');
  });

  it('refuses without a vendor_token, before calling Lydia', async () => {
    await expect(
      makeProvider().getCheckoutRequestState({ requestUuid: 'req-uuid-1' }, '')
    ).rejects.toThrow('vendor_token');
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });
});

describe('LydiaPaymentProvider.cancelCheckoutRequest', () => {
  afterEach(() => jest.clearAllMocks());

  it('posts request/cancel with the numeric request_id and the vendor_token, unsigned', async () => {
    mockedAxios.post.mockResolvedValue({ data: { error: '0', state: '6' } });
    await expect(makeProvider().cancelCheckoutRequest('48213', 'vendor-token-abc')).resolves.toBe(
      'cancelled'
    );
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://homologation.lydia-app.com/api/request/cancel.json');
    const sent = new URLSearchParams(body as string);
    expect([...sent.keys()].sort()).toEqual(['request_id', 'vendor_token']);
    expect(sent.get('request_id')).toBe('48213');
    expect(sent.get('vendor_token')).toBe('vendor-token-abc');
  });

  it('reads error 2 (already cancelled or expired) as an answer, with no refusal logged', async () => {
    mockedAxios.post.mockResolvedValue({ data: { error: '2', message: 'Already cancelled' } });
    const warn = jest.spyOn(Logger.prototype, 'warn');
    await expect(makeProvider().cancelCheckoutRequest('48213', 'vendor-token-abc')).resolves.toBe(
      'already-settled'
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws the typed refusal on any other error', async () => {
    mockedAxios.post.mockResolvedValue({ data: { error: '105', message: 'Unknown request' } });
    await expect(
      makeProvider().cancelCheckoutRequest('48213', 'vendor-token-abc')
    ).rejects.toMatchObject({
      response: { code: PAYMENT_PROVIDER_REFUSED, providerCode: '105' },
    });
  });

  it('refuses a request_uuid, which Lydia does not accept here, before calling it', async () => {
    await expect(
      makeProvider().cancelCheckoutRequest('0f8e4c3a-1b2c-4d5e-8f90-123456789abc', 'v')
    ).rejects.toThrow('numeric request_id');
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
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
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          error: '0',
          api_token: 'vendor-token-xyz',
          api_token_id: 'throwaway-private-key',
          dashboard_url: 'https://lydia-app.com/console/xyz',
        },
      })
      .mockResolvedValueOnce({ data: { status: 'ok' } });

    const provider = makeProvider();
    const order: string[] = [];
    const onBusinessCreated = jest.fn(async (token: string) => {
      order.push(`pending:${token}:${mockedAxios.post.mock.calls.length}`);
    });
    const result = await provider.createOnboarding({
      associationId: 'assoc-1',
      refreshUrl: 'r',
      returnUrl: 'u',
      legalProfile,
      onBusinessCreated,
    });
    // The vendor token is handed over after business/create and BEFORE the key check.
    expect(order).toEqual(['pending:vendor-token-xyz:1']);

    expect(result).toEqual({
      url: 'https://lydia-app.com/console/xyz',
      accountId: 'vendor-token-xyz',
      businessPrivateToken: 'throwaway-private-key',
    });

    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://homologation.lydia-app.com/api/business/create.json');
    const sent = new URLSearchParams(body as string);
    expect(sent.get('provider_token')).toBe('provider-token');
    expect(sent.get('name')).toBe('BDE Test');
    expect(sent.get('business_email')).toBe('bde@test.example');
    expect(sent.get('business_phone')).toBe('+33100000000');
    expect(sent.get('webhook')).toMatch(/\/api\/payments\/lydia-business-webhook$/);

    // The key is proven by Lydia BEFORE it is returned: auth/vendortoken with the pair.
    const [checkUrl, checkBody] = mockedAxios.post.mock.calls[1];
    expect(checkUrl).toBe('https://homologation.lydia-app.com/api/auth/vendortoken.json');
    const checked = new URLSearchParams(checkBody as string);
    expect(checked.get('vendor_token')).toBe('vendor-token-xyz');
    expect(checked.get('vendor_id')).toBe('throwaway-private-key');
  });

  const httpError = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status },
    });
  it.each([
    ['error 103', () => Promise.resolve({ data: { error: '103', message: 'Le token id' } })],
    ['an answer that is not status ok', () => Promise.resolve({ data: { status: 'maybe' } })],
    [
      'another Lydia code',
      () => Promise.resolve({ data: { error: '10', message: 'Non autorise' } }),
    ],
    ['an HTTP 400 refusal', () => Promise.reject(httpError(400))],
    ['an HTTP 500', () => Promise.reject(httpError(500))],
    [
      'no answer at all',
      () =>
        Promise.reject(
          Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' })
        ),
    ],
  ])(
    'auth/vendortoken with %s is the ONE typed LYDIA_BUSINESS_CREATED_UNLINKED, the orphan logged',
    async (_label, check) => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      mockedAxios.post
        .mockResolvedValueOnce({
          data: {
            error: '0',
            api_token: 'vendor-token-xyz',
            api_token_id: 'throwaway-wrong-key',
            dashboard_url: 'https://lydia-app.com/console/xyz',
          },
        })
        .mockImplementationOnce(check as never);
      await expect(
        makeProvider().createOnboarding({
          associationId: 'assoc-1',
          refreshUrl: 'r',
          returnUrl: 'u',
          legalProfile,
        })
      ).rejects.toMatchObject({ status: 502, response: { code: LYDIA_BUSINESS_CREATED_UNLINKED } });
      const logged = error.mock.calls.flat().map(String).join(' | ');
      // The durable record of the orphan: its tag, the association and the vendor token.
      expect(logged).toContain(LYDIA_ORPHAN_LOG_TAG);
      expect(logged).toContain('assoc-1');
      expect(logged).toContain('vendor_token=vendor-token-xyz');
      expect(logged).not.toContain('throwaway-wrong-key');
      jest.restoreAllMocks();
    }
  );

  it('refuses a business/create answer with no api_token_id without asking auth/vendortoken', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockedAxios.post.mockResolvedValueOnce({
      data: { error: '0', api_token: 'vendor-token-xyz', dashboard_url: 'https://x.example/d' },
    });
    await expect(
      makeProvider().createOnboarding({
        associationId: 'assoc-1',
        refreshUrl: 'r',
        returnUrl: 'u',
        legalProfile,
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_BUSINESS_CREATED_UNLINKED } });
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    error.mockRestore();
  });

  /** Runs one onboarding and returns its rejection plus every ERROR line it logged. */
  async function onboardingFailure(): Promise<{ err: unknown; logged: string }> {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const err = await makeProvider()
        .createOnboarding({
          associationId: 'assoc-1',
          refreshUrl: 'r',
          returnUrl: 'u',
          legalProfile,
        })
        .then(
          () => null,
          (e: unknown) => e
        );
      return { err, logged: error.mock.calls.flat().map(String).join(' | ') };
    } finally {
      jest.restoreAllMocks();
    }
  }

  it.each([
    [
      'no answer in time',
      () =>
        Promise.reject(
          Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' })
        ),
    ],
    ['an HTTP 500', () => Promise.reject(httpError(500))],
    ['an HTTP 429, which does not say refused', () => Promise.reject(httpError(429))],
    // Observed in homologation (2026-09-20): a 200 with `{}` - no error, no api_token.
    ['a 200 with no error and no api_token', () => Promise.resolve({ data: {} })],
  ])(
    'business/create with %s is AMBIGUOUS: the typed 504 UNCONFIRMED and an [LYDIA-ORPHAN-SUSPECT] line',
    async (_label, create) => {
      mockedAxios.post.mockImplementationOnce(create as never);
      const { err, logged } = await onboardingFailure();
      expect(err).toMatchObject({
        status: 504,
        response: { code: LYDIA_BUSINESS_CREATE_UNCONFIRMED },
      });
      expect(logged).toContain(`${LYDIA_ORPHAN_SUSPECT_LOG_TAG} association assoc-1`);
      // Nothing to verify: auth/vendortoken is never asked.
      expect(mockedAxios.post.mock.calls).toHaveLength(1);
    }
  );

  it('business/create REFUSED (an error code) created nothing: the typed refusal, no suspect line', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { error: '3', message: 'Parametre invalide' } });
    const { err, logged } = await onboardingFailure();
    expect(err).toMatchObject({ status: 400, response: { code: PAYMENT_PROVIDER_REFUSED } });
    expect(logged).not.toContain(LYDIA_ORPHAN_SUSPECT_LOG_TAG);
  });

  it('an api_token with no dashboard_url is an orphan: [LYDIA-ORPHAN] and the 502 CREATED_UNLINKED', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { error: '0', api_token: 'vendor-token-xyz', api_token_id: 'throwaway-key' },
    });
    const { err, logged } = await onboardingFailure();
    expect(err).toMatchObject({ status: 502, response: { code: LYDIA_BUSINESS_CREATED_UNLINKED } });
    expect(logged).toContain(`${LYDIA_ORPHAN_LOG_TAG} association assoc-1`);
    expect(logged).toContain('vendor_token=vendor-token-xyz');
    expect(logged).not.toContain('throwaway-key');
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
  });

  it('bounds business/create and auth/vendortoken by their step budget, not the 60 s default', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          error: '0',
          api_token: 'vendor-token-xyz',
          api_token_id: 'throwaway-private-key',
          dashboard_url: 'https://lydia-app.com/console/xyz',
        },
      })
      .mockResolvedValueOnce({ data: { status: 'ok' } });
    await makeProvider().createOnboarding({
      associationId: 'assoc-1',
      refreshUrl: 'r',
      returnUrl: 'u',
      legalProfile,
    });
    const timeouts = mockedAxios.post.mock.calls.map(
      (call) => (call[2] as { timeout?: number }).timeout
    );
    expect(timeouts).toEqual([
      LYDIA_ONBOARDING_STEP_TIMEOUT_MS.create,
      LYDIA_ONBOARDING_STEP_TIMEOUT_MS.verify,
    ]);
  });

  it('the whole onboarding chain answers before nginx gives up on /api/payments', () => {
    const sum = Object.values(LYDIA_ONBOARDING_STEP_TIMEOUT_MS).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThan(PAYMENTS_PROXY_READ_TIMEOUT_MS);
  });

  it('nginx really gives /api/payments the read timeout the budget is measured against', () => {
    // The budget above is only true if nginx waits at least PAYMENTS_PROXY_READ_TIMEOUT_MS: read
    // the single source of the nginx config and fail the day someone tightens that location.
    const conf = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'infrastructure', 'local', 'Dockerfile.frontend'),
      'utf8'
    );
    const start = conf.indexOf('location /api/payments {');
    expect(start).toBeGreaterThan(-1);
    const block = conf.slice(start, conf.indexOf('}', start));
    const set = /proxy_read_timeout\s+(\d+)(ms|s|m)?\s*;/.exec(block);
    // None set: nginx's default, 60 s, is what the constant names.
    const units = { ms: 1, s: 1_000, m: 60_000 } as const;
    const effectiveMs =
      set === null ? 60_000 : Number(set[1]) * units[(set[2] ?? 's') as keyof typeof units];
    expect(effectiveMs).toBeGreaterThanOrEqual(PAYMENTS_PROXY_READ_TIMEOUT_MS);
    // And with none set, the constant must BE nginx's default, not merely below it.
    expect(set === null ? PAYMENTS_PROXY_READ_TIMEOUT_MS : effectiveMs).toBe(effectiveMs);
  });

  it('surfaces the {status, code, message} error shape, distinct from the {error, message} one', async () => {
    // The actual cause of the incident above, once logging existed to see it: a REJECTED
    // business/create (unrecognized provider_token) answers in a completely different shape from
    // every other Lydia call this class makes - no `error` key at all.
    mockedAxios.post.mockResolvedValue({
      data: { status: 'error', code: '104', message: 'Provider inconnu' },
    });

    const provider = makeProvider();
    await expect(
      provider.createOnboarding({
        associationId: 'assoc-1',
        refreshUrl: 'r',
        returnUrl: 'u',
        legalProfile,
      })
    ).rejects.toThrow(/Provider inconnu/);
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
  it('throws a clear error for live status calls', async () => {
    const provider = makeProvider();
    await expect(provider.getConnectAccountStatus('vendor-token')).rejects.toThrow(
      /live account-status poll/
    );
  });
});

describe('LydiaPaymentProvider - refusals and logs', () => {
  afterEach(() => jest.restoreAllMocks());

  const request = {
    lineItems: [{ productName: 'x', unitAmountCents: 100, quantity: 1, currency: 'eur' }],
    successUrl: 's',
    cancelUrl: 'c',
    connectAccountId: 'vendor-token-abc',
    payerRecipient: { value: 'user@example.com', type: 'email' as const },
  };

  it('throws a TYPED refusal carrying Lydia readable message, not a bare string', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { error: '104', message: "Ce lieu d'activite est temporairement bloque" },
    });
    await expect(makeProvider().createCheckoutSession(request)).rejects.toMatchObject({
      status: 400,
      response: {
        code: PAYMENT_PROVIDER_REFUSED,
        providerCode: '104',
        message: "Ce lieu d'activite est temporairement bloque",
      },
    });
  });

  it('never logs the signature Lydia answers with, but still logs the rest of the answer', async () => {
    const lines: string[] = [];
    const sink = (m: unknown) => void lines.push(String(m));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(sink);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(sink);
    mockedAxios.post.mockResolvedValue({
      data: { error: '0', request_uuid: 'REQ-VISIBLE', signature: 'SIGNATURESECRET' },
    });
    await makeProvider()
      .createCheckoutSession(request)
      .catch(() => undefined);
    const logged = lines.join(' | ');
    expect(logged).toContain('request/do');
    // CONTROL: redaction is by key, not a blanket mute - the other fields are still diagnosable.
    expect(logged).toContain('REQ-VISIBLE');
    expect(logged).not.toContain('SIGNATURESECRET');
  });

  it('redacts personal fields at ANY depth of an answer: a nested phone never reaches the log', () => {
    const redacted = redactForLog({
      error: '0',
      data: {
        cashier_phone: '+33612345678',
        cashiers: [{ phone: '+33600000099', firstname: 'Ada', lastname: 'L', name: 'Ada L' }],
        access_cashier: '1',
      },
    });
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('612345678');
    expect(text).not.toContain('600000099');
    expect(text).not.toContain('Ada');
    // CONTROL: redaction is by key, the rest stays diagnosable.
    expect(text).toContain('access_cashier');
    expect(redacted.error).toBe('0');
  });

  it('never logs the api_token_id nor a vendor_id echo (the private token) of a freshly created business', async () => {
    const lines: string[] = [];
    const sink = (m: unknown) => void lines.push(String(m));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(sink);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(sink);
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          error: '0',
          api_token: 'VENDORSECRET',
          api_token_id: 'PRIVATESECRET',
          dashboard_url: 'https://lydia-app.com/console/xyz',
        },
      })
      .mockResolvedValueOnce({ data: { status: 'ok', vendor_id: 'PRIVATESECRET' } });
    await makeProvider().createOnboarding({
      associationId: 'assoc-1',
      refreshUrl: 'r',
      returnUrl: 'u',
      legalProfile: {
        name: 'BDE Test',
        address: '1 rue',
        zipcode: '42000',
        city: 'SE',
        country: 'France',
        businessEmail: 'b@test.example',
        businessPhone: '+33100000000',
      },
    });
    const logged = lines.join(' | ');
    expect(logged).toContain('business/create');
    // The private token never; the vendor token may be logged.
    expect(logged).not.toContain('PRIVATESECRET');
  });
});

describe('LydiaPaymentProvider - a request/do refused on the Business itself (lot 2)', () => {
  beforeEach(() => mockedAxios.post.mockReset());
  afterEach(() => jest.restoreAllMocks());

  const request = {
    lineItems: [{ productName: 'x', unitAmountCents: 100, quantity: 1, currency: 'eur' }],
    successUrl: 's',
    cancelUrl: 'c',
    connectAccountId: 'vendor-token-abc',
    payerRecipient: { value: 'user@example.com', type: 'email' as const },
  };

  it.each([
    ['5', LYDIA_BUSINESS_NOT_VALIDATED],
    ['2701', LYDIA_BUSINESS_BLOCKED],
  ])('error %s is the typed %s, and no payer URL exists', async (providerCode, code) => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockedAxios.post.mockResolvedValue({ data: { error: providerCode, message: 'refused' } });
    const outcome = makeProvider().createCheckoutSession(request);
    await expect(outcome).rejects.toBeInstanceOf(BadRequestException);
    await expect(outcome).rejects.toMatchObject({
      status: 400,
      response: { code, providerCode },
    });
    // THE REVIEWER'S CONDITION: no request was issued - the answer carries no mobile_url and the
    // method resolved nothing a payer could open.
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
  });

  it('any other code keeps the generic typed refusal, unchanged', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockedAxios.post.mockResolvedValue({ data: { error: '104', message: 'Provider inconnu' } });
    await expect(makeProvider().createCheckoutSession(request)).rejects.toMatchObject({
      response: { code: PAYMENT_PROVIDER_REFUSED, providerCode: '104' },
    });
  });
});

describe('LydiaPaymentProvider.addBusinessHolder - the Responsable (lot 2)', () => {
  const PRIVATE = 'provider-private';
  const PHONE = '+33612345678';
  const allRights = Object.fromEntries(LYDIA_CASHIER_PERMISSIONS.map((n) => [n, '1']));

  function withKey() {
    return new LydiaPaymentProvider({
      LYDIA_ENV: 'homologation',
      LYDIA_PROVIDER_TOKEN: 'provider-token',
      LYDIA_PROVIDER_PRIVATE_TOKEN: PRIVATE,
    });
  }

  beforeEach(() => {
    mockedAxios.post.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    mockedAxios.post.mockReset();
  });

  it('reads the rights under the answer`s `data` object, the shape Lydia returns', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { error: '0', data: { id: '1', permission: '111', ...allRights, access_fee: '0' } },
    });
    const rights = await withKey().readCashierRights('asso-1', 'vendor-1', PHONE);
    expect(Object.values(rights).filter(Boolean)).toHaveLength(
      LYDIA_CASHIER_PERMISSIONS.length - 1
    );
    expect(rights.access_fee).toBe(false);
    // CONTROL: rights at the TOP level are not Lydia's shape: refused, never read as "no rights".
    mockedAxios.post.mockResolvedValueOnce({ data: { error: '0', ...allRights } });
    await expect(withKey().readCashierRights('asso-1', 'vendor-1', PHONE)).rejects.toMatchObject({
      status: 502,
      response: { code: LYDIA_CASHIER_READBACK_INVALID },
    });
  });

  it('signs the ENCODED cashier_phone and permissions ARRAY, asks for the SMS, then reads back', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ data: { error: '0' } })
      .mockResolvedValueOnce({ data: { error: '0', data: allRights } });
    await withKey().addBusinessHolder('asso-1', 'vendor-1', PHONE);
    expect(mockedAxios.post.mock.calls).toHaveLength(2);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toMatch(/\/api\/business\/addcashier\.json$/);
    const sent = new URLSearchParams(body as string);
    expect(JSON.parse(sent.get('permissions') ?? '')).toEqual([...LYDIA_CASHIER_PERMISSIONS]);
    expect(sent.get('notify')).toBe('yes');
    expect(sent.get('vendor_token')).toBe('vendor-1');
    expect(sent.get('cashier_phone')).toBe(PHONE);
    expect(sent.get('signature')).toBe(
      signLydiaRequest(
        { cashier_phone: PHONE, permissions: sent.get('permissions') ?? '' },
        PRIVATE
      )
    );
    expect(mockedAxios.post.mock.calls[1][0]).toMatch(/\/api\/business\/getpermission\.json$/);
  });

  it('no Provider key: 503 LYDIA_CASHIER_NOT_CONFIGURED and NO call', async () => {
    await expect(
      makeProvider().addBusinessHolder('asso-1', 'vendor-1', PHONE)
    ).rejects.toMatchObject({
      status: 503,
      response: { code: LYDIA_CASHIER_NOT_CONFIGURED },
    });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('a phone that is not E.164: 400 and NO call', async () => {
    await expect(
      withKey().addBusinessHolder('asso-1', 'vendor-1', '0612345678')
    ).rejects.toMatchObject({
      status: 400,
      response: { code: LYDIA_CASHIER_PHONE_INVALID },
    });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it.each([
    ['444', 502, LYDIA_SIGNATURE_REFUSED],
    ['3', 502, LYDIA_CASHIER_PERMISSIONS_INVALID],
    ['102', 502, LYDIA_BUSINESS_TOKEN_REJECTED],
    ['103', 502, LYDIA_BUSINESS_TOKEN_REJECTED],
  ])('error %s is %s %s', async (providerCode, status, code) => {
    mockedAxios.post.mockResolvedValue({ data: { error: providerCode, message: 'x' } });
    await expect(withKey().addBusinessHolder('asso-1', 'vendor-1', PHONE)).rejects.toMatchObject({
      status,
      response: { code },
    });
  });

  it('an HTML 500 or no answer is 503 LYDIA_UNREACHABLE (a retry is safe)', async () => {
    mockedAxios.post.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500, data: '<html>' },
      })
    );
    await expect(withKey().addBusinessHolder('asso-1', 'vendor-1', PHONE)).rejects.toMatchObject({
      status: 503,
      response: { code: LYDIA_UNREACHABLE },
    });
  });

  it('a read-back short of every right is ADDED-UNCONFIRMED, never counted as confirmed', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ data: { error: '0' } })
      .mockResolvedValueOnce({ data: { error: '0', data: { ...allRights, access_fee: '0' } } });
    const err = await withKey()
      .addBusinessHolder('asso-1', 'vendor-1', PHONE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LydiaCashierAddedUnconfirmedException);
    expect(err).toMatchObject({ status: 502, response: { code: LYDIA_CASHIER_RIGHTS_INCOMPLETE } });
  });

  it.each([
    ['a typed refusal of the read-back', { data: { error: '444', message: 'x' } }, 502],
    ['no usable answer to the read-back', new Error('socket hang up'), 503],
  ])(
    '%s after the add answered is ADDED-UNCONFIRMED, its status kept',
    async (_, second, status) => {
      mockedAxios.post.mockResolvedValueOnce({ data: { error: '0' } });
      if (second instanceof Error) mockedAxios.post.mockRejectedValueOnce(second);
      else mockedAxios.post.mockResolvedValueOnce(second);
      const err = await withKey()
        .addBusinessHolder('asso-1', 'vendor-1', PHONE)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LydiaCashierAddedUnconfirmedException);
      expect(err).toMatchObject({ status });
    }
  );

  it('a refusal of the ADD itself is never added-unconfirmed', async () => {
    mockedAxios.post.mockResolvedValue({ data: { error: '444', message: 'x' } });
    const err = await withKey()
      .addBusinessHolder('asso-1', 'vendor-1', PHONE)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(LydiaCashierAddedUnconfirmedException);
  });

  it('never logs the phone, only its last two digits', async () => {
    const lines: string[] = [];
    const sink = (m: unknown) => void lines.push(String(m));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(sink);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(sink);
    mockedAxios.post
      .mockResolvedValueOnce({ data: { error: '0' } })
      .mockResolvedValueOnce({ data: { error: '0', data: allRights } });
    await withKey().addBusinessHolder('asso-1', 'vendor-1', PHONE);
    // `postForm` logs Lydia's answer; neither answer echoes the phone, and no line of ours names it.
    expect(lines.join(' | ')).not.toContain('612345678');
    expect(lines.join(' | ')).toContain('78');
  });
});

describe('LydiaPaymentProvider - cashier roles and removal (lot 3)', () => {
  const PRIVATE = 'provider-private';
  const PHONE = '+33612345678';
  const HOLDER = '+33698765432';
  /** Five names Lydia listed on homologation beyond the documented 13 (2026-10-31). */
  const EXTRAS = [
    'access_b2c_cancel',
    'access_b2c_list',
    'access_b2c_payments',
    'access_switch_3ds',
    'access_tap2pay',
  ];
  const none = Object.fromEntries([...LYDIA_CASHIER_PERMISSIONS, ...EXTRAS].map((n) => [n, '0']));
  const rightsOf = (names: readonly string[]) => ({
    ...none,
    ...Object.fromEntries(names.map((n) => [n, '1'])),
  });
  /** The control read of the Responsable's number before a removal: 13 of 13. */
  const holderOk = { data: { error: '0', data: rightsOf(LYDIA_CASHIER_PERMISSIONS) } };

  function withKey() {
    return new LydiaPaymentProvider({
      LYDIA_ENV: 'homologation',
      LYDIA_PROVIDER_TOKEN: 'provider-token',
      LYDIA_PROVIDER_PRIVATE_TOKEN: PRIVATE,
    });
  }

  beforeEach(() => {
    mockedAxios.post.mockReset();
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => {
    jest.restoreAllMocks();
    mockedAxios.post.mockReset();
  });

  it('the three roles: Responsable all 13, Tresorier statements + refunds + cancels, Vendeur collect alone', () => {
    expect([...LYDIA_CASHIER_ROLE_PERMISSIONS.responsable]).toEqual([...LYDIA_CASHIER_PERMISSIONS]);
    expect([...LYDIA_CASHIER_ROLE_PERMISSIONS.tresorier].sort()).toEqual(
      ['access_cancelrequest', 'access_canceltransaction', 'access_statement'].sort()
    );
    expect([...LYDIA_CASHIER_ROLE_PERMISSIONS.vendeur]).toEqual(['access_collect']);
  });

  it.each(['responsable', 'tresorier', 'vendeur'] as const)(
    'a %s is added with EXACTLY its permission array, signed over the encoded values, then read back',
    async (role) => {
      mockedAxios.post.mockResolvedValueOnce({ data: { error: '0' } }).mockResolvedValueOnce({
        data: { error: '0', data: rightsOf(LYDIA_CASHIER_ROLE_PERMISSIONS[role]) },
      });
      await withKey().addCashier('asso-1', 'vendor-1', PHONE, role);
      const sent = new URLSearchParams(mockedAxios.post.mock.calls[0][1] as string);
      expect(JSON.parse(sent.get('permissions') ?? '')).toEqual([
        ...LYDIA_CASHIER_ROLE_PERMISSIONS[role],
      ]);
      expect(sent.get('notify')).toBe('yes');
      expect(sent.get('signature')).toBe(
        signLydiaRequest(
          { cashier_phone: PHONE, permissions: sent.get('permissions') ?? '' },
          PRIVATE
        )
      );
    }
  );

  it('a read-back with ONE right beyond the role is not a confirmation: added, UNCONFIRMED', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { error: '0' } }).mockResolvedValueOnce({
      data: { error: '0', data: rightsOf(['access_collect', 'access_checkout']) },
    });
    const attempt = withKey().addCashier('asso-1', 'vendor-1', PHONE, 'vendeur');
    await expect(attempt).rejects.toBeInstanceOf(LydiaCashierAddedUnconfirmedException);
    await expect(
      (async () => {
        mockedAxios.post
          .mockResolvedValueOnce({ data: { error: '0' } })
          .mockResolvedValueOnce({ data: { error: '0', data: rightsOf([]) } });
        await withKey().addCashier('asso-1', 'vendor-1', PHONE, 'vendeur');
      })()
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_RIGHTS_INCOMPLETE } });
  });

  it('an UNDOCUMENTED right at 1 for a Vendeur is a mismatch: added, UNCONFIRMED', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { error: '0' } }).mockResolvedValueOnce({
      data: { error: '0', data: rightsOf(['access_collect', 'access_tap2pay']) },
    });
    await expect(
      withKey().addCashier('asso-1', 'vendor-1', PHONE, 'vendeur')
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_RIGHTS_INCOMPLETE } });
  });

  it('a Responsable needs the documented 13; the undocumented names are neither required nor refused', async () => {
    for (const extras of [[], EXTRAS]) {
      mockedAxios.post.mockResolvedValueOnce({ data: { error: '0' } }).mockResolvedValueOnce({
        data: { error: '0', data: rightsOf([...LYDIA_CASHIER_PERMISSIONS, ...extras]) },
      });
      await expect(
        withKey().addCashier('asso-1', 'vendor-1', PHONE, 'responsable')
      ).resolves.toBeUndefined();
    }
    mockedAxios.post.mockResolvedValueOnce({ data: { error: '0' } }).mockResolvedValueOnce({
      data: {
        error: '0',
        data: rightsOf(LYDIA_CASHIER_PERMISSIONS.filter((n) => n !== 'access_fee')),
      },
    });
    await expect(
      withKey().addCashier('asso-1', 'vendor-1', PHONE, 'responsable')
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_RIGHTS_INCOMPLETE } });
  });

  it.each([
    [
      'a documented right missing',
      {
        error: '0',
        data: (() => {
          const data: Record<string, string> = { ...none };
          delete data.access_collect;
          return data;
        })(),
      },
    ],
    ['a value other than "0" or "1"', { error: '0', data: { ...none, access_collect: 'yes' } }],
    ['a numeric value', { error: '0', data: { ...none, access_collect: 1 } }],
    [
      'an undocumented right reading neither',
      { error: '0', data: { ...none, access_tap2pay: '' } },
    ],
    ['no error field', { data: none }],
    ['data missing', { error: '0' }],
    ['data null', { error: '0', data: null }],
    ['data an array', { error: '0', data: [] }],
    ['data a string', { error: '0', data: 'none' }],
  ])('parseCashierReading refuses %s: the typed 502 READBACK_INVALID', (_label, answer) => {
    expect(() => parseCashierReading(answer as Record<string, unknown>)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: LYDIA_CASHIER_READBACK_INVALID }),
      })
    );
  });

  it('an error other than 0 is a typed refusal, never a reading', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { error: '2', message: 'x', data: none } });
    await expect(withKey().readCashierReading('asso-1', 'vendor-1', PHONE)).rejects.toMatchObject({
      status: 502,
    });
  });

  it('a malformed read-back after an add is never a confirmation: added, UNCONFIRMED', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ data: { error: '0' } })
      .mockResolvedValueOnce({ data: { error: '0', data: { access_collect: '1' } } });
    await expect(
      withKey().addCashier('asso-1', 'vendor-1', PHONE, 'vendeur')
    ).rejects.toBeInstanceOf(LydiaCashierAddedUnconfirmedException);
  });

  it('cashierRightsDifference names exactly the rights that differ from the role', () => {
    const reading = parseCashierReading({
      error: '0',
      data: rightsOf(['access_collect', 'access_fee', 'access_tap2pay']),
    });
    expect(cashierRightsDifference(reading, 'vendeur')).toEqual(['access_fee', 'access_tap2pay']);
    expect(cashierRightsDifference(reading, 'tresorier')).toEqual([
      'access_statement',
      'access_canceltransaction',
      'access_cancelrequest',
      'access_collect',
      'access_fee',
      'access_tap2pay',
    ]);
  });

  it('a removal: the control read first, then the removal, then a re-read at 0 - confirmed', async () => {
    mockedAxios.post
      .mockResolvedValueOnce(holderOk)
      .mockResolvedValueOnce({ data: { error: '0' } })
      .mockResolvedValueOnce({ data: { error: '0', data: none } });
    await expect(withKey().removeCashier('asso-1', 'vendor-1', HOLDER, PHONE)).resolves.toEqual({
      verified: true,
      held: 0,
    });
    const urls = mockedAxios.post.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toMatch(/\/api\/business\/getpermission\.json$/);
    expect(
      new URLSearchParams(mockedAxios.post.mock.calls[0][1] as string).get('cashier_phone')
    ).toBe(HOLDER);
    expect(urls[1]).toMatch(/\/api\/business\/removecashier\.json$/);
    expect(
      Object.fromEntries(new URLSearchParams(mockedAxios.post.mock.calls[1][1] as string))
    ).toEqual({
      vendor_token: 'vendor-1',
      phone: HOLDER,
      cashier_phone: PHONE,
    });
    expect(urls[2]).toMatch(/\/api\/business\/getpermission\.json$/);
  });

  it('the control read short of 13: the typed 409 HOLDER_RIGHTS_MISSING, and nothing is removed', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        error: '0',
        data: rightsOf(LYDIA_CASHIER_PERMISSIONS.filter((n) => n !== 'access_cashier')),
      },
    });
    await expect(
      withKey().removeCashier('asso-1', 'vendor-1', HOLDER, PHONE)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_CASHIER_HOLDER_RIGHTS_MISSING },
    });
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
  });

  it('the control read malformed or unanswered: refused before any removal', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { error: '0', data: null } });
    await expect(
      withKey().removeCashier('asso-1', 'vendor-1', HOLDER, PHONE)
    ).rejects.toMatchObject({
      response: { code: LYDIA_CASHIER_READBACK_INVALID },
    });
    mockedAxios.post.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      withKey().removeCashier('asso-1', 'vendor-1', HOLDER, PHONE)
    ).rejects.toMatchObject({
      response: { code: LYDIA_UNREACHABLE },
    });
    expect(
      mockedAxios.post.mock.calls.filter(([url]) => String(url).includes('removecashier'))
    ).toHaveLength(0);
  });

  it('a removal whose re-read still shows a right - documented or not - is NOT confirmed', async () => {
    for (const left of ['access_collect', 'access_tap2pay']) {
      mockedAxios.post
        .mockResolvedValueOnce(holderOk)
        .mockResolvedValueOnce({ data: { error: '0' } })
        .mockResolvedValueOnce({ data: { error: '0', data: rightsOf([left]) } });
      await expect(withKey().removeCashier('asso-1', 'vendor-1', HOLDER, PHONE)).resolves.toEqual({
        verified: false,
        held: 1,
      });
    }
  });

  it('a removal whose re-read cannot be trusted is NOT confirmed (held unknown)', async () => {
    mockedAxios.post
      .mockResolvedValueOnce(holderOk)
      .mockResolvedValueOnce({ data: { error: '0' } })
      .mockResolvedValueOnce({ data: { error: '0' } });
    await expect(withKey().removeCashier('asso-1', 'vendor-1', HOLDER, PHONE)).resolves.toEqual({
      verified: false,
      held: null,
    });
  });

  it('a refused removal of a number that holds nothing reads 0 rights: confirmed by the re-read', async () => {
    mockedAxios.post
      .mockResolvedValueOnce(holderOk)
      .mockResolvedValueOnce({ data: { error: '2', message: 'x' } })
      .mockResolvedValueOnce({ data: { error: '0', data: none } });
    await expect(withKey().removeCashier('asso-1', 'vendor-1', HOLDER, PHONE)).resolves.toEqual({
      verified: true,
      held: 0,
    });
  });

  it('a re-read that fails is NOT confirmed (held unknown), never a throw', async () => {
    mockedAxios.post
      .mockResolvedValueOnce(holderOk)
      .mockResolvedValueOnce({ data: { error: '0' } })
      .mockRejectedValueOnce(new Error('socket hang up'));
    await expect(withKey().removeCashier('asso-1', 'vendor-1', HOLDER, PHONE)).resolves.toEqual({
      verified: false,
      held: null,
    });
  });

  it('no Provider key: the removal is refused before any call', async () => {
    await expect(
      new LydiaPaymentProvider({ LYDIA_ENV: 'homologation' }).removeCashier(
        'asso-1',
        'vendor-1',
        HOLDER,
        PHONE
      )
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_NOT_CONFIGURED } });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });
});
