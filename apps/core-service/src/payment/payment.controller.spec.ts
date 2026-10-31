import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import * as provider from './lydia-payment-provider';
import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  LYDIA_BUSINESS_CREATED_UNLINKED,
  LYDIA_ONBOARDING_STEP_TIMEOUT_MS,
  LYDIA_ORPHAN_LOG_TAG,
  PAYMENT_PROVIDER_REFUSED,
} from './lydia-payment-provider';
import {
  LYDIA_ACCOUNT_ALREADY_LINKED,
  LYDIA_BUSINESS_CHANGED,
  LYDIA_ENROLMENT_IN_FLIGHT,
  LYDIA_NO_BUSINESS,
  LYDIA_RESPONSABLE_ALREADY_SET,
  LYDIA_RESPONSABLE_NOT_A_CASHIER,
  LYDIA_RESPONSABLE_NOT_A_MEMBER,
  LYDIA_RESPONSABLE_PHONE_LOCKED,
  PAYOUT_ACCOUNT_UNREADABLE,
  PaymentController,
  SESSION_ID_RE,
} from './payment.controller';
import { LYDIA_ENROLMENT_PENDING } from './webhook.controller';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import type { PaymentService } from './payment.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/** A `request_uuid` exactly as the sandbox's `request/do` answered it on 2026-10-15 (payments.md). */
const MEASURED_REQUEST_UUID = '077f2efc5b53d37086e25a19d87ceb29';

describe('SESSION_ID_RE', () => {
  it('accepts a Lydia request_uuid as Lydia issues it: 32 hex digits, no dashes', () => {
    expect(SESSION_ID_RE.test(MEASURED_REQUEST_UUID)).toBe(true);
  });

  it('rejects garbage', () => {
    expect(SESSION_ID_RE.test('not-a-session-id')).toBe(false);
    expect(SESSION_ID_RE.test('')).toBe(false);
    // The dashed RFC 4122 shape it used to require: no Lydia request has ever had one.
    expect(SESSION_ID_RE.test('11111111-1111-1111-1111-111111111111')).toBe(false);
    // The Stripe-era `cs_...` id is no longer a session this service can have issued.
    expect(SESSION_ID_RE.test('cs_test_a1B2c3')).toBe(false);
  });
});

describe('PaymentController.createCheckout', () => {
  const SECRET = 'internal-secret-for-test';
  beforeAll(() => {
    process.env.INTERNAL_SECRET = SECRET;
  });

  /** The controller as social-service reaches it: every call carries the internal secret. */
  function makeController(createCheckoutSession: jest.Mock) {
    const paymentService = {
      isConfigured: jest.fn().mockResolvedValue(true),
      createCheckoutSession,
    } as unknown as PaymentService;
    const controller = new PaymentController(paymentService);
    const createCheckout = controller.createCheckout.bind(controller);
    return Object.assign(controller, {
      createCheckout: (body: Parameters<typeof createCheckout>[0]) => createCheckout(body, SECRET),
    });
  }

  it.each([[undefined], ['wrong-secret']])(
    'refuses a caller whose internal secret is %s, before any provider call',
    async (secret) => {
      const createCheckoutSession = jest.fn();
      const controller = new PaymentController({
        isConfigured: jest.fn().mockResolvedValue(true),
        createCheckoutSession,
      } as unknown as PaymentService);
      await expect(
        controller.createCheckout({ lineItems: [], successUrl: 's', cancelUrl: 'c' }, secret)
      ).rejects.toThrow('Forbidden');
      expect(createCheckoutSession).not.toHaveBeenCalled();
    }
  );

  it('forwards idempotencyKey to PaymentService.createCheckoutSession', async () => {
    const createCheckoutSession = jest
      .fn()
      .mockResolvedValue({ id: 'sess-1', url: 'https://example/checkout' });
    const controller = makeController(createCheckoutSession);

    await controller.createCheckout({
      lineItems: [],
      successUrl: 's',
      cancelUrl: 'c',
      idempotencyKey: 'product:p1:u1',
    });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'product:p1:u1' })
    );
  });

  it('omits idempotencyKey when the caller does not send one (unchanged behavior)', async () => {
    const createCheckoutSession = jest
      .fn()
      .mockResolvedValue({ id: 'sess-1', url: 'https://example/checkout' });
    const controller = makeController(createCheckoutSession);

    await controller.createCheckout({ lineItems: [], successUrl: 's', cancelUrl: 'c' });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: undefined })
    );
  });

  it('turns payerEmail into the payer recipient Lydia needs', async () => {
    const createCheckoutSession = jest.fn().mockResolvedValue({ id: 's', url: 'https://x' });
    const controller = makeController(createCheckoutSession);

    await controller.createCheckout({
      lineItems: [],
      successUrl: 's',
      cancelUrl: 'c',
      payerEmail: '  payer@example.com ',
    });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ payerRecipient: { value: 'payer@example.com', type: 'email' } })
    );
  });

  it('sends no recipient when no payerEmail is given', async () => {
    const createCheckoutSession = jest.fn().mockResolvedValue({ id: 's', url: 'https://x' });
    const controller = makeController(createCheckoutSession);

    await controller.createCheckout({ lineItems: [], successUrl: 's', cancelUrl: 'c' });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ payerRecipient: undefined })
    );
  });

  it('refuses a malformed payerEmail before any provider call', async () => {
    const createCheckoutSession = jest.fn();
    const controller = makeController(createCheckoutSession);

    await expect(
      controller.createCheckout({
        lineItems: [],
        successUrl: 's',
        cancelUrl: 'c',
        payerEmail: 'not-an-email',
      })
    ).rejects.toThrow(/payerEmail/);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuses a pathological payerEmail of 100k characters quickly', async () => {
    const controller = makeController(jest.fn());
    const started = Date.now();

    await expect(
      controller.createCheckout({
        lineItems: [],
        successUrl: 's',
        cancelUrl: 'c',
        payerEmail: '!@' + '!.'.repeat(50_000),
      })
    ).rejects.toThrow(/payerEmail/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('forwards the lifetime and answers the provider request id', async () => {
    const createCheckoutSession = jest
      .fn()
      .mockResolvedValue({ id: 'uuid-1', url: 'https://x', requestId: '48213' });
    const controller = makeController(createCheckoutSession);

    await expect(
      controller.createCheckout({
        lineItems: [],
        successUrl: 's',
        cancelUrl: 'c',
        expireAfterSeconds: 1800,
      })
    ).resolves.toEqual({ ok: true, url: 'https://x', id: 'uuid-1', requestId: '48213' });
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ expireAfterSeconds: 1800 })
    );
  });

  it.each([0, -1, 2.5])('refuses expireAfterSeconds %p before any provider call', async (v) => {
    const createCheckoutSession = jest.fn();
    const controller = makeController(createCheckoutSession);
    await expect(
      controller.createCheckout({
        lineItems: [],
        successUrl: 's',
        cancelUrl: 'c',
        expireAfterSeconds: v,
      })
    ).rejects.toThrow(/expireAfterSeconds/);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe('PaymentController.requestState', () => {
  const SECRET = 'internal-secret-for-test';
  const UUID = MEASURED_REQUEST_UUID;
  beforeAll(() => {
    process.env.INTERNAL_SECRET = SECRET;
  });

  // The request social-service settles before a retry, and the one a payer's return confirms
  // (`confirm-payment`), is named by the uuid Lydia issued. Refusing that shape made every settle
  // that reached here a 409 and left a payment the callback missed unconfirmed for good.
  it('answers the provider state of the named request', async () => {
    const read = jest.fn().mockResolvedValue({ state: 'paid', raw: '1' });
    const controller = new PaymentController({
      getCheckoutRequestState: read,
    } as unknown as PaymentService);
    await expect(
      controller.requestState({ sessionId: UUID, connectAccountId: 'v' }, SECRET)
    ).resolves.toEqual({ ok: true, state: 'paid', raw: '1' });
    expect(read).toHaveBeenCalledWith({ requestUuid: UUID }, 'v');
  });

  const ORDER_REF =
    'product:11111111-1111-1111-1111-111111111111:33333333-3333-3333-3333-333333333333';

  it("reads a boutique attempt by Canari's own order_ref", async () => {
    const read = jest.fn().mockResolvedValue({ state: 'not-found', raw: 'error 2' });
    const controller = new PaymentController({
      getCheckoutRequestState: read,
    } as unknown as PaymentService);
    await expect(
      controller.requestState({ orderRef: ORDER_REF, connectAccountId: 'v' }, SECRET)
    ).resolves.toEqual({ ok: true, state: 'not-found', raw: 'error 2' });
    expect(read).toHaveBeenCalledWith({ orderRef: ORDER_REF }, 'v');
  });

  it.each([
    [{ sessionId: '48213', connectAccountId: 'v' }],
    [{ sessionId: '0f8e4c3a-1b2c-4d5e-8f90-123456789abc', connectAccountId: 'v' }],
    [{ sessionId: UUID }],
    [{}],
    // A free string is never sent to Lydia as an order_ref, and a form's is not read this way.
    [{ orderRef: 'anything', connectAccountId: 'v' }],
    [{ orderRef: 'form:sub-1', connectAccountId: 'v' }],
    // Exactly one of the two.
    [{ sessionId: UUID, orderRef: ORDER_REF, connectAccountId: 'v' }],
  ])('refuses %p before any provider call', async (body) => {
    const read = jest.fn();
    const controller = new PaymentController({
      getCheckoutRequestState: read,
    } as unknown as PaymentService);
    const refused = controller.requestState(body, SECRET);
    await expect(refused).rejects.toThrow('Invalid payload');
    // A 503, a state of core: the sweep acts on a 400, and this one says nothing of the request.
    await expect(refused).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['payments switched off', 'Payments are disabled'],
    ['Lydia not configured', 'Lydia not configured'],
  ])('answers 503, never 400, when %s', async (_name, message) => {
    const controller = new PaymentController({
      getVerifiedCheckoutRequestState: jest
        .fn()
        .mockRejectedValue(new BadRequestException(message)),
    } as unknown as PaymentService);
    await expect(
      controller.requestState(
        { sessionId: UUID, connectAccountId: 'v', expectedAmountCents: 50 },
        SECRET
      )
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'PAYMENT_SERVICE_NOT_READY', message },
    });
  });

  it("keeps Lydia's typed refusal a 400 with its code: the one 400 about the request", async () => {
    const refusal = new BadRequestException({
      code: PAYMENT_PROVIDER_REFUSED,
      provider: 'lydia',
      providerCode: '2',
      message: 'Requete introuvable',
    });
    const controller = new PaymentController({
      getVerifiedCheckoutRequestState: jest.fn().mockRejectedValue(refusal),
    } as unknown as PaymentService);
    await expect(
      controller.requestState(
        { sessionId: UUID, connectAccountId: 'v', expectedAmountCents: 50 },
        SECRET
      )
    ).rejects.toBe(refusal);
  });

  it('refuses a caller without the internal secret', async () => {
    const controller = new PaymentController({} as PaymentService);
    await expect(
      controller.requestState({ sessionId: UUID, connectAccountId: 'v' }, 'wrong')
    ).rejects.toThrow('Forbidden');
  });

  it('answers a VERIFIED read when the caller names the amount it expects, signature never returned', async () => {
    const unverified = jest.fn();
    const verified = jest
      .fn()
      .mockResolvedValue({ verification: 'verified', state: 'paid', raw: '1' });
    const controller = new PaymentController({
      getCheckoutRequestState: unverified,
      getVerifiedCheckoutRequestState: verified,
    } as unknown as PaymentService);
    await expect(
      controller.requestState(
        { sessionId: UUID, connectAccountId: 'v', expectedAmountCents: 1250 },
        SECRET
      )
    ).resolves.toEqual({ ok: true, verification: 'verified', state: 'paid', raw: '1' });
    expect(verified).toHaveBeenCalledWith({ requestUuid: UUID }, 'v', 1250);
    expect(unverified).not.toHaveBeenCalled();
  });

  it.each([[0], [-5], [12.5], [Number.NaN], ['1250' as unknown as number]])(
    'refuses expectedAmountCents %p before any provider call',
    async (expectedAmountCents) => {
      const verified = jest.fn();
      const controller = new PaymentController({
        getVerifiedCheckoutRequestState: verified,
      } as unknown as PaymentService);
      await expect(
        controller.requestState(
          { sessionId: UUID, connectAccountId: 'v', expectedAmountCents },
          SECRET
        )
      ).rejects.toThrow('Invalid payload');
      expect(verified).not.toHaveBeenCalled();
    }
  );
});

describe('PaymentController.cancelRequest', () => {
  const SECRET = 'internal-secret-for-test';
  beforeAll(() => {
    process.env.INTERNAL_SECRET = SECRET;
  });

  function makeController(cancelCheckoutRequest: jest.Mock) {
    return new PaymentController({ cancelCheckoutRequest } as unknown as PaymentService);
  }

  it('cancels the named request at the Business it was issued to', async () => {
    const cancel = jest.fn().mockResolvedValue('already-settled');
    await expect(
      makeController(cancel).cancelRequest({ requestId: '48213', connectAccountId: 'v' }, SECRET)
    ).resolves.toEqual({ ok: true, outcome: 'already-settled' });
    expect(cancel).toHaveBeenCalledWith('48213', 'v');
  });

  it.each([
    [{ requestId: 'uuid-1', connectAccountId: 'v' }],
    [{ requestId: '48213', connectAccountId: ' ' }],
    [{}],
  ])('refuses %p before any provider call', async (body) => {
    const cancel = jest.fn();
    const refused = makeController(cancel).cancelRequest(body, SECRET);
    await expect(refused).rejects.toThrow('Invalid payload');
    await expect(refused).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('answers 503 when payments are switched off: a cancel that was not sent is no refusal', async () => {
    const cancel = jest.fn().mockRejectedValue(new BadRequestException('Payments are disabled'));
    await expect(
      makeController(cancel).cancelRequest({ requestId: '1', connectAccountId: 'v' }, SECRET)
    ).rejects.toMatchObject({ status: 503 });
  });

  it('refuses a caller without the internal secret', async () => {
    const cancel = jest.fn();
    await expect(
      makeController(cancel).cancelRequest({ requestId: '1', connectAccountId: 'v' }, 'wrong')
    ).rejects.toThrow('Forbidden');
    expect(cancel).not.toHaveBeenCalled();
  });
});

/**
 * WHAT `auth_request` DOES NOT DO, ASSERTED ON THE ROUTES THAT PAY FOR IT.
 *
 * Sixteen nginx locations carry `auth_request /internal/auth/verify`, and that sub-request answers
 * 200 for a logged-OUT caller too - it IDENTIFIES, it never refuses. So a payments route with no
 * guard is reachable by anybody, which is how four of them reached a LIVE payment account on
 * 2026-09-10 (Stripe, then; the processor has since left). The guard is the only thing standing
 * between the two facts, so its presence is asserted here rather than assumed from a decorator being visible in a diff.
 */
describe('PaymentController - every money route is guarded', () => {
  // `createCheckout` is not here on purpose: social-service calls it past nginx, so it checks the
  // internal secret instead (tested above).
  const GUARD_METADATA = '__guards__';

  /** The guards Nest will run for `handler`, read from the metadata Nest itself reads. */
  function guardsOn(handler: string): unknown[] {
    const proto = PaymentController.prototype as unknown as Record<string, unknown>;
    const fn = proto[handler];
    return (Reflect.getMetadata(GUARD_METADATA, fn as object) as unknown[]) ?? [];
  }

  it.each([['createOnboarding']])('%s runs NginxAuthGuard', (handler) => {
    expect(guardsOn(handler)).toContain(NginxAuthGuard);
  });

  it('completeLydiaAccount is for a global admin, behind NginxAuthGuard', () => {
    expect(guardsOn('completeLydiaAccount')).toEqual([NginxAuthGuard, GlobalAdminGuard]);
  });
});

describe('PaymentController.createOnboarding - the check is not conditional on the field', () => {
  function makeController() {
    const paymentService = {
      isConfigured: jest.fn().mockResolvedValue(true),
    } as unknown as PaymentService;
    return new PaymentController(paymentService);
  }

  /**
   * The defect, stated as a test: the permission check used to sit inside `if (assocId)`, so a body
   * that simply OMITTED `associationId` ran no authorization at all and went on to call the payment
   * provider. An authorization check a caller skips by leaving a field out is not a check.
   */
  it('refuses a body with no associationId instead of continuing unauthorized', async () => {
    const controller = makeController();
    const req = { headers: {} } as unknown as Parameters<typeof controller.createOnboarding>[1];

    await expect(controller.createOnboarding({ associationId: '' }, req)).rejects.toThrow(
      /associationId is required/
    );
  });

  it('still refuses an associationId that is not a UUID', async () => {
    const controller = makeController();
    const req = { headers: {} } as unknown as Parameters<typeof controller.createOnboarding>[1];

    await expect(controller.createOnboarding({ associationId: 'not-a-uuid' }, req)).rejects.toThrow(
      /Invalid associationId/
    );
  });
});

describe('PaymentController.createOnboarding - one Business per association, its key captured', () => {
  const id = 'd1f769ce-6cb6-47b8-b20b-7636f59548da';
  const req = { headers: { 'x-user-id': 'treasurer' } } as unknown as Parameters<
    PaymentController['createOnboarding']
  >[1];
  const legalProfile = {
    name: 'BDE',
    address: '1 rue',
    zipcode: '42000',
    city: 'SE',
    country: 'France',
    businessEmail: 'b@test.example',
    businessPhone: '+33100000000',
  };

  /**
   * social-service as core reads it: the manager check passes; the enrolment claim answers `claim`;
   * the release answers 200; the link runs `link`.
   */
  function socialAnswers(
    claim: { status: number; data: unknown } | (() => Promise<never>),
    link: () => Promise<unknown> = async () => ({ status: 201, data: { ok: true } })
  ) {
    mockedAxios.get.mockImplementation(async () => ({ status: 200, data: { ok: true } }));
    mockedAxios.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/lydia-enrolment-claim')) {
        return typeof claim === 'function' ? claim() : claim;
      }
      if (url.endsWith('/lydia-enrolment-release')) return { status: 200, data: { ok: true } };
      return link();
    });
  }
  const claimed = { status: 200, data: { ok: true } };

  function makeController(create?: jest.Mock) {
    const paymentService = {
      isConfigured: jest.fn().mockResolvedValue(true),
      createConnectOnboarding:
        create ??
        jest.fn().mockResolvedValue({
          url: 'https://lydia.example/console/1',
          accountId: 'vendor-new',
          businessPrivateToken: 'throwaway-private-key',
        }),
    };
    return {
      controller: new PaymentController(paymentService as unknown as PaymentService),
      paymentService,
    };
  }
  const postsTo = (suffix: string) =>
    mockedAxios.post.mock.calls.filter(([url]) => String(url).endsWith(suffix));

  afterEach(() => {
    jest.restoreAllMocks();
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
  });

  it('refuses a re-run with the TYPED 409 and never calls business/create', async () => {
    socialAnswers({ status: 409, data: { code: LYDIA_ACCOUNT_ALREADY_LINKED } });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { controller, paymentService } = makeController();
    await expect(
      controller.createOnboarding({ associationId: id, legalProfile }, req)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_ACCOUNT_ALREADY_LINKED },
    });
    expect(paymentService.createConnectOnboarding).not.toHaveBeenCalled();
  });

  it('an enrolment in flight is the TYPED 409 LYDIA_ENROLMENT_IN_FLIGHT, and no second Business', async () => {
    socialAnswers({ status: 409, data: { code: LYDIA_ENROLMENT_IN_FLIGHT } });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { controller, paymentService } = makeController();
    await expect(
      controller.createOnboarding({ associationId: id, legalProfile }, req)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_ENROLMENT_IN_FLIGHT } });
    expect(paymentService.createConnectOnboarding).not.toHaveBeenCalled();
  });

  it('a TYPED refusal of business/create releases the marker; an unconfirmed one keeps it', async () => {
    socialAnswers(claimed);
    const refused = jest.fn().mockRejectedValue(new BadRequestException({ code: 'X' }));
    await expect(
      makeController(refused).controller.createOnboarding({ associationId: id, legalProfile }, req)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postsTo('/lydia-enrolment-release')).toHaveLength(1);
    expect(postsTo('/lydia-enrolment-release')[0][1]).toEqual({ why: 'refused' });

    mockedAxios.post.mockClear();
    const unknown = jest.fn().mockRejectedValue(new GatewayTimeoutException({ code: 'Y' }));
    await expect(
      makeController(unknown).controller.createOnboarding({ associationId: id, legalProfile }, req)
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
    expect(postsTo('/lydia-enrolment-release')).toHaveLength(0);
  });

  it('links the Business WITH its key, and answers the browser the public pair only', async () => {
    socialAnswers(claimed);
    const { controller } = makeController();
    const answer = await controller.createOnboarding({ associationId: id, legalProfile }, req);
    expect(answer).toEqual({ url: 'https://lydia.example/console/1', accountId: 'vendor-new' });
    expect(JSON.stringify(answer)).not.toContain('throwaway-private-key');
    const [link] = postsTo('/lydia-account');
    expect(link[0]).toMatch(new RegExp(`/associations/${id}/lydia-account$`));
    expect(link[1]).toEqual({
      lydiaAccountId: 'vendor-new',
      lydiaDashboardUrl: 'https://lydia.example/console/1',
      businessPrivateToken: 'throwaway-private-key',
    });
  });

  it('records the pending vendor token BEFORE the link; a failure to record it is an ERROR, and the link still runs', async () => {
    const created = jest.fn(
      async (params: { onBusinessCreated?: (t: string) => Promise<void> }) => {
        await params.onBusinessCreated?.('vendor-new');
        return {
          url: 'https://lydia.example/console/1',
          accountId: 'vendor-new',
          businessPrivateToken: 'throwaway-private-key',
        };
      }
    );
    socialAnswers(claimed);
    await makeController(created).controller.createOnboarding(
      { associationId: id, legalProfile },
      req
    );
    const urls = mockedAxios.post.mock.calls.map(([url]) => String(url));
    const pending = urls.findIndex((u) => u.endsWith(`/${id}/lydia-enrolment-vendor-token`));
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(mockedAxios.post.mock.calls[pending][1]).toEqual({ vendorToken: 'vendor-new' });
    expect(pending).toBeLessThan(urls.findIndex((u) => u.endsWith('/lydia-account')));

    mockedAxios.post.mockReset();
    socialAnswers(claimed);
    const link = mockedAxios.post.getMockImplementation()!;
    mockedAxios.post.mockImplementation(async (url: string, ...rest: unknown[]) => {
      if (url.endsWith('/lydia-enrolment-vendor-token')) throw new Error('ECONNREFUSED');
      return link(url, ...rest);
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(
      makeController(created).controller.createOnboarding({ associationId: id, legalProfile }, req)
    ).resolves.toEqual({ url: 'https://lydia.example/console/1', accountId: 'vendor-new' });
    expect(error.mock.calls.flat().map(String).join(' | ')).toContain(
      'the pending Business token could not be recorded'
    );
    expect(postsTo('/lydia-account')).toHaveLength(1);
  });

  /** Every ERROR line the run produced, joined: where the orphan's record must be. */
  async function errorsDuring(run: () => Promise<unknown>): Promise<string> {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await run();
    return error.mock.calls.flat().map(String).join(' | ');
  }

  it('a link refused WITH the already-linked code is the 409, and the orphan is still logged', async () => {
    socialAnswers(claimed, async () => {
      throw Object.assign(new Error('conflict'), {
        response: { status: 409, data: { code: LYDIA_ACCOUNT_ALREADY_LINKED } },
      });
    });
    const { controller } = makeController();
    const logged = await errorsDuring(() =>
      expect(
        controller.createOnboarding({ associationId: id, legalProfile }, req)
      ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_ACCOUNT_ALREADY_LINKED } })
    );
    expect(logged).toContain(`${LYDIA_ORPHAN_LOG_TAG} association ${id}`);
    expect(logged).toContain('vendor_token=vendor-new');
    expect(logged).not.toContain('throwaway-private-key');
  });

  it.each([
    ['a 409 WITHOUT the code', { response: { status: 409, data: {} } }],
    ['a 500', { response: { status: 500, data: { message: 'boom' } } }],
    ['no answer', {}],
  ])(
    'a link failing with %s is the ONE typed 502 LYDIA_BUSINESS_CREATED_UNLINKED, orphan logged',
    async (_label, shape) => {
      socialAnswers(claimed, async () => {
        throw Object.assign(new Error('link failed'), shape);
      });
      const { controller } = makeController();
      const logged = await errorsDuring(() =>
        expect(
          controller.createOnboarding({ associationId: id, legalProfile }, req)
        ).rejects.toMatchObject({
          status: 502,
          response: { code: LYDIA_BUSINESS_CREATED_UNLINKED },
        })
      );
      expect(logged).toContain(LYDIA_ORPHAN_LOG_TAG);
      expect(logged).toContain('vendor_token=vendor-new');
      expect(logged).not.toContain('throwaway-private-key');
    }
  );

  it('an unreadable claim is a typed 503 and never reaches business/create', async () => {
    for (const claim of [
      { status: 500, data: {} },
      async () => {
        throw new Error('ECONNREFUSED');
      },
    ]) {
      socialAnswers(claim as never);
      const { controller, paymentService } = makeController();
      await errorsDuring(() =>
        expect(
          controller.createOnboarding({ associationId: id, legalProfile }, req)
        ).rejects.toMatchObject({ status: 503, response: { code: PAYOUT_ACCOUNT_UNREADABLE } })
      );
      expect(paymentService.createConnectOnboarding).not.toHaveBeenCalled();
    }
  });

  it('an unknown association is a 404 and never reaches business/create', async () => {
    socialAnswers({ status: 404, data: {} });
    const { controller, paymentService } = makeController();
    await errorsDuring(() =>
      expect(
        controller.createOnboarding({ associationId: id, legalProfile }, req)
      ).rejects.toMatchObject({ status: 404 })
    );
    expect(paymentService.createConnectOnboarding).not.toHaveBeenCalled();
  });

  it('bounds each social-service call by its step budget, so nginx never answers first', async () => {
    socialAnswers(claimed);
    const { controller } = makeController();
    await controller.createOnboarding({ associationId: id, legalProfile }, req);
    const getTimeouts = mockedAxios.get.mock.calls.map(
      ([url, config]) => [url.split('/').pop(), (config as { timeout?: number }).timeout] as const
    );
    expect(getTimeouts).toContainEqual([
      'manage-permission',
      LYDIA_ONBOARDING_STEP_TIMEOUT_MS.permission,
    ]);
    const [claim] = postsTo('/lydia-enrolment-claim');
    expect((claim[2] as { timeout?: number }).timeout).toBe(
      LYDIA_ONBOARDING_STEP_TIMEOUT_MS.payoutRead
    );
    const [link] = postsTo('/lydia-account');
    expect((link[2] as { timeout?: number }).timeout).toBe(LYDIA_ONBOARDING_STEP_TIMEOUT_MS.link);
  });
});

describe('PaymentController.setLydiaResponsable - enrolment step 2 (lot 2)', () => {
  const id = 'd1f769ce-6cb6-47b8-b20b-7636f59548da';
  const req = { headers: { 'x-user-id': 'treasurer' } } as unknown as Parameters<
    PaymentController['setLydiaResponsable']
  >[2];
  const PHONE = '+33612345678';
  const allRights = { access_cashier: true };
  type Claim = {
    vendorToken: string | null;
    member: boolean;
    currentUserId: string | null;
    phoneMatches?: boolean;
    claimed?: boolean;
  };

  /** social-service's claim answer: claimed exactly when every check passes, as the real one. */
  function claimOf(pre: Claim, userId = 'u1') {
    const phoneMatches = pre.phoneMatches ?? true;
    const claimed =
      pre.claimed ??
      (!!pre.vendorToken &&
        pre.member &&
        (!pre.currentUserId || pre.currentUserId === userId) &&
        phoneMatches);
    return { ...pre, phoneMatches, claimed };
  }

  function setup(pre: Claim) {
    mockedAxios.get.mockResolvedValue({ status: 200, data: { ok: true } });
    mockedAxios.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/lydia-responsable-claim')) return { status: 200, data: claimOf(pre) };
      if (url.endsWith('/lydia-responsable-release')) return { status: 200, data: { ok: true } };
      return { status: 200, data: { responsable: { userId: 'u1', name: 'Ada', phoneEnd: '78' } } };
    });
    const paymentService = {
      addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
      readLydiaCashierRights: jest.fn().mockResolvedValue(allRights),
    };
    return {
      controller: new PaymentController(paymentService as unknown as PaymentService),
      paymentService,
    };
  }
  const postsTo = (suffix: string) =>
    mockedAxios.post.mock.calls.filter(([url]) => String(url).endsWith(suffix));
  const stores = () => postsTo('/lydia-responsable');
  const releases = () => postsTo('/lydia-responsable-release');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
  });

  it('claims the step with the phone, adds at Lydia, THEN stores the confirmed row with the actor as adder', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: null,
    });
    const answer = await controller.setLydiaResponsable(
      id,
      { userId: 'u1', phone: PHONE, mode: 'add' },
      req
    );
    expect(postsTo('/lydia-responsable-claim')[0][1]).toEqual({ userId: 'u1', phone: PHONE });
    expect(paymentService.addLydiaBusinessHolder).toHaveBeenCalledWith(id, 'vendor-1', PHONE);
    expect(stores()[0][1]).toEqual({
      vendorToken: 'vendor-1',
      userId: 'u1',
      phone: PHONE,
      addedByUserId: 'treasurer',
      confirmed: true,
    });
    expect(answer).toEqual({
      ok: true,
      responsable: { userId: 'u1', name: 'Ada', phoneEnd: '78' },
    });
    // The store clears the claim itself; no separate release on success.
    expect(releases()).toHaveLength(0);
  });

  it('a person who is not a member is refused before any call to Lydia', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: false,
      currentUserId: null,
    });
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 400, response: { code: LYDIA_RESPONSABLE_NOT_A_MEMBER } });
    expect(paymentService.addLydiaBusinessHolder).not.toHaveBeenCalled();
    expect(stores()).toHaveLength(0);
  });

  it('no Business linked: 409 LYDIA_NO_BUSINESS', async () => {
    const { controller } = setup({ vendorToken: null, member: true, currentUserId: null });
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_NO_BUSINESS } });
  });

  it('a phone that is not E.164 is refused before anything', async () => {
    const { controller } = setup({ vendorToken: 'vendor-1', member: true, currentUserId: null });
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: '06 12', mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 400 });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('ANOTHER number for the live Responsable is the typed 409 PHONE_LOCKED, before any call to Lydia', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: 'u1',
      phoneMatches: false,
    });
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_RESPONSABLE_PHONE_LOCKED } });
    expect(paymentService.addLydiaBusinessHolder).not.toHaveBeenCalled();
    expect(stores()).toHaveLength(0);
  });

  it('the SAME number for the live Responsable is a resend: added again and stored', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: 'u1',
    });
    await controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req);
    expect(paymentService.addLydiaBusinessHolder).toHaveBeenCalledTimes(1);
    expect(stores()).toHaveLength(1);
  });

  it('a step already in flight is social-service`s typed 409, passed on, and Lydia is never called', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: null,
    });
    mockedAxios.post.mockImplementation(async () => {
      throw Object.assign(new Error('conflict'), {
        response: { status: 409, data: { code: 'LYDIA_RESPONSABLE_IN_FLIGHT' } },
      });
    });
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 409, response: { code: 'LYDIA_RESPONSABLE_IN_FLIGHT' } });
    expect(paymentService.addLydiaBusinessHolder).not.toHaveBeenCalled();
  });

  it('a TYPED refusal of the add releases the claim; no usable answer keeps it, at ERROR', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: null,
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    paymentService.addLydiaBusinessHolder.mockRejectedValueOnce(
      new BadGatewayException({ code: provider.LYDIA_SIGNATURE_REFUSED })
    );
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 502 });
    expect(releases()).toHaveLength(1);

    paymentService.addLydiaBusinessHolder.mockRejectedValueOnce(
      new ServiceUnavailableException({ code: provider.LYDIA_UNREACHABLE })
    );
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 503 });
    expect(releases()).toHaveLength(1);
    expect(error.mock.calls.flat().map(String).join(' | ')).toContain(
      "the add's outcome is unknown"
    );
    expect(stores()).toHaveLength(0);
  });

  it('added at Lydia but the read-back failed: stored UNCONFIRMED at ERROR, the original error answered', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: null,
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    for (const cause of [
      new BadGatewayException({ code: provider.LYDIA_CASHIER_RIGHTS_INCOMPLETE }),
      new BadGatewayException({ code: provider.LYDIA_SIGNATURE_REFUSED }),
      new Error('socket hang up'),
    ]) {
      paymentService.addLydiaBusinessHolder.mockRejectedValueOnce(
        new provider.LydiaCashierAddedUnconfirmedException(cause)
      );
      await expect(
        controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
      ).rejects.toMatchObject({
        status: cause instanceof BadGatewayException ? 502 : 503,
      });
    }
    expect(stores()).toHaveLength(3);
    expect(stores().map(([, body]) => (body as { confirmed: boolean }).confirmed)).toEqual([
      false,
      false,
      false,
    ]);
    // The record releases the claim; no separate release, and the phone never logged whole.
    expect(releases()).toHaveLength(0);
    const logged = error.mock.calls.flat().map(String).join(' | ');
    expect(logged).toContain('phone ending 78) added at Lydia, UNCONFIRMED - recorded');
    expect(logged).not.toContain('612345678');
  });

  it('added at Lydia, unconfirmed, and the store FAILS: the claim is kept, at ERROR', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: null,
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const claim = claimOf({ vendorToken: 'vendor-1', member: true, currentUserId: null });
    mockedAxios.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/lydia-responsable-claim')) return { status: 200, data: claim };
      throw new Error('ECONNREFUSED');
    });
    paymentService.addLydiaBusinessHolder.mockRejectedValueOnce(
      new provider.LydiaCashierAddedUnconfirmedException(
        new BadGatewayException({ code: provider.LYDIA_CASHIER_RIGHTS_INCOMPLETE })
      )
    );
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({
      status: 502,
      response: { code: provider.LYDIA_CASHIER_RIGHTS_INCOMPLETE },
    });
    expect(releases()).toHaveLength(0);
    expect(error.mock.calls.flat().map(String).join(' | ')).toContain(
      'UNCONFIRMED and NOT recorded - the step stays claimed until a global admin clears it'
    );
  });

  it('added at Lydia, unconfirmed, and the store answers 409: logs the refusal of the store, never stays-claimed', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: null,
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const claim = claimOf({ vendorToken: 'vendor-1', member: true, currentUserId: null });
    mockedAxios.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/lydia-responsable-claim')) return { status: 200, data: claim };
      throw Object.assign(new Error('409'), {
        response: { status: 409, data: { code: LYDIA_BUSINESS_CHANGED, message: 'changed' } },
      });
    });
    paymentService.addLydiaBusinessHolder.mockRejectedValueOnce(
      new provider.LydiaCashierAddedUnconfirmedException(
        new BadGatewayException({ code: provider.LYDIA_CASHIER_RIGHTS_INCOMPLETE })
      )
    );
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 502 });
    const logged = error.mock.calls.flat().map(String).join(' | ');
    expect(logged).toContain(
      `the store refused it (${LYDIA_BUSINESS_CHANGED}); claim released by the store; the unlink closed the rows`
    );
    expect(logged).not.toContain('stays claimed');
  });

  it('record mode READS the rights, never adds, refuses a number that does not manage cashiers, and releases', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: null,
    });
    paymentService.readLydiaCashierRights.mockResolvedValue({ access_cashier: false });
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'record' }, req)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_RESPONSABLE_NOT_A_CASHIER } });
    expect(paymentService.addLydiaBusinessHolder).not.toHaveBeenCalled();
    expect(stores()).toHaveLength(0);
    expect(releases()).toHaveLength(1);

    paymentService.readLydiaCashierRights.mockResolvedValue({ access_cashier: true });
    await controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'record' }, req);
    expect(paymentService.addLydiaBusinessHolder).not.toHaveBeenCalled();
    expect(stores()).toHaveLength(1);
  });

  it('a social-service REFUSAL of the store is passed on with its code; no answer is a 503 at ERROR', async () => {
    const { controller } = setup({ vendorToken: 'vendor-1', member: true, currentUserId: null });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const claim = claimOf({ vendorToken: 'vendor-1', member: true, currentUserId: null });
    mockedAxios.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/lydia-responsable-claim')) return { status: 200, data: claim };
      throw Object.assign(new Error('conflict'), {
        response: { status: 409, data: { code: LYDIA_RESPONSABLE_ALREADY_SET } },
      });
    });
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_RESPONSABLE_ALREADY_SET } });

    mockedAxios.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/lydia-responsable-claim')) return { status: 200, data: claim };
      throw new Error('ECONNREFUSED');
    });
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 503 });
    expect(error.mock.calls.flat().map(String).join(' | ')).toContain(
      'AFTER Lydia added the cashier - the step stays claimed until a global admin clears it'
    );
  });

  it('a second person while one is the Responsable is refused (changing is lot 3)', async () => {
    const { controller, paymentService } = setup({
      vendorToken: 'vendor-1',
      member: true,
      currentUserId: 'someone-else',
    });
    await expect(
      controller.setLydiaResponsable(id, { userId: 'u1', phone: PHONE, mode: 'add' }, req)
    ).rejects.toMatchObject({ status: 409 });
    expect(paymentService.addLydiaBusinessHolder).not.toHaveBeenCalled();
  });
});

/**
 * The routes that read an association's payment account (Lydia validation, once with the
 * connect-status and dashboard-link routes that are gone) called social-service's `GET /associations/:id`, which answers 401 to a caller
 * with no X-User-Id, so each reported "Association not found" for ever. They read the INTERNAL route
 * now, and this pins the URL and the secret header, which is the whole fix.
 */
describe('PaymentController.completeLydiaAccount - reads the internal payment-account route', () => {
  const id = 'd1f769ce-6cb6-47b8-b20b-7636f59548da';

  afterEach(() => jest.clearAllMocks());

  it('reads internal/associations/:id/payment-account with the internal secret, then completes', async () => {
    process.env.INTERNAL_SECRET = 'internal-secret-for-test';
    mockedAxios.get.mockResolvedValue({ status: 200, data: { lydiaAccountId: 'vendor-1' } });
    mockedAxios.post.mockResolvedValue({ status: 201, data: {} });
    const controller = new PaymentController({} as PaymentService);

    await expect(controller.completeLydiaAccount(id)).resolves.toEqual({ ok: true });

    const [url, config] = mockedAxios.get.mock.calls[0];
    expect(url).toMatch(new RegExp(`/internal/associations/${id}/payment-account$`));
    expect(config?.headers).toMatchObject({ 'X-Internal-Secret': 'internal-secret-for-test' });
    expect(mockedAxios.post.mock.calls[0][0]).toMatch(/lydia-complete$/);
  });

  it('refuses an association with no linked Lydia account without completing anything', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: { lydiaAccountId: null } });
    const controller = new PaymentController({} as PaymentService);

    await expect(controller.completeLydiaAccount(id)).rejects.toThrow(/No Lydia account/);
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });
});

describe('the Lydia codes core-service answers follow the shared contract (lot 2)', () => {
  it('every core code, and the two social codes core passes through, equal libs/contracts', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
        'utf8'
      )
    ) as { core: Record<string, string>; social: Record<string, string> };
    expect({
      businessNotValidated: provider.LYDIA_BUSINESS_NOT_VALIDATED,
      businessBlocked: provider.LYDIA_BUSINESS_BLOCKED,
      signatureRefused: provider.LYDIA_SIGNATURE_REFUSED,
      cashierPermissionsInvalid: provider.LYDIA_CASHIER_PERMISSIONS_INVALID,
      businessTokenRejected: provider.LYDIA_BUSINESS_TOKEN_REJECTED,
      cashierNotConfigured: provider.LYDIA_CASHIER_NOT_CONFIGURED,
      unreachable: provider.LYDIA_UNREACHABLE,
      cashierRightsIncomplete: provider.LYDIA_CASHIER_RIGHTS_INCOMPLETE,
      cashierPhoneInvalid: provider.LYDIA_CASHIER_PHONE_INVALID,
      responsableNotAMember: LYDIA_RESPONSABLE_NOT_A_MEMBER,
      responsableNotACashier: LYDIA_RESPONSABLE_NOT_A_CASHIER,
      noBusiness: LYDIA_NO_BUSINESS,
    }).toEqual(contract.core);
    expect(LYDIA_ENROLMENT_IN_FLIGHT).toBe(contract.social.enrolmentInFlight);
    expect(LYDIA_ENROLMENT_PENDING).toBe(contract.social.enrolmentPending);
    expect(LYDIA_RESPONSABLE_ALREADY_SET).toBe(contract.social.responsableAlreadySet);
    expect(LYDIA_RESPONSABLE_PHONE_LOCKED).toBe(contract.social.responsablePhoneLocked);
    expect(LYDIA_BUSINESS_CHANGED).toBe(contract.social.businessChanged);
  });
});
