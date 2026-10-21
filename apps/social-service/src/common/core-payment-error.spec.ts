import { BadGatewayException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  mapCorePaymentError,
  PAYMENT_PROVIDER_REFUSED,
  PROVIDER_MAX_AMOUNT_CENTS,
  PROVIDER_MIN_AMOUNT_CENTS,
} from './core-payment-error';

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
      coreAnswer(400, { message: 'Stripe error: bad amount' }),
      logger(),
      'FORM'
    );
    expect(out).toBeInstanceOf(BadRequestException);
    expect((out.getResponse() as { message: string }).message).toBe('Stripe error: bad amount');
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
