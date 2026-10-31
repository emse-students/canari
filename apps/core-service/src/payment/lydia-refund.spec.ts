import axios from 'axios';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import {
  LYDIA_REFUND_NO_KEY,
  LYDIA_REFUND_NOT_ALLOWED,
  LYDIA_REFUND_REJECTED,
  LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE,
  LYDIA_REFUND_UNCONFIRMED,
  signLydiaRefund,
} from './lydia-refund';
import {
  LYDIA_BUSINESS_BLOCKED,
  LYDIA_BUSINESS_TOKEN_REJECTED,
  LYDIA_SIGNATURE_REFUSED,
  LydiaPaymentProvider,
} from './lydia-payment-provider';
import { RefundController } from './refund.controller';
import type { PaymentService } from './payment.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const ORDER_REF =
  'product:0f8e4c3a-1b2c-4d5e-8f90-123456789abc:1a2b3c4d-1b2c-4d5e-8f90-123456789abc';

function provider() {
  return new LydiaPaymentProvider({ LYDIA_ENV: 'homologation', LYDIA_PROVIDER_TOKEN: 'pt' });
}

beforeEach(() => {
  mockedAxios.post.mockReset();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the transaction/refund signature (measured on homologation 2026-10-31)', () => {
  it('is the MD5 of the RAW sorted amount and order_ref, then the Business key - the `:` not encoded', () => {
    const expected = createHash('md5')
      .update(`amount=12.50&order_ref=${ORDER_REF}&business-key`)
      .digest('hex');
    expect(signLydiaRefund(ORDER_REF, '12.50', 'business-key')).toBe(expected);
    expect(signLydiaRefund(ORDER_REF, '12.50', 'business-key')).not.toBe(
      createHash('md5')
        .update(`amount=12.50&order_ref=${ORDER_REF.replace(/:/g, '%3A')}&business-key`)
        .digest('hex')
    );
  });
});

describe('LydiaPaymentProvider.refundTransaction', () => {
  it('posts the signed refund with the amount in US format, two decimals, to the sandbox', async () => {
    mockedAxios.post.mockResolvedValue({ data: { error: '0' } });
    await provider().refundTransaction('vendor-abc', ORDER_REF, 1250, 'business-key');
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://homologation.lydia-app.com/api/transaction/refund.json');
    const sent = new URLSearchParams(body as string);
    expect([...sent.keys()].sort()).toEqual(['amount', 'order_ref', 'signature', 'vendor_token']);
    expect(sent.get('amount')).toBe('12.50');
    expect(sent.get('order_ref')).toBe(ORDER_REF);
    expect(sent.get('vendor_token')).toBe('vendor-abc');
    expect(sent.get('signature')).toBe(signLydiaRefund(ORDER_REF, '12.50', 'business-key'));
  });

  // `postForm` throws only when an error code is present: a 200 that does not say `error: "0"` must
  // never read as a refund Lydia made.
  it.each([
    ['an empty object', {}],
    ['an empty string', ''],
    ['null', null],
    ['a status without error', { status: 'ok' }],
    ['an empty error', { error: '' }],
  ])('a 200 carrying %s is UNCONFIRMED (504), never a refund', async (_name, data) => {
    mockedAxios.post.mockResolvedValue({ data });
    await expect(
      provider().refundTransaction('vendor-abc', ORDER_REF, 1250, 'business-key')
    ).rejects.toMatchObject({ status: 504, response: { code: 'LYDIA_REFUND_UNCONFIRMED' } });
  });

  it('a numeric error 0 is a confirmation too', async () => {
    mockedAxios.post.mockResolvedValue({ data: { error: 0 } });
    await expect(
      provider().refundTransaction('vendor-abc', ORDER_REF, 1250, 'business-key')
    ).resolves.toBeUndefined();
  });

  it('writes a partial amount of 50 cents as "0.50"', async () => {
    mockedAxios.post.mockResolvedValue({ data: { error: '0' } });
    await provider().refundTransaction('vendor-abc', ORDER_REF, 50, 'business-key');
    expect(new URLSearchParams(mockedAxios.post.mock.calls[0][1] as string).get('amount')).toBe(
      '0.50'
    );
  });

  it.each([
    ['2', LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE],
    ['10', LYDIA_REFUND_NOT_ALLOWED],
    ['105', LYDIA_REFUND_NOT_ALLOWED],
    ['444', LYDIA_SIGNATURE_REFUSED],
    ['103', LYDIA_BUSINESS_TOKEN_REJECTED],
    ['2701', LYDIA_BUSINESS_BLOCKED],
    ['1', LYDIA_REFUND_REJECTED],
    ['999', LYDIA_REFUND_REJECTED],
  ])('maps Lydia error %s to the typed 409 %s, never its message', async (providerCode, code) => {
    mockedAxios.post.mockResolvedValue({ data: { error: providerCode, message: 'prose' } });
    await expect(
      provider().refundTransaction('vendor-abc', ORDER_REF, 1250, 'business-key')
    ).rejects.toMatchObject({ status: 409, response: { code, providerCode } });
  });

  it('an HTTP 4xx that says refused is a refusal; a timeout or a 5xx is UNCONFIRMED (504)', async () => {
    mockedAxios.post.mockRejectedValueOnce(
      Object.assign(new Error('bad'), { response: { status: 400 } })
    );
    await expect(provider().refundTransaction('v', ORDER_REF, 100, 'k')).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_REFUND_REJECTED },
    });
    mockedAxios.post.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
    );
    await expect(provider().refundTransaction('v', ORDER_REF, 100, 'k')).rejects.toMatchObject({
      status: 504,
      response: { code: LYDIA_REFUND_UNCONFIRMED },
    });
    mockedAxios.post.mockRejectedValueOnce(
      Object.assign(new Error('bad gateway'), { response: { status: 502 } })
    );
    await expect(provider().refundTransaction('v', ORDER_REF, 100, 'k')).rejects.toMatchObject({
      status: 504,
      response: { code: LYDIA_REFUND_UNCONFIRMED },
    });
  });

  it('never writes the Business key into a log line', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    }
    mockedAxios.post.mockResolvedValue({ data: { error: '2' } });
    await provider()
      .refundTransaction('v', ORDER_REF, 100, 'secret-business-key')
      .catch(() => undefined);
    expect(lines.join('\n')).not.toContain('secret-business-key');
  });
});

describe('RefundController', () => {
  const OLD = process.env.INTERNAL_SECRET;
  beforeAll(() => (process.env.INTERNAL_SECRET = 'internal'));
  afterAll(() => (process.env.INTERNAL_SECRET = OLD));

  function controller(refund = jest.fn().mockResolvedValue(undefined)) {
    return {
      refund,
      c: new RefundController({ refundLydiaTransaction: refund } as unknown as PaymentService),
    };
  }

  it('refuses a caller without the internal secret', async () => {
    const { c, refund } = controller();
    await expect(
      c.refund({ vendorToken: 'v', orderRef: ORDER_REF, amountCents: 100 }, 'wrong')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(refund).not.toHaveBeenCalled();
  });

  it.each([
    [{ vendorToken: 'v', orderRef: 'free text', amountCents: 100 }],
    [{ vendorToken: 'v', orderRef: ORDER_REF, amountCents: 0 }],
    [{ vendorToken: 'v', orderRef: ORDER_REF, amountCents: 1.5 }],
    [{ vendorToken: '', orderRef: ORDER_REF, amountCents: 100 }],
    [{ vendorToken: 'v', orderRef: ORDER_REF, amountCents: 100_001 }],
  ])('refuses a payload it will not send (%j)', async (body) => {
    const { c, refund } = controller();
    await expect(c.refund(body, 'internal')).rejects.toBeInstanceOf(BadRequestException);
    expect(refund).not.toHaveBeenCalled();
  });

  it('passes a form order_ref and a product order_ref through', async () => {
    const { c, refund } = controller();
    await expect(
      c.refund(
        {
          vendorToken: 'v',
          orderRef: 'form:0f8e4c3a-1b2c-4d5e-8f90-123456789abc:1a2b3c4d',
          amountCents: 250,
        },
        'internal'
      )
    ).resolves.toEqual({ ok: true });
    expect(refund).toHaveBeenCalledWith(
      'v',
      'form:0f8e4c3a-1b2c-4d5e-8f90-123456789abc:1a2b3c4d',
      250
    );
  });
});

describe('the refund codes follow the shared contract', () => {
  it('core answers exactly the contract refund.core codes', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
        'utf8'
      )
    ) as { refund: { core: Record<string, string> } };
    expect({
      noKey: LYDIA_REFUND_NO_KEY,
      notRefundableAtLydia: LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE,
      notAllowed: LYDIA_REFUND_NOT_ALLOWED,
      rejected: LYDIA_REFUND_REJECTED,
      unconfirmed: LYDIA_REFUND_UNCONFIRMED,
    }).toEqual(contract.refund.core);
  });
});
