import axios from 'axios';
import { BadRequestException, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LYDIA_CALL_TIMEOUT_MS,
  LYDIA_MAX_AMOUNT_CENTS,
  LYDIA_MIN_AMOUNT_CENTS,
  LydiaPaymentProvider,
  PAYMENT_PROVIDER_REFUSED,
} from './lydia-payment-provider';

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

  it('throws rather than silently returning undefined fields when Lydia answers with neither an error nor api_token/dashboard_url', async () => {
    // Observed in homologation (2026-09-20): a 200 with `{}` - no `error`, no `api_token`, no
    // `dashboard_url`. Nothing in `postForm` treats that as a failure, so it used to fall through
    // as { url: undefined, accountId: undefined }, which the controller then serialized as `{}` -
    // a "successful" onboarding call the treasurer had no way to tell apart from a real one.
    mockedAxios.post.mockResolvedValue({ data: {} });

    const provider = makeProvider();
    await expect(
      provider.createOnboarding({
        associationId: 'assoc-1',
        refreshUrl: 'r',
        returnUrl: 'u',
        legalProfile,
      })
    ).rejects.toThrow(/api_token\/dashboard_url/);
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
      data: { error: '5', message: "Ce lieu d'activite est temporairement bloque" },
    });
    await expect(makeProvider().createCheckoutSession(request)).rejects.toMatchObject({
      status: 400,
      response: {
        code: PAYMENT_PROVIDER_REFUSED,
        providerCode: '5',
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

  it('never logs the api_token or api_token_id of a freshly created business', async () => {
    const lines: string[] = [];
    const sink = (m: unknown) => void lines.push(String(m));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(sink);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(sink);
    mockedAxios.post.mockResolvedValue({
      data: {
        error: '0',
        api_token: 'VENDORSECRET',
        api_token_id: 'PRIVATESECRET',
        dashboard_url: 'https://lydia-app.com/console/xyz',
      },
    });
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
    expect(logged).not.toMatch(/VENDORSECRET|PRIVATESECRET/);
  });
});
