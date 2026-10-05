import axios from 'axios';
import { PaymentController, SESSION_ID_RE } from './payment.controller';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import type { PaymentService } from './payment.service';
import type { UsersService } from '../users/users.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('SESSION_ID_RE', () => {
  it('accepts a Stripe checkout session id', () => {
    expect(SESSION_ID_RE.test('cs_test_a1B2c3')).toBe(true);
  });

  it('accepts a Lydia request_uuid (retrieveSession() routes to whichever provider issued it)', () => {
    expect(SESSION_ID_RE.test('11111111-1111-1111-1111-111111111111')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(SESSION_ID_RE.test('not-a-session-id')).toBe(false);
    expect(SESSION_ID_RE.test('')).toBe(false);
  });
});

describe('PaymentController.createCheckout', () => {
  function makeController(createCheckoutSession: jest.Mock) {
    const paymentService = {
      isConfigured: jest.fn().mockResolvedValue(true),
      createCheckoutSession,
    } as unknown as PaymentService;
    const usersService = {} as UsersService;
    return new PaymentController(paymentService, usersService);
  }

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

  it('omits idempotencyKey when the caller does not send one (unchanged Stripe behavior)', async () => {
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
});

/**
 * WHAT `auth_request` DOES NOT DO, ASSERTED ON THE ROUTES THAT PAY FOR IT.
 *
 * Sixteen nginx locations carry `auth_request /internal/auth/verify`, and that sub-request answers
 * 200 for a logged-OUT caller too - it IDENTIFIES, it never refuses. So a payments route with no
 * guard is reachable by anybody, which is how four of them reached a LIVE Stripe account on
 * 2026-09-10. The guard is the only thing standing between the two facts, so its presence is
 * asserted here rather than assumed from a decorator being visible in a diff.
 */
describe('PaymentController - every money route is guarded', () => {
  const GUARD_METADATA = '__guards__';

  /** The guards Nest will run for `handler`, read from the metadata Nest itself reads. */
  function guardsOn(handler: string): unknown[] {
    const proto = PaymentController.prototype as unknown as Record<string, unknown>;
    const fn = proto[handler];
    return (Reflect.getMetadata(GUARD_METADATA, fn as object) as unknown[]) ?? [];
  }

  it.each([['createOnboarding'], ['createCheckout'], ['verifySession'], ['cancelSession']])(
    '%s runs NginxAuthGuard',
    (handler) => {
      expect(guardsOn(handler)).toContain(NginxAuthGuard);
    }
  );

  it('completeLydiaAccount is for a global admin, behind NginxAuthGuard', () => {
    expect(guardsOn('completeLydiaAccount')).toEqual([NginxAuthGuard, GlobalAdminGuard]);
  });
});

describe('PaymentController.createOnboarding - the check is not conditional on the field', () => {
  function makeController() {
    const paymentService = {
      isConfigured: jest.fn().mockResolvedValue(true),
    } as unknown as PaymentService;
    return new PaymentController(paymentService, {} as UsersService);
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
 * The three routes that read an association's payment account (connect-status, dashboard link,
 * Lydia validation) called social-service's `GET /associations/:id`, which answers 401 to a caller
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
    const controller = new PaymentController({} as PaymentService, {} as UsersService);

    await expect(controller.completeLydiaAccount(id)).resolves.toEqual({ ok: true });

    const [url, config] = mockedAxios.get.mock.calls[0];
    expect(url).toMatch(new RegExp(`/internal/associations/${id}/payment-account$`));
    expect(config?.headers).toMatchObject({ 'X-Internal-Secret': 'internal-secret-for-test' });
    expect(mockedAxios.post.mock.calls[0][0]).toMatch(/lydia-complete$/);
  });

  it('refuses an association with no linked Lydia account without completing anything', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: { lydiaAccountId: null } });
    const controller = new PaymentController({} as PaymentService, {} as UsersService);

    await expect(controller.completeLydiaAccount(id)).rejects.toThrow(/No Lydia account/);
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });
});
