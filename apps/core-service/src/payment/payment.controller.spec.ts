import { PaymentController, SESSION_ID_RE } from './payment.controller';
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
