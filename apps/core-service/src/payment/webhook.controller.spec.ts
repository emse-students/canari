import axios from 'axios';
import * as bodyParser from 'body-parser';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PaymentWebhookController } from './webhook.controller';
import { PaymentService } from './payment.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function makeController(verified: boolean) {
  const paymentService = {
    verifyLydiaRequestCallback: jest.fn().mockReturnValue(verified),
  } as unknown as PaymentService;
  return new PaymentWebhookController(paymentService);
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

describe('PaymentWebhookController.handleLydiaRequestCallback - what a refusal says', () => {
  afterEach(() => jest.restoreAllMocks());

  it('names the content type and the FIELD NAMES of a body with no request_id, never a value', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = makeController(true);

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
    expect(line).toContain('fields=[amount,note]');
    expect(line).not.toContain('secret-value');
  });
});

describe('POST /api/payments/lydia-request-callback - the body types it reads', () => {
  let app: INestApplication;
  let verify: jest.Mock;
  let baseUrl: string;

  beforeAll(async () => {
    verify = jest.fn().mockReturnValue(false);
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
      providers: [{ provide: PaymentService, useValue: { verifyLydiaRequestCallback: verify } }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());
  beforeEach(() => verify.mockClear());

  const url = () => `${baseUrl}/payments/lydia-request-callback?outcome=expire`;
  const fields = {
    request_id: '9',
    amount: '5.00',
    currency: 'EUR',
    order_ref: 'form:x',
    vendor_token: 'v',
    sig: 'bad',
  };

  it('reads a multipart/form-data body (the type the global parsers drop)', async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);

    const res = await fetch(url(), { method: 'POST', body: form });

    expect(await res.json()).toMatchObject({ message: 'Invalid signature' });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ request_id: '9' }), 'bad');
  });

  it('still reads urlencoded and JSON bodies', async () => {
    const encoded = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    const json = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });

    expect((await encoded.json()).message).toBe('Invalid signature');
    expect((await json.json()).message).toBe('Invalid signature');
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
