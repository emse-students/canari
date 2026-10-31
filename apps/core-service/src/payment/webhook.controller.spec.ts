import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import * as bodyParser from 'body-parser';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  LYDIA_ENROLMENT_PENDING,
  PaymentWebhookController,
  describeContentType,
  describeFieldNames,
} from './webhook.controller';
import { signLydiaParams } from './lydia-signature';
import { PaymentService } from './payment.service';
import type { LydiaCallbackVerdict } from './lydia-callback-verification';
import type { PlatformService } from '../platform/platform.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const VENDOR = 'vendor-token-of-asso-a';
// The order_ref names the checkout ATTEMPT (migration 101), never the buyer.
const CHECKOUT_ID = '33333333-3333-3333-3333-333333333333';

function makeController(verdict: LydiaCallbackVerdict) {
  const paymentService = {
    verifyLydiaRequestCallback: jest.fn().mockResolvedValue(verdict),
  } as unknown as PaymentService;
  return new PaymentWebhookController(paymentService);
}

const VERIFIED: LydiaCallbackVerdict = { verified: true, vendorToken: VENDOR };
const REFUSED: LydiaCallbackVerdict = { verified: false, reason: 'mismatch' };

describe('PaymentWebhookController.handleLydiaRequestCallback', () => {
  afterEach(() => jest.clearAllMocks());

  it('rejects an invalid outcome', async () => {
    const controller = makeController(VERIFIED);
    await expect(
      controller.handleLydiaRequestCallback('bogus', { request_id: 'r1', sig: 's1' })
    ).rejects.toThrow(/outcome/);
  });

  it('rejects a callback missing request_id or sig', async () => {
    const controller = makeController(VERIFIED);
    await expect(controller.handleLydiaRequestCallback('confirm', {})).rejects.toThrow(
      /request_id|sig/
    );
  });

  it('rejects a callback with an invalid signature, without touching social-service', async () => {
    const controller = makeController(REFUSED);
    await expect(
      controller.handleLydiaRequestCallback('confirm', {
        request_id: 'r1',
        order_ref: 'form:sub-1',
        sig: 'bad-sig',
      })
    ).rejects.toThrow(/Invalid signature/);
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('answers 503, not a verdict, when the key cannot be read', async () => {
    const paymentService = {
      verifyLydiaRequestCallback: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as PaymentService;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = new PaymentWebhookController(paymentService);
    await expect(
      controller.handleLydiaRequestCallback('confirm', { request_id: 'r1', sig: 's' })
    ).rejects.toThrow(/verification unavailable/);
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('hands a confirmed form to social-service as a TRIGGER naming the verified Business', async () => {
    mockedAxios.post.mockResolvedValue({ data: { outcome: 'paid' } });
    const controller = makeController(VERIFIED);

    const result = await controller.handleLydiaRequestCallback('confirm', {
      request_id: 'r1',
      amount: '999.00',
      order_ref: 'form:sub-1',
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/internal/forms/submissions/sub-1/provider-confirm');
    // No amount crosses: the row settles from its own request, read at Lydia.
    expect(body).toEqual({ vendorToken: VENDOR, requestId: 'r1' });
  });

  // One order_ref per request (Lydia refuses a reused one, error 3): the attempt part names the
  // request, the row is still the submission, for a confirm and a cancel alike.
  it.each([
    ['confirm', 'provider-confirm', { vendorToken: VENDOR, requestId: 'r1' }],
    ['cancel', 'cancel-pending', { requestId: 'r1', vendorToken: VENDOR }],
  ])('hands a per-request form %s to the submission it names', async (outcome, route, expected) => {
    mockedAxios.post.mockResolvedValue({ data: { outcome: 'open' } });
    const controller = makeController(VERIFIED);
    await expect(
      controller.handleLydiaRequestCallback(outcome, {
        request_id: 'r1',
        order_ref: 'form:sub-1:0a1b2c3d',
        sig: 'valid-sig',
      })
    ).resolves.toEqual({ received: true });
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain(`/internal/forms/submissions/sub-1/${route}`);
    expect(body).toEqual(expected);
  });

  it('answers a retryable 503 when social-service could not read the row request, so nothing claims it was handled', async () => {
    mockedAxios.post.mockResolvedValue({ data: { outcome: 'unreadable' } });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = makeController(VERIFIED);
    await expect(
      controller.handleLydiaRequestCallback('confirm', {
        request_id: 'r1',
        order_ref: 'form:sub-1',
        sig: 'valid-sig',
      })
    ).rejects.toMatchObject({ status: 503, message: 'Failed to process callback' });
  });

  it('answers a retryable 503 when the fan-out to social-service fails', async () => {
    mockedAxios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = makeController(VERIFIED);
    await expect(
      controller.handleLydiaRequestCallback('expire', {
        request_id: 'r1',
        order_ref: 'form:sub-1',
        sig: 'valid-sig',
      })
    ).rejects.toMatchObject({ status: 503 });
  });

  it('hands a verified product confirm to social-service as a TRIGGER naming the attempt and the verified Business', async () => {
    mockedAxios.post.mockResolvedValue({ data: { outcome: 'paid' } });
    const controller = makeController(VERIFIED);

    const result = await controller.handleLydiaRequestCallback('confirm', {
      request_id: 'r1',
      amount: '12.34',
      order_ref: `product:${PRODUCT_ID}:${CHECKOUT_ID}`,
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain(`/associations/products/${PRODUCT_ID}/purchase-completed`);
    // No amount and no buyer cross: the attempt row holds both, and Lydia's answer decides.
    expect(body).toEqual({ checkoutId: CHECKOUT_ID, requestId: 'r1', vendorToken: VENDOR });
  });

  it('answers a retryable 503 when social-service could not read the attempt request at Lydia', async () => {
    mockedAxios.post.mockResolvedValue({ data: { outcome: 'unreadable' } });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = makeController(VERIFIED);
    await expect(
      controller.handleLydiaRequestCallback('confirm', {
        request_id: 'r1',
        order_ref: `product:${PRODUCT_ID}:${CHECKOUT_ID}`,
        sig: 'valid-sig',
      })
    ).rejects.toMatchObject({ status: 503, message: 'Failed to process callback' });
  });

  it('never reaches social-service for a product confirm whose signature does not verify', async () => {
    const controller = makeController(REFUSED);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(
      controller.handleLydiaRequestCallback('confirm', {
        request_id: 'r1',
        order_ref: `product:${PRODUCT_ID}:${CHECKOUT_ID}`,
        sig: 'forged',
      })
    ).rejects.toThrow(/Invalid signature/);
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('cancels a pending submission naming its request and the verified Business', async () => {
    mockedAxios.post.mockResolvedValue({ data: {} });
    const controller = makeController(VERIFIED);

    await controller.handleLydiaRequestCallback('expire', {
      request_id: 'r1',
      order_ref: 'form:sub-1',
      sig: 'valid-sig',
    });

    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/submissions/sub-1/cancel-pending');
    expect(body).toEqual({ requestId: 'r1', vendorToken: VENDOR });
  });

  // A cancel is a trigger too: social-service reads the row's request at Lydia before releasing
  // the seat, and a read that failed decided nothing - Lydia must be told to retry.
  it.each(['cancel', 'expire'])(
    'answers a retryable 503 when a %s could not read the row request at Lydia',
    async (outcome) => {
      mockedAxios.post.mockResolvedValue({ data: { ok: false, outcome: 'unreadable' } });
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const controller = makeController(VERIFIED);
      await expect(
        controller.handleLydiaRequestCallback(outcome, {
          request_id: 'r1',
          order_ref: 'form:sub-1',
          sig: 'valid-sig',
        })
      ).rejects.toMatchObject({ status: 503, message: 'Failed to process callback' });
    }
  );

  it('applies nothing on a cancelled/expired product attempt - its next read at Lydia decides', async () => {
    const controller = makeController(VERIFIED);

    const result = await controller.handleLydiaRequestCallback('cancel', {
      request_id: 'r1',
      order_ref: `product:${PRODUCT_ID}:${CHECKOUT_ID}`,
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('acknowledges but does not act on an unrecognized order_ref', async () => {
    const controller = makeController(VERIFIED);

    const result = await controller.handleLydiaRequestCallback('confirm', {
      request_id: 'r1',
      order_ref: 'something-unknown',
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });
});

describe('PaymentWebhookController.handleLydiaRequestCallback - what a refusal says', () => {
  afterEach(() => jest.restoreAllMocks());

  it('names the content type and the FIELD NAMES of a body with no request_id, never a value', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = makeController(VERIFIED);

    await expect(
      controller.handleLydiaRequestCallback(
        'cancel',
        { amount: '5.00', note: 'secret-value' },
        'multipart/form-data'
      )
    ).rejects.toThrow(/request_id|sig/);

    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line).toContain('outcome=cancel');
    expect(line).toContain('content-type=multipart/form-data');
    expect(line).toContain('2 field(s)=[amount,note]');
    expect(line).not.toContain('secret-value');
  });

  it('logs the reason and the received field names of a failed verification, never a value', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = makeController({ verified: false, reason: 'no-key' });

    await expect(
      controller.handleLydiaRequestCallback(
        'cancel',
        { request_id: '9', sig: 'abc', order_ref: 'form:secret-ref', amount: '5.00' },
        'multipart/form-data; boundary=x'
      )
    ).rejects.toThrow(/Invalid signature/);

    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line).toContain('outcome=cancel');
    expect(line).toContain('reason=no-key');
    expect(line).toContain('4 field(s)=[request_id,sig,order_ref,amount]');
    expect(line).not.toContain('secret-ref');
    expect(line).not.toContain('abc');
  });
});

describe('what a refused callback may put in the log', () => {
  it('caps the names, shortens each and strips what could forge a line', () => {
    const body: Record<string, unknown> = { 'a\nERROR forged line': '1', ['x'.repeat(200)]: '2' };
    for (let i = 0; i < 40; i++) body[`k${i}`] = 'v';

    const line = describeFieldNames(body);

    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('42 field(s)=[');
    expect(line).toContain('aERRORforgedline');
    expect(line.split(',')).toHaveLength(16);
    expect(line.length).toBeLessThan(16 * 33 + 40);
  });

  it('reduces the content type to a bounded media type', () => {
    expect(describeContentType('multipart/form-data; boundary=----abc')).toBe(
      'multipart/form-data'
    );
    expect(describeContentType(undefined)).toBe('none');
    expect(describeContentType('text/x\nERROR ' + 'y'.repeat(200)).length).toBeLessThanOrEqual(48);
  });
});

/**
 * THE MEASURED SHAPE, THROUGH A REAL NEST APP AND THE REAL VERIFIER. Lydia's sandbox callback of
 * 2026-10-16 carried these seven fields as multipart/form-data, and `sig` verified with the Business
 * private token over all six others, `signed` included (payments.md). The keys here are throwaway
 * strings; social-service's key route is the only thing stubbed, and it is stubbed BY ADDRESS.
 */
describe('POST /api/payments/lydia-request-callback - the Business key, measured shape', () => {
  const BUSINESS_KEY = 'throwaway-business-key-a';
  const PROVIDER_KEY = 'throwaway-provider-key';
  const KNOWN_VENDOR = 'vendor-a';
  const NO_KEY_VENDOR = 'vendor-without-key';
  let app: INestApplication;
  let baseUrl: string;
  let keyLookups: string[];

  const callback = {
    currency: 'EUR',
    request_id: '12115504',
    amount: '5.00',
    signed: '0',
    vendor_token: KNOWN_VENDOR,
    order_ref: 'form:sub-1',
  };

  beforeAll(async () => {
    const platformService = {
      getConfig: jest.fn().mockResolvedValue({ paymentProvider: 'disabled' }),
    } as unknown as PlatformService;
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
      providers: [{ provide: PaymentService, useValue: new PaymentService(platformService) }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());

  beforeEach(() => {
    keyLookups = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    mockedAxios.post.mockReset();
    mockedAxios.post.mockImplementation(async (url: string, data?: unknown) => {
      if (url.endsWith('/api/internal/associations/lydia-callback-key')) {
        const vendorToken = (data as { vendorToken: string }).vendorToken;
        keyLookups.push(vendorToken);
        // Unknown association and no-key association answer the same, as social-service does.
        return {
          data: { businessPrivateToken: vendorToken === KNOWN_VENDOR ? BUSINESS_KEY : null },
        };
      }
      return { data: { outcome: 'paid' } };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const post = (outcome: string, fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return fetch(`${baseUrl}/payments/lydia-request-callback?outcome=${outcome}`, {
      method: 'POST',
      body: form,
    });
  };
  const fanOutCalls = () =>
    mockedAxios.post.mock.calls.filter(([url]) => !String(url).includes('lydia-callback-key'));

  it.each(['cancel', 'expire'])(
    'accepts a %s signed with the Business key over all received fields, signed included',
    async (outcome) => {
      const res = await post(outcome, {
        ...callback,
        sig: signLydiaParams(callback, BUSINESS_KEY),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ received: true });
      expect(keyLookups).toEqual([KNOWN_VENDOR]);
      expect(fanOutCalls()).toHaveLength(1);
    }
  );

  it('refuses the same body signed with the wrong key - the Provider key included', async () => {
    for (const key of ['another-throwaway-key', PROVIDER_KEY]) {
      const res = await post('expire', { ...callback, sig: signLydiaParams(callback, key) });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe('Invalid signature');
    }
    expect(fanOutCalls()).toHaveLength(0);
  });

  it('refuses a signature over another field set (the five fields assumed before the measure)', async () => {
    const { signed: _signed, currency: _currency, ...five } = callback;
    const res = await post('expire', {
      ...callback,
      sig: signLydiaParams({ ...five, currency: callback.currency }, BUSINESS_KEY),
    });
    expect((await res.json()).message).toBe('Invalid signature');
    expect(fanOutCalls()).toHaveLength(0);
  });

  it('refuses a body that dropped `signed` while its sig covered it', async () => {
    const sig = signLydiaParams(callback, BUSINESS_KEY);
    const { signed: _signed, ...withoutSigned } = callback;
    const res = await post('cancel', { ...withoutSigned, sig });
    expect((await res.json()).message).toBe('Invalid signature');
    expect(fanOutCalls()).toHaveLength(0);
  });

  it('refuses a body with an added field the sender slipped in', async () => {
    const sig = signLydiaParams(callback, BUSINESS_KEY);
    const res = await post('cancel', { ...callback, extra: '1', sig });
    expect((await res.json()).message).toBe('Invalid signature');
  });

  it('answers an unknown association and a no-key association with the SAME 400 as a bad signature', async () => {
    const unknown = { ...callback, vendor_token: 'vendor-nobody-holds' };
    const noKey = { ...callback, vendor_token: NO_KEY_VENDOR };
    const answers = await Promise.all([
      post('expire', { ...unknown, sig: signLydiaParams(unknown, BUSINESS_KEY) }),
      post('expire', { ...noKey, sig: signLydiaParams(noKey, BUSINESS_KEY) }),
      post('expire', { ...callback, sig: signLydiaParams(callback, 'wrong') }),
    ]);
    const shapes = await Promise.all(
      answers.map(async (r) => ({ status: r.status, body: await r.text() }))
    );
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[1]).toEqual(shapes[2]);
    expect(shapes[0].status).toBe(400);
    expect(fanOutCalls()).toHaveLength(0);
  });

  it('never sends the Business key back, whatever the outcome', async () => {
    const ok = await post('expire', { ...callback, sig: signLydiaParams(callback, BUSINESS_KEY) });
    const ko = await post('expire', { ...callback, sig: signLydiaParams(callback, 'wrong') });
    expect(await ok.text()).not.toContain(BUSINESS_KEY);
    expect(await ko.text()).not.toContain(BUSINESS_KEY);
  });

  it('still reads urlencoded and JSON bodies the same way', async () => {
    const fields = { ...callback, sig: signLydiaParams(callback, BUSINESS_KEY) };
    const url = `${baseUrl}/payments/lydia-request-callback?outcome=expire`;
    const encoded = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    const json = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });
    expect(await encoded.json()).toEqual({ received: true });
    expect(await json.json()).toEqual({ received: true });
  });

  it('refuses a JSON body whose value is not a string, with the same 400 and no key lookup', async () => {
    const res = await fetch(`${baseUrl}/payments/lydia-request-callback?outcome=expire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...callback, amount: { toString: 1 }, sig: 'x' }),
    });
    expect((await res.json()).message).toBe('Invalid signature');
    expect(keyLookups).toEqual([]);
  });

  it('refuses a multipart body with more fields than the route allows, before any verification', async () => {
    const many: Record<string, string> = { ...callback, sig: 'x' };
    for (let i = 0; i < 30; i++) many[`extra${i}`] = '1';
    const res = await post('expire', many);
    expect(res.status).toBe(400);
    expect(keyLookups).toEqual([]);
  });
});

describe('the cancel-pending answer core reads from social-service', () => {
  // The two halves meet over HTTP, so a test of each against its own mock stays green when one
  // renames what the other reads (the rebase of 2026-10-21 shipped social answering `{ ok }` while
  // core waited for `outcome: 'unreadable'`). This pins the word on BOTH sides to the same source.
  it('is the outcome word social-service really answers when Lydia cannot be read', () => {
    const social = readFileSync(
      join(__dirname, '..', '..', '..', 'social-service', 'src', 'forms', 'forms.service.ts'),
      'utf8'
    );
    expect(social).toContain("return { ok: state !== 'unreadable', outcome: state }");
    const core = readFileSync(join(__dirname, 'webhook.controller.ts'), 'utf8');
    expect(core).toContain("read === 'unreadable'");
  });
});

/**
 * THE business/create WEBHOOK IS UNSIGNED (lydia-api.md 5b), SO WHAT ITS POST MAY CHANGE IS DECIDED,
 * NOT INFERRED (owner, 2026-10-30, lot 2): `BUSINESS_VALIDATED` with a well-formed token reaches
 * social-service's readiness route ONCE, asking `ready: true` and nothing else; `BUSINESS_UNVALIDATED`
 * changes nothing and notifies nobody (the read of the holder, a WARN); everything else writes nothing. Every body below
 * reaches the real route through HTTP, and no PaymentService method is ever called.
 */
describe('POST /api/payments/lydia-business-webhook - VALIDATED marks ready, nothing else writes', () => {
  const LOOKUP = '/api/internal/associations/lydia-business-of-vendor-token';
  const READINESS = '/api/internal/associations/lydia-readiness';
  const ASSO = '44444444-4444-4444-4444-444444444444';
  let app: INestApplication;
  let baseUrl: string;
  /** Every PaymentService method as a spy: the route must call none of them. */
  const paymentService: Record<string, jest.Mock> = Object.fromEntries(
    Object.getOwnPropertyNames(PaymentService.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => [name, jest.fn()])
  );
  const lines: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
      providers: [{ provide: PaymentService, useValue: paymentService }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());

  beforeEach(() => {
    lines.length = 0;
    const sink = (m: unknown) => void lines.push(String(m));
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => sink(args[0]));
    }
    jest.clearAllMocks();
    mockedAxios.post.mockImplementation(async (url: string, data?: unknown) => {
      const token = (data as { vendorToken: string }).vendorToken;
      if (url.endsWith(READINESS)) {
        return {
          data:
            token === VENDOR
              ? { outcome: 'transitioned', associationId: ASSO }
              : { outcome: 'no-holder', associationId: null },
        };
      }
      if (!url.endsWith(LOOKUP)) throw new Error(`unexpected outbound POST ${url}`);
      return {
        data:
          token === VENDOR
            ? { associationId: ASSO, onboardingComplete: false }
            : { associationId: null, onboardingComplete: null },
      };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const asMultipart = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return fetch(`${baseUrl}/payments/lydia-business-webhook`, { method: 'POST', body: form });
  };
  const asUrlencoded = (fields: Record<string, string>) =>
    fetch(`${baseUrl}/payments/lydia-business-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  const posted = (suffix: string) =>
    mockedAxios.post.mock.calls.filter(([url]) => String(url).endsWith(suffix));

  /** No outbound call but the two allowed ones, no other verb, no PaymentService method. */
  function expectOnlyAllowedCalls() {
    const urls = mockedAxios.post.mock.calls.map(([url]) => String(url));
    expect(urls.every((url) => url.endsWith(LOOKUP) || url.endsWith(READINESS))).toBe(true);
    for (const verb of ['put', 'patch', 'delete', 'get'] as const) {
      expect(mockedAxios[verb]).not.toHaveBeenCalled();
    }
    expect(Object.keys(paymentService).length).toBeGreaterThan(5);
    for (const method of Object.values(paymentService)) expect(method).not.toHaveBeenCalled();
  }

  /** Nothing at all may change: the readiness route is never reached. */
  function expectNoWrite() {
    expectOnlyAllowedCalls();
    expect(posted(READINESS)).toHaveLength(0);
  }

  const inert: Array<[string, Record<string, string>]> = [
    ['BUSINESS_UNVALIDATED', { vendor_token: VENDOR, event: 'BUSINESS_UNVALIDATED' }],
    ['an unknown event', { vendor_token: VENDOR, event: 'BUSINESS_DELETED' }],
    ['no vendor_token', { event: 'BUSINESS_VALIDATED' }],
    ['a malformed vendor_token', { vendor_token: 'has a space', event: 'BUSINESS_VALIDATED' }],
    ['an empty body', {}],
  ];

  it.each(inert)('%s (multipart): 200, and nothing changes', async (_label, fields) => {
    const res = await asMultipart(fields);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expectNoWrite();
  });

  it.each(inert)('%s (urlencoded): 200, and nothing changes', async (_label, fields) => {
    const res = await asUrlencoded(fields);
    expect(res.status).toBe(200);
    expectNoWrite();
  });

  it.each([
    ['multipart', asMultipart],
    ['urlencoded', asUrlencoded],
  ] as const)(
    'BUSINESS_VALIDATED (%s) asks social-service for ready:true ONCE, with that body and no other',
    async (_label, send) => {
      const res = await send({ vendor_token: VENDOR, event: 'BUSINESS_VALIDATED' });
      expect(res.status).toBe(200);
      expectOnlyAllowedCalls();
      expect(posted(READINESS)).toHaveLength(1);
      expect(posted(READINESS)[0][1]).toEqual({
        vendorToken: VENDOR,
        ready: true,
        cause: 'webhook-validated',
      });
    }
  );

  it('extra fields (a forged sig, a "complete" claim, an association id) never reach the body sent', async () => {
    await asMultipart({
      vendor_token: VENDOR,
      event: 'BUSINESS_VALIDATED',
      sig: '0'.repeat(32),
      lydiaOnboardingComplete: 'false',
      ready: 'false',
      associationId: ASSO,
    });
    expect(posted(READINESS)).toHaveLength(1);
    expect(posted(READINESS)[0][1]).toEqual({
      vendorToken: VENDOR,
      ready: true,
      cause: 'webhook-validated',
    });
  });

  it('an unknown vendor_token is social-service`s no-holder, answered 200 at WARN, never ERROR', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const res = await asMultipart({ vendor_token: 'nobody-holds-it', event: 'BUSINESS_VALIDATED' });
    expect(res.status).toBe(200);
    expect(warn.mock.calls.flat().map(String).join(' | ')).toContain(
      'for no association of ours and no pending enrolment'
    );
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ['social-service unreachable', new Error('social unreachable')],
    [
      'a social-service 5xx',
      Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500, data: { message: 'boom' } },
      }),
    ],
    [
      'a social-service 503 without the pending code',
      Object.assign(new Error('Request failed with status code 503'), {
        response: { status: 503, data: { message: 'down' } },
      }),
    ],
  ])('a VALIDATED that could not be APPLIED (%s) answers 503 at ERROR', async (_, failure) => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockedAxios.post.mockRejectedValue(failure);
    const res = await asMultipart({ vendor_token: VENDOR, event: 'BUSINESS_VALIDATED' });
    expect(res.status).toBe(503);
    expect(error.mock.calls.flat().map(String).join(' | ')).toContain('could not be applied');
  });

  it('the PENDING enrolment token answers 503 at WARN, never ERROR', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockedAxios.post.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 503'), {
        response: { status: 503, data: { code: LYDIA_ENROLMENT_PENDING, message: 'retry' } },
      })
    );
    const res = await asMultipart({ vendor_token: VENDOR, event: 'BUSINESS_VALIDATED' });
    expect(res.status).toBe(503);
    expect(warn.mock.calls.flat().map(String).join(' | ')).toContain(
      'names the Business of an enrolment not linked yet'
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('an oversized body is refused by the bounded parser and writes nothing', async () => {
    const res = await asMultipart({
      vendor_token: 'x'.repeat(10_000),
      event: 'BUSINESS_VALIDATED',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
    expectNoWrite();
  });

  it('too many fields are refused by the bounded parser and write nothing', async () => {
    const many: Record<string, string> = { vendor_token: VENDOR, event: 'BUSINESS_VALIDATED' };
    for (let i = 0; i < 40; i++) many[`f${i}`] = 'x';
    const res = await asMultipart(many);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectNoWrite();
  });

  it('logs an applied validation naming the association, and never the vendor token', async () => {
    const info = jest.spyOn(Logger.prototype, 'log');
    await asMultipart({ vendor_token: VENDOR, event: 'BUSINESS_VALIDATED' });
    const logged = info.mock.calls.flat().map(String).join(' | ');
    expect(logged).toContain('BUSINESS_VALIDATED');
    expect(logged).toContain(ASSO);
    expect(lines.join(' | ')).not.toContain(VENDOR);
  });

  it('logs an unvalidation (nothing changed, nobody notified) and an unknown event at WARN', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    await asMultipart({ vendor_token: VENDOR, event: 'BUSINESS_UNVALIDATED' });
    await asMultipart({ vendor_token: VENDOR, event: 'SOMETHING\nFORGED' });
    const logged = warn.mock.calls.flat().map(String).join(' | ');
    expect(logged).toContain('BUSINESS_UNVALIDATED');
    expect(logged).toContain(ASSO);
    expect(logged).toContain('NOTHING changed');
    expect(logged).toContain('event=SOMETHINGFORGED');
    expect(lines.join(' | ')).not.toContain(VENDOR);
  });

  it('an UNVALIDATED whose holder cannot be read is logged and still changes nothing', async () => {
    mockedAxios.post.mockRejectedValue(new Error('social unreachable'));
    const res = await asMultipart({ vendor_token: VENDOR, event: 'BUSINESS_UNVALIDATED' });
    expect(res.status).toBe(200);
    expectNoWrite();
  });
});
