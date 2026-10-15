import axios from 'axios';
import * as bodyParser from 'body-parser';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PaymentWebhookController,
  describeContentType,
  describeFieldNames,
} from './webhook.controller';
import { LydiaPaymentProvider } from './lydia-payment-provider';
import { signLydiaParams } from './lydia-signature';
import { PaymentService } from './payment.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function makeController(verified: boolean) {
  const paymentService = {
    verifyLydiaRequestCallback: jest.fn().mockReturnValue(verified),
    observeLydiaRequestCallback: jest.fn().mockReturnValue('observe: stub'),
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
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/submissions/sub-1/cancel-pending');
    // The report names Lydia's request, so social-service can ignore one a retry replaced.
    expect(body).toEqual({ requestId: 'r1' });
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
    expect(line).toContain('2 field(s)=[amount,note]');
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
      providers: [
        {
          provide: PaymentService,
          useValue: {
            verifyLydiaRequestCallback: verify,
            observeLydiaRequestCallback: () => 'observe: stub',
          },
        },
      ],
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

describe('a multipart callback through the REAL signature check', () => {
  const PRIVATE = 'test-provider-private-token';
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const provider = new LydiaPaymentProvider({ LYDIA_PROVIDER_PRIVATE_TOKEN: PRIVATE });
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
      providers: [
        {
          provide: PaymentService,
          useValue: {
            verifyLydiaRequestCallback: (f: Record<string, string>, sig: string) =>
              provider.verifyRequestCallback(f, sig),
            observeLydiaRequestCallback: (f: Record<string, string>, sig: string) =>
              provider.observeRequestCallback(f, sig),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());

  const signed = {
    request_id: '12115504',
    amount: '5.00',
    currency: 'EUR',
    order_ref: 'unknown-ref',
    vendor_token: '6ac36045f16e4830718291',
  };
  const post = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return fetch(`${baseUrl}/payments/lydia-request-callback?outcome=expire`, {
      method: 'POST',
      body: form,
    });
  };

  it('accepts a correctly signed multipart body with the fields Lydia sends', async () => {
    const res = await post({
      ...signed,
      sig: signLydiaParams(signed, PRIVATE),
      state: '3',
      request_uuid: 'abcdef',
    });
    expect(await res.json()).toEqual({ received: true });
  });

  it('refuses the same body with a wrong signature', async () => {
    const res = await post({ ...signed, sig: signLydiaParams(signed, 'another-token') });
    expect((await res.json()).message).toBe('Invalid signature');
  });

  it('refuses a body with more fields than the route allows, before any verification', async () => {
    const many: Record<string, string> = { ...signed, sig: 'x' };
    for (let i = 0; i < 30; i++) many[`extra${i}`] = '1';
    const res = await post(many);
    expect(res.status).toBe(400);
  });
});

describe('a callback that fails verification says which fields it carried', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs the received and the verified field names, never a value', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = makeController(false);

    await expect(
      controller.handleLydiaRequestCallback(
        'cancel',
        { request_id: '9', sig: 'abc', order_ref: 'form:secret-ref', amount: '5.00', state: '3' },
        'multipart/form-data; boundary=x'
      )
    ).rejects.toThrow(/Invalid signature/);

    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line).toContain('outcome=cancel');
    expect(line).toContain('5 field(s)=[request_id,sig,order_ref,amount,state]');
    expect(line).toContain('verified-over=[request_id,amount,currency,order_ref,vendor_token]');
    expect(line).not.toContain('secret-ref');
    expect(line).not.toContain('abc');
  });
});
