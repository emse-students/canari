import axios from 'axios';
import Stripe from 'stripe';
import type { Request, Response } from 'express';
import type { ConfigService } from '@nestjs/config';
import { PaymentWebhookController } from './webhook.controller';
import { STRIPE_API_VERSION } from './stripe-api-version';
import {
  ACCOUNT_FIELDS,
  BALANCE_FIELDS,
  CHECKOUT_SESSION_FIELDS,
  HANDLED_WEBHOOK_EVENTS,
  PAYMENT_INTENT_FIELDS,
  PAYMENT_METHOD_CARD_FIELDS,
  PAYMENT_METHOD_FIELDS,
  SDK_CALLS,
} from './stripe-surface';
import type { PaymentService } from './payment.service';
import type { UsersService } from '../users/users.service';

/**
 * THE RUNTIME HALF OF THE STRIPE SURFACE GATE: a SIGNED fixture of every webhook event this service
 * handles, delivered through the production verification path.
 *
 * WHY IT EXISTS, in the words of the thing that refused to merge without it. The dependency ceiling
 * (`.github/scripts/lib/ceiling.sh`) held `stripe` back because "crossing an API version is a
 * decision about payments", and every refusal there must NAME the test that retires it (user,
 * 2026-08-31: a refusal is a statement that a gate is MISSING, never a routing decision to a human
 * queue). What it named was fixtures per API version for the events `webhook.controller.ts` handles
 * and the fields `stripe-payment-provider.ts` and `users.service.ts` read.
 *
 * THE COMPILE-TIME HALF IS IN `stripe-surface.ts` AND MUST STAY THERE. Written here first, it
 * checked nothing: `ts-jest` runs without diagnostics and `tsconfig.build.json` excludes
 * every `.spec.ts`, so a `satisfies` in this file is erased rather than compiled - measured by poisoning
 * the lists with an event Stripe has never sent and a field it has never had, which left every type
 * assertion green. Read that file for what the compiler does and does not settle.
 *
 * WHAT THIS FILE ADDS is the half no compiler can reach: that the branch reading a field still
 * fires, and posts what it is supposed to post, on a payload shaped the way Stripe shapes it.
 */

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const KEY = 'sk_test_surface';
const SECRET = 'whsec_surface';

const PRODUCT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const SUBMISSION_ID = 'sub-surface-1';
const ASSOCIATION_ID = 'asso-surface-1';

describe('the Stripe surface, pinned to the API version this service sends', () => {
  it('sends the version the SDK it is built against was cut for', () => {
    // The `satisfies` in `stripe-api-version.ts` already makes a divergence a compile error. This
    // asserts the same thing as a SENTENCE, so a reader who meets a red suite is told what moved
    // instead of reading four TS1360s about a string literal.
    const client = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION });
    expect(client.getApiField('version')).toBe(STRIPE_API_VERSION);
  });

  it('acts on five event types and no others', () => {
    // The count is asserted so a branch added to the controller without a fixture below cannot
    // pass unnoticed: this file is the census, and a census with no floor counts nothing.
    expect(HANDLED_WEBHOOK_EVENTS).toHaveLength(5);
    expect(new Set(HANDLED_WEBHOOK_EVENTS).size).toBe(HANDLED_WEBHOOK_EVENTS.length);
  });

  it('reads only fields the SDK still declares', () => {
    // Every list above is already checked by `satisfies`; naming them here keeps the runtime suite
    // and the compile-time pins from drifting apart, and asserts each list is non-empty - a typo
    // that emptied one would otherwise satisfy any key constraint vacuously.
    for (const fields of [
      CHECKOUT_SESSION_FIELDS,
      PAYMENT_INTENT_FIELDS,
      ACCOUNT_FIELDS,
      BALANCE_FIELDS,
      PAYMENT_METHOD_FIELDS,
      PAYMENT_METHOD_CARD_FIELDS,
    ]) {
      expect(fields.length).toBeGreaterThan(0);
      expect(new Set(fields).size).toBe(fields.length);
    }
  });

  it('calls only resources the SDK still exposes', () => {
    const client = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION }) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    for (const [resource, method] of SDK_CALLS) {
      expect(typeof client[resource]).toBe('object');
      expect(typeof client[resource][method]).toBe('function');
    }
    // `checkout.sessions` is nested one level deeper than the rest, so it is asserted on its own
    // rather than bent into the table's shape.
    const checkout = client.checkout as unknown as { sessions: Record<string, unknown> };
    expect(typeof checkout.sessions.create).toBe('function');
    expect(typeof checkout.sessions.retrieve).toBe('function');
  });
});

// -------------------------------------------------------------------------------------------------
// THE FIXTURES. One signed event per handled type, through the production verification path.
// -------------------------------------------------------------------------------------------------

/**
 * A fixture event, signed and delivered exactly as Stripe delivers one.
 *
 * It goes through `constructEventAsync` with a real signing secret rather than through the unsigned
 * development branch, because the unsigned branch is refused in production and a fixture that takes
 * it would prove nothing about the path a payment actually walks.
 */
async function deliver(
  controller: PaymentWebhookController,
  event: Record<string, unknown>
): Promise<{ status: jest.Mock; send: jest.Mock; json: jest.Mock }> {
  const payload = JSON.stringify(event);
  const stripe = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });

  const res = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  await controller.handle(
    { headers: { 'stripe-signature': header }, body: Buffer.from(payload) } as unknown as Request,
    res as unknown as Response
  );

  return res;
}

function makeController(users: Partial<UsersService> = {}): PaymentWebhookController {
  const config = {
    get: jest.fn((name: string) =>
      name === 'STRIPE_SECRET_KEY' ? KEY : name === 'STRIPE_WEBHOOK_SECRET' ? SECRET : undefined
    ),
  } as unknown as ConfigService;
  return new PaymentWebhookController(
    config,
    users as UsersService,
    {} as unknown as PaymentService
  );
}

/** The posted URLs, in order - the only externally visible effect of every branch below. */
function postedUrls(): string[] {
  return mockedAxios.post.mock.calls.map((call) => String(call[0]));
}

describe('a fixture of every handled event reaches its branch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.post.mockResolvedValue({ data: {} });
  });

  it('checkout.session.completed with a submission marks it paid', async () => {
    const controller = makeController();
    const res = await deliver(controller, {
      id: 'evt_surface_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_surface_1',
          object: 'checkout.session',
          amount_total: 1500,
          customer: null,
          payment_intent: 'pi_surface_1',
          payment_status: 'paid',
          metadata: { submissionId: SUBMISSION_ID },
        },
      },
    });

    expect(res.status).not.toHaveBeenCalled();
    const urls = postedUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/submissions/${SUBMISSION_ID}/mark-paid`);
    expect(mockedAxios.post.mock.calls[0][1]).toEqual({ sessionId: 'cs_surface_1' });
  });

  it('checkout.session.completed with a product fulfils the purchase and carries the amount', async () => {
    const controller = makeController();
    const res = await deliver(controller, {
      id: 'evt_surface_2',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_surface_2',
          object: 'checkout.session',
          amount_total: 17000,
          customer: null,
          payment_intent: 'pi_surface_2',
          payment_status: 'paid',
          metadata: { productId: PRODUCT_ID, userId: USER_ID },
        },
      },
    });

    expect(res.status).not.toHaveBeenCalled();
    const urls = postedUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/products/${PRODUCT_ID}/purchase-completed`);
    // `amount_total` and `payment_intent` are read straight off the session, so a shape change in
    // either arrives here as a wrong body rather than as a silent zero.
    expect(mockedAxios.post.mock.calls[0][1]).toEqual({
      userId: USER_ID,
      amountCents: 17000,
      paymentIntentId: 'pi_surface_2',
    });
  });

  it('checkout.session.completed saves the customer id onto a user that has none', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const controller = makeController({
      findOne: jest.fn().mockResolvedValue({ id: USER_ID, stripeCustomerId: null }),
      update,
    } as unknown as Partial<UsersService>);

    await deliver(controller, {
      id: 'evt_surface_3',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_surface_3',
          object: 'checkout.session',
          amount_total: 1500,
          customer: 'cus_surface_3',
          payment_intent: 'pi_surface_3',
          payment_status: 'paid',
          metadata: { submissionId: SUBMISSION_ID, userId: USER_ID },
        },
      },
    });

    expect(update).toHaveBeenCalledWith(USER_ID, { stripeCustomerId: 'cus_surface_3' });
  });

  it.each(['checkout.session.expired', 'checkout.session.async_payment_failed'] as const)(
    '%s cancels the pending submission',
    async (type) => {
      const controller = makeController();
      const res = await deliver(controller, {
        id: 'evt_surface_4',
        object: 'event',
        type,
        data: {
          object: {
            id: 'cs_surface_4',
            object: 'checkout.session',
            metadata: { submissionId: SUBMISSION_ID },
          },
        },
      });

      expect(res.status).not.toHaveBeenCalled();
      const urls = postedUrls();
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain(`/submissions/${SUBMISSION_ID}/cancel-pending`);
    }
  );

  it('payment_intent.payment_failed cancels the pending submission', async () => {
    const controller = makeController();
    const res = await deliver(controller, {
      id: 'evt_surface_5',
      object: 'event',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_surface_5',
          object: 'payment_intent',
          status: 'requires_payment_method',
          metadata: { submissionId: SUBMISSION_ID },
        },
      },
    });

    expect(res.status).not.toHaveBeenCalled();
    const urls = postedUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/submissions/${SUBMISSION_ID}/cancel-pending`);
  });

  it('account.updated completes onboarding only once charges are enabled', async () => {
    const controller = makeController();

    // The half that must NOT fire: an account that has finished no onboarding yet.
    await deliver(controller, {
      id: 'evt_surface_6',
      object: 'event',
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_surface_6',
          object: 'account',
          charges_enabled: false,
          details_submitted: false,
          type: 'standard',
          metadata: { associationId: ASSOCIATION_ID },
        },
      },
    });
    expect(postedUrls()).toHaveLength(0);

    await deliver(controller, {
      id: 'evt_surface_7',
      object: 'event',
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_surface_7',
          object: 'account',
          charges_enabled: true,
          details_submitted: true,
          type: 'standard',
          metadata: { associationId: ASSOCIATION_ID },
        },
      },
    });

    const urls = postedUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/associations/${ASSOCIATION_ID}/stripe-complete`);
  });

  it('every pinned event type has a fixture above', () => {
    // The census closes here. `HANDLED_WEBHOOK_EVENTS` is the list the compiler checks against the SDK;
    // this asserts the fixtures cover all of it, so neither half can be extended alone.
    const covered = new Set([
      'checkout.session.completed',
      'checkout.session.expired',
      'checkout.session.async_payment_failed',
      'payment_intent.payment_failed',
      'account.updated',
    ]);
    for (const type of HANDLED_WEBHOOK_EVENTS) {
      expect(covered.has(type)).toBe(true);
    }
    expect(covered.size).toBe(HANDLED_WEBHOOK_EVENTS.length);
  });
});
