import axios from 'axios';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PAYMENT_PROVIDER_REFUSED } from './lydia-payment-provider';
import { PaymentController, SESSION_ID_RE } from './payment.controller';
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
