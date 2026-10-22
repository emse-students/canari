import { BadGatewayException, Logger } from '@nestjs/common';
import { ClientIpThrottlerGuard } from '../common/guards/client-ip-throttler.guard';
import { PublicFormsController } from './public-forms.controller';

describe('PublicFormsController', () => {
  it('drops a filled honeypot without storing, and answers as it would a real answer', async () => {
    const service: any = { submit: jest.fn() };
    const controller = new PublicFormsController(service);
    const res = await controller.submit('f1', { answers: { q1: 'x' }, website: 'http://spam' });
    expect(res).toEqual({ ok: true });
    expect(service.submit).not.toHaveBeenCalled();
  });

  it('hands a real answer to the guest path', async () => {
    const service: any = { submit: jest.fn(() => Promise.resolve({ submissionId: 's1' })) };
    const controller = new PublicFormsController(service);
    const res = await controller.submit('f1', { answers: { q1: 'Ada' } });
    expect(service.submit).toHaveBeenCalledWith(
      'f1',
      { answers: { q1: 'Ada' }, payerEmail: undefined, paymentMethod: undefined },
      'guest'
    );
    expect(res).toEqual({ ok: true });
  });

  // The reply is an allowlist. Control (2026-10-22): return `result` itself and the submission id
  // reaches a guest - the three tests below fail.
  it('answers a paid guest the payer page and nothing else of what submit returned', async () => {
    const service: any = {
      submit: jest.fn(() =>
        Promise.resolve({ checkoutUrl: 'https://lydia.example/pay', submissionId: 's1' })
      ),
    };
    const res = await new PublicFormsController(service).submit('f1', {
      answers: { q1: 'Ada' },
      payerEmail: 'ada@example.org',
      paymentMethod: 'online',
    });
    expect(service.submit).toHaveBeenCalledWith(
      'f1',
      { answers: { q1: 'Ada' }, payerEmail: 'ada@example.org', paymentMethod: 'online' },
      'guest'
    );
    expect(res).toEqual({ ok: true, checkoutUrl: 'https://lydia.example/pay' });
  });

  it('answers a guest who owes cash that it is owed, and no id', async () => {
    const service: any = {
      submit: jest.fn(() => Promise.resolve({ submissionId: 's1', cashPayment: true })),
    };
    const res = await new PublicFormsController(service).submit('f1', {
      answers: {},
      paymentMethod: 'cash',
    });
    expect(res).toEqual({ ok: true, cashPayment: true });
  });

  it('refuses, rather than calls taken, a paid answer whose request was not issued', async () => {
    const service: any = {
      submit: jest.fn(() => Promise.resolve({ submissionId: 's1', message: 'no URL' })),
    };
    await expect(new PublicFormsController(service).submit('f1', { answers: {} })).rejects.toThrow(
      BadGatewayException
    );
  });
});

/** The throttle is only a throttle if two visitors are two buckets - the defect it replaced. */
describe('ClientIpThrottlerGuard', () => {
  const guard = Object.create(ClientIpThrottlerGuard.prototype) as any;

  it('counts the visitor nginx names, not the nginx hop', async () => {
    const req = { ip: '172.25.0.1', headers: { 'x-real-ip': '203.0.113.7' } };
    expect(await guard.getTracker(req)).toBe('203.0.113.7');
  });

  it('falls to the socket, loudly, when nothing named the visitor', async () => {
    const req = { ip: '127.0.0.1', headers: {}, method: 'POST', url: '/x' };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await guard.getTracker(req)).toBe('127.0.0.1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
