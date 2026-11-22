import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AMOUNT_OUT_OF_RANGE,
  CHECKOUT_REFUSAL_CODES,
  coreRefusedRequest,
  LYDIA_BUSINESS_BLOCKED,
  LYDIA_BUSINESS_NOT_VALIDATED,
  lydiaReadinessRefusal,
  mapCorePaymentError,
  PAYMENT_PROVIDER_REFUSED,
  PROVIDER_MAX_AMOUNT_CENTS,
  PROVIDER_MIN_AMOUNT_CENTS,
} from './core-payment-error';
import {
  LYDIA_ENROLMENT_IN_FLIGHT,
  PAYMENTS_BLOCKED,
  PAYMENTS_NOT_ACTIVATED,
} from '../associations/lydia-readiness';

function coreAnswer(status: number, data: unknown): AxiosError {
  const config = {
    method: 'post',
    url: 'http://core-service:3000/payments/create-checkout-session',
    headers: new AxiosHeaders({ 'x-internal-secret': 'S3CR3T' }),
  };
  return new AxiosError(
    'failed',
    'ERR_BAD_REQUEST',
    config as never,
    {},
    {
      status,
      statusText: '',
      headers: {},
      config: config as never,
      data,
    }
  );
}

const logger = () => ({ warn: jest.fn(), error: jest.fn() });

describe('mapCorePaymentError', () => {
  it('answers a Lydia refusal with a 400 carrying its code and readable message', () => {
    const log = logger();
    const out = mapCorePaymentError(
      coreAnswer(400, {
        code: PAYMENT_PROVIDER_REFUSED,
        message: "Ce lieu d'activite est temporairement bloque",
      }),
      log,
      'SHOP'
    );
    expect(out).toBeInstanceOf(BadRequestException);
    expect(out.getResponse()).toEqual({
      code: PAYMENT_PROVIDER_REFUSED,
      message: "Ce lieu d'activite est temporairement bloque",
    });
  });

  it('answers any other 4xx with its message as a 400, with no code', () => {
    const out = mapCorePaymentError(
      coreAnswer(400, { message: 'Provider error: bad amount' }),
      logger(),
      'FORM'
    );
    expect(out).toBeInstanceOf(BadRequestException);
    expect((out.getResponse() as { message: string }).message).toBe('Provider error: bad amount');
  });

  it('keeps the typed code AND the bounds of an out-of-range amount, and logs the refusal', () => {
    const log = logger();
    const out = mapCorePaymentError(
      coreAnswer(400, {
        code: 'AMOUNT_OUT_OF_RANGE',
        message: 'Lydia accepts payments from 0.50 to 1000.00 EUR (got 0.49)',
        minCents: 50,
        maxCents: 100000,
      }),
      log,
      'SHOP'
    );
    expect(out).toBeInstanceOf(BadRequestException);
    expect(out.getResponse()).toMatchObject({
      code: 'AMOUNT_OUT_OF_RANGE',
      minCents: 50,
      maxCents: 100000,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: the same code without bounds is not typed as a range (no guessed bounds)', () => {
    const out = mapCorePaymentError(
      coreAnswer(400, { code: 'AMOUNT_OUT_OF_RANGE', message: 'x' }),
      logger(),
      'SHOP'
    );
    expect((out.getResponse() as { code?: string }).code).toBeUndefined();
  });

  it('answers a 5xx or a missing response with a 502 and never leaks the secret', () => {
    for (const err of [
      coreAnswer(500, { message: 'boom' }),
      new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED'),
    ]) {
      const log = logger();
      const out = mapCorePaymentError(err, log, 'SHOP');
      expect(out).toBeInstanceOf(BadGatewayException);
      const logged = JSON.stringify(log.error.mock.calls) + JSON.stringify(out.getResponse());
      expect(logged).not.toContain('S3CR3T');
      expect(log.error).toHaveBeenCalledTimes(1);
    }
  });

  it('passes an exception this service already chose through untouched', () => {
    const own = new ForbiddenException('payments not ready');
    expect(mapCorePaymentError(own, logger(), 'FORM')).toBe(own);
  });
});

describe('the provider range mirrored from core-service', () => {
  it('equals the shared contract core-service asserts too, so the two apps cannot disagree', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'payment-amount-range.json'),
        'utf8'
      )
    ) as { minCents: number; maxCents: number };
    expect(PROVIDER_MIN_AMOUNT_CENTS).toBe(contract.minCents);
    expect(PROVIDER_MAX_AMOUNT_CENTS).toBe(contract.maxCents);
  });
});

describe('error 5 / 2701 - a request/do refused on the Business itself (lot 2)', () => {
  it.each([
    [LYDIA_BUSINESS_NOT_VALIDATED, 'request-refused', PAYMENTS_NOT_ACTIVATED],
    [LYDIA_BUSINESS_BLOCKED, 'request-blocked', PAYMENTS_BLOCKED],
  ])('core`s %s is the cause %s and the payer`s typed 409 %s', (coreCode, cause, socialCode) => {
    const err = coreAnswer(400, { code: coreCode, providerCode: '5', message: 'refused' });
    expect(lydiaReadinessRefusal(err)).toBe(cause);
    const log = logger();
    const out = mapCorePaymentError(err, log as never, 'shop');
    expect(out).toBeInstanceOf(ConflictException);
    expect((out as ConflictException).getResponse()).toMatchObject({ code: socialCode });
    expect(log.warn).toHaveBeenCalled();
  });

  it('classifies on the CODE, never on the sentence', () => {
    expect(
      lydiaReadinessRefusal(
        coreAnswer(400, { code: PAYMENT_PROVIDER_REFUSED, message: 'Business non valide' })
      )
    ).toBeNull();
    expect(lydiaReadinessRefusal(coreAnswer(502, {}))).toBeNull();
    expect(lydiaReadinessRefusal(new Error(LYDIA_BUSINESS_NOT_VALIDATED))).toBeNull();
  });

  it('the codes equal the shared contract core-service and the frontend read too', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
        'utf8'
      )
    ) as { core: Record<string, string>; social: Record<string, string> };
    expect(LYDIA_BUSINESS_NOT_VALIDATED).toBe(contract.core.businessNotValidated);
    expect(LYDIA_BUSINESS_BLOCKED).toBe(contract.core.businessBlocked);
    expect(Object.values(contract.social)).toEqual(
      expect.arrayContaining([PAYMENTS_NOT_ACTIVATED, PAYMENTS_BLOCKED, LYDIA_ENROLMENT_IN_FLIGHT])
    );
  });
});

// Whether a failed create-checkout-session promises that nothing was created at Lydia. Decided on
// core's typed CODE: a status class lied once, when core answered a request/do timeout as a 400.
describe('coreRefusedRequest', () => {
  it.each([
    PAYMENT_PROVIDER_REFUSED,
    LYDIA_BUSINESS_NOT_VALIDATED,
    LYDIA_BUSINESS_BLOCKED,
    AMOUNT_OUT_OF_RANGE,
  ])('reads a 400 typed %s as refused', (code) => {
    expect(coreRefusedRequest(coreAnswer(400, { code, message: 'refused' }))).toBe(true);
  });

  it.each([
    [
      'an untyped 400 (a request/do timeout, as core once answered it)',
      400,
      { message: 'Payment error: timeout' },
    ],
    ['a 400 with a code that promises nothing', 400, { code: 'SOMETHING_ELSE' }],
    ['a 401 (the internal secret)', 401, { message: 'Unauthorized' }],
    ["core's 502 for a request/do with no answer", 502, { message: 'Payment error: timeout' }],
    ['a refusal code on a status that is not 400', 409, { code: PAYMENT_PROVIDER_REFUSED }],
  ])('does not read %s as refused', (_label, status, data) => {
    expect(coreRefusedRequest(coreAnswer(status, data))).toBe(false);
  });

  it('does not read a transport failure or an exception of this service as refused', () => {
    expect(coreRefusedRequest(new Error('socket hang up'))).toBe(false);
    expect(coreRefusedRequest(new BadRequestException({ code: PAYMENT_PROVIDER_REFUSED }))).toBe(
      false
    );
  });

  // Each code is one core-service really answers: a rename there would silently turn a refusal
  // into "outcome unknown" here (safe, but never resumable), so the two sides are read together.
  it('names only codes core-service exports from its Lydia provider', () => {
    const provider = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'core-service',
        'src',
        'payment',
        'lydia-payment-provider.ts'
      ),
      'utf8'
    );
    for (const code of CHECKOUT_REFUSAL_CODES) {
      expect(provider).toMatch(new RegExp(`export const \\w+ = '${code}'`));
    }
  });
});
