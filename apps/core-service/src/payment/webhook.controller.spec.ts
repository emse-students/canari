import axios from 'axios';
import Stripe from 'stripe';
import type { Request, Response } from 'express';
import { PaymentWebhookController } from './webhook.controller';
import { STRIPE_API_VERSION } from './stripe-api-version';
import type { PaymentService } from './payment.service';
import type { UsersService } from '../users/users.service';
import type { ConfigService } from '@nestjs/config';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function makeController(verified: boolean) {
  const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
  const usersService = {} as UsersService;
  const paymentService = {
    verifyLydiaRequestCallback: jest.fn().mockReturnValue(verified),
  } as unknown as PaymentService;
  return new PaymentWebhookController(config, usersService, paymentService);
}

describe('PaymentWebhookController.handleLydiaRequestCallback', () => {
  afterEach(() => jest.clearAllMocks());

  it('rejects an invalid outcome', async () => {
    const controller = makeController(true);
    await expect(
      controller.handleLydiaRequestCallback('bogus', { request_id: 'r1', sig: 's1' })
    ).rejects.toThrow(/outcome/);
  });

  it('rejects a callback missing request_id or sig', async () => {
    const controller = makeController(true);
    await expect(controller.handleLydiaRequestCallback('confirm', {})).rejects.toThrow(
      /request_id|sig/
    );
  });

  it('rejects a callback with an invalid signature, without touching social-service', async () => {
    const controller = makeController(false);
    await expect(
      controller.handleLydiaRequestCallback('confirm', {
        request_id: 'r1',
        order_ref: 'form:sub-1',
        sig: 'bad-sig',
      })
    ).rejects.toThrow(/signature/);
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('marks a form submission paid on a confirmed form order_ref', async () => {
    mockedAxios.post.mockResolvedValue({ data: {} });
    const controller = makeController(true);

    const result = await controller.handleLydiaRequestCallback('confirm', {
      request_id: 'r1',
      order_ref: 'form:sub-1',
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/submissions/sub-1/mark-paid');
    expect(body).toEqual({ sessionId: 'r1' });
  });

  it('fulfills a boutique purchase on a confirmed product order_ref', async () => {
    mockedAxios.post.mockResolvedValue({ data: {} });
    const controller = makeController(true);

    await controller.handleLydiaRequestCallback('confirm', {
      request_id: 'r1',
      amount: '12.34',
      order_ref: `product:${PRODUCT_ID}:${USER_ID}`,
      sig: 'valid-sig',
    });

    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain(`/products/${PRODUCT_ID}/purchase-completed`);
    expect(body).toEqual({ userId: USER_ID, amountCents: 1234, paymentIntentId: 'r1' });
  });

  it('cancels a pending submission on a cancelled/expired form order_ref', async () => {
    mockedAxios.post.mockResolvedValue({ data: {} });
    const controller = makeController(true);

    await controller.handleLydiaRequestCallback('expire', {
      request_id: 'r1',
      order_ref: 'form:sub-1',
      sig: 'valid-sig',
    });

    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/submissions/sub-1/cancel-pending');
  });

  it('does nothing on a cancelled/expired product order_ref - no pending row exists to undo', async () => {
    const controller = makeController(true);

    const result = await controller.handleLydiaRequestCallback('cancel', {
      request_id: 'r1',
      order_ref: `product:${PRODUCT_ID}:${USER_ID}`,
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('acknowledges but does not act on an unrecognized order_ref', async () => {
    const controller = makeController(true);

    const result = await controller.handleLydiaRequestCallback('confirm', {
      request_id: 'r1',
      order_ref: 'something-unknown',
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });
});

/**
 * The Stripe half, and the reason it is here at all.
 *
 * Every webhook this service received was rejected for fourteen hours - 24 deliveries, 0 accepted -
 * on `SubtleCryptoProvider cannot be used in a synchronous context`. The runtime is `bun
 * dist/main.js`, bun matches the `worker` export condition, and stripe-node maps that to its web
 * build, whose crypto provider has no synchronous digest and throws by design.
 *
 * NOTE WHAT THAT MEANS FOR THIS FILE: jest runs on node, where the SAME sdk resolves the NODE
 * build, and the synchronous call these tests replaced would have passed here. A test that only
 * signs and verifies therefore cannot catch this class - so the first test below pins the
 * PROVIDER-dependent fact itself, with the provider production actually resolves.
 */
describe('PaymentWebhookController Stripe signature verification', () => {
  const SECRET = 'whsec_test_secret_for_signature_verification';
  const KEY = 'sk_test_0000000000000000000000000';

  function makeStripeController() {
    const config = {
      get: jest.fn((name: string) =>
        name === 'STRIPE_SECRET_KEY' ? KEY : name === 'STRIPE_WEBHOOK_SECRET' ? SECRET : undefined
      ),
    } as unknown as ConfigService;
    return new PaymentWebhookController(
      config,
      {} as UsersService,
      {} as unknown as PaymentService
    );
  }

  function makeResponse() {
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res as unknown as Response & typeof res;
  }

  // An event type the handler recognises but acts on in no branch, so this exercises the
  // verification and the acknowledgement, and nothing in between.
  const payload = JSON.stringify({
    id: 'evt_test',
    object: 'event',
    type: 'payment_intent.created',
    data: { object: { id: 'pi_test', object: 'payment_intent' } },
  });

  it('the provider bun resolves REFUSES the synchronous call and accepts the async one', async () => {
    const stripe = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION });
    const subtle = Stripe.createSubtleCryptoProvider();
    // `generateTestHeaderString` is synchronous too, and fails on this provider for the same
    // reason the verification did. Its async twin is the one that works with either.
    const header = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: SECRET,
      cryptoProvider: subtle,
    });

    // This is the throw that rejected every webhook. It is asserted, not avoided: if a later
    // edit puts `constructEvent` back, the controller test below goes green on node and only
    // this one says why production would not.
    expect(() =>
      stripe.webhooks.constructEvent(payload, header, SECRET, undefined, subtle)
    ).toThrow(/synchronous context/);

    const event = await stripe.webhooks.constructEventAsync(
      payload,
      header,
      SECRET,
      undefined,
      subtle
    );
    expect(event.type).toBe('payment_intent.created');
  });

  it('accepts a correctly signed webhook', async () => {
    const controller = makeStripeController();
    const stripe = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });

    const res = makeResponse();
    await controller.handle(
      { headers: { 'stripe-signature': header }, body: Buffer.from(payload) } as unknown as Request,
      res
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('rejects a webhook whose signature does not match the body', async () => {
    const controller = makeStripeController();
    const stripe = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION });
    const header = stripe.webhooks.generateTestHeaderString({
      payload: JSON.stringify({ id: 'evt_other', object: 'event', type: 'payment_intent.created' }),
      secret: SECRET,
    });

    const res = makeResponse();
    await controller.handle(
      { headers: { 'stripe-signature': header }, body: Buffer.from(payload) } as unknown as Request,
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).not.toHaveBeenCalled();
  });
});
