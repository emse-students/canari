import { PaymentController, SESSION_ID_RE } from './payment.controller';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import type { PaymentService } from './payment.service';
import type { UsersService } from '../users/users.service';

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

  it.each([
    ['getActiveProvider'],
    ['createOnboarding'],
    ['createCheckout'],
    ['verifySession'],
    ['cancelSession'],
  ])('%s runs NginxAuthGuard', (handler) => {
    expect(guardsOn(handler)).toContain(NginxAuthGuard);
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
