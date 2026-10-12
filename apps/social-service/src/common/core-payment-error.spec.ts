import { BadGatewayException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import { mapCorePaymentError, PAYMENT_PROVIDER_REFUSED } from './core-payment-error';

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
