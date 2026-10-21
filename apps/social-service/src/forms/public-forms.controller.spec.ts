import { BadGatewayException, Logger } from '@nestjs/common';
import { ClientIpThrottlerGuard } from '../common/guards/client-ip-throttler.guard';
import { hashGuestReceipt, newGuestReceipt } from './guest-receipt';
import { GuestReceiptThrottlerGuard } from './guest-receipt-throttler.guard';
import { PublicFormsController } from './public-forms.controller';

/** A request as nginx forwards it: the visitor's address in `X-Real-IP`, the hop in `ip`. */
const visitor = { ip: '172.25.0.1', headers: { 'x-real-ip': '203.0.113.7' } } as any;

describe('PublicFormsController', () => {
  it('drops a filled honeypot without storing, and answers as it would a real answer', async () => {
    const service: any = { submit: jest.fn() };
    const controller = new PublicFormsController(service);
    const res = await controller.submit(
      'f1',
      { answers: { q1: 'x' }, website: 'http://spam' },
      visitor
    );
    expect(res).toEqual({ ok: true });
    expect(service.submit).not.toHaveBeenCalled();
  });

  // The PAID path is behind the same honeypot (WP-P3): a bot that fills it starts no payment and
  // takes no seat. Control (2026-10-22): the honeypot check removed -> this test failed.
  it('drops a filled honeypot on a PAID answer too: no row, no payment request', async () => {
    const service: any = { submit: jest.fn() };
    const res = await new PublicFormsController(service).submit(
      'f1',
      {
        answers: { q1: 'x' },
        payerEmail: 'bot@example.org',
        paymentMethod: 'online',
        website: 'http://spam',
      },
      visitor
    );
    expect(res).toEqual({ ok: true });
    expect(service.submit).not.toHaveBeenCalled();
  });

  // Throttled per visitor (WP-P3): the paid answer is the same route, so the guard and the limit
  // are read off the route itself. Control (2026-10-22): `@UseGuards` removed -> this test failed.
  it('keeps the submit route - the paid path - behind the per-visitor throttle', () => {
    // The method itself, read as metadata and never called: no `this` is involved.
    const handler = Object.getOwnPropertyDescriptor(PublicFormsController.prototype, 'submit')
      ?.value as object;
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([ClientIpThrottlerGuard]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('hands a real answer to the guest path', async () => {
    const service: any = { submit: jest.fn(() => Promise.resolve({ submissionId: 's1' })) };
    const controller = new PublicFormsController(service);
    const res = await controller.submit('f1', { answers: { q1: 'Ada' } }, visitor);
    expect(service.submit).toHaveBeenCalledWith(
      'f1',
      { answers: { q1: 'Ada' }, payerEmail: undefined, paymentMethod: undefined },
      'guest',
      // The visitor nginx names, never the hop: the ceiling counts this address (PP5).
      '203.0.113.7'
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
    const res = await new PublicFormsController(service).submit(
      'f1',
      { answers: { q1: 'Ada' }, payerEmail: 'ada@example.org', paymentMethod: 'online' },
      visitor
    );
    expect(service.submit).toHaveBeenCalledWith(
      'f1',
      { answers: { q1: 'Ada' }, payerEmail: 'ada@example.org', paymentMethod: 'online' },
      'guest',
      '203.0.113.7'
    );
    expect(res).toEqual({ ok: true, checkoutUrl: 'https://lydia.example/pay' });
  });

  it('answers a guest who owes cash that it is owed and its reference, and no id', async () => {
    const service: any = {
      submit: jest.fn(() =>
        Promise.resolve({ submissionId: 's1', cashPayment: true, reference: '1A2B-3C4D' })
      ),
    };
    const res = await new PublicFormsController(service).submit(
      'f1',
      { answers: {}, paymentMethod: 'cash' },
      visitor
    );
    expect(res).toEqual({ ok: true, cashPayment: true, reference: '1A2B-3C4D' });
  });

  it('hands the receipt, and only the receipt, to the guest confirmation', async () => {
    const view = { reference: '1A2B-3C4D', formId: 'f1', totalPaid: 1200, currency: 'eur' };
    const service: any = { confirmGuestReceipt: jest.fn(() => Promise.resolve(view)) };
    const res = await new PublicFormsController(service).confirmReceipt({
      receipt: 'r'.repeat(43),
    });
    expect(service.confirmGuestReceipt).toHaveBeenCalledWith('r'.repeat(43));
    expect(res).toBe(view);
  });

  it('refuses, rather than calls taken, a paid answer whose request was not issued', async () => {
    const service: any = {
      submit: jest.fn(() => Promise.resolve({ submissionId: 's1', message: 'no URL' })),
    };
    await expect(
      new PublicFormsController(service).submit('f1', { answers: {} }, visitor)
    ).rejects.toThrow(BadGatewayException);
  });
});

/**
 * The receipt route's bucket is the RECEIPT (each read of a pending answer spends a Lydia call), keyed
 * on its hash; anything else is counted on the visitor.
 */
describe('GuestReceiptThrottlerGuard', () => {
  const guard = Object.create(GuestReceiptThrottlerGuard.prototype) as any;

  it('counts a receipt by its hash, never the receipt itself, whatever address sends it', async () => {
    const { token } = newGuestReceipt();
    const from = (ip: string) => ({ ip, headers: { 'x-real-ip': ip }, body: { receipt: token } });
    const a = await guard.getTracker(from('203.0.113.7'));
    expect(a).toBe(`receipt:${hashGuestReceipt(token)}`);
    expect(a).not.toContain(token);
    expect(await guard.getTracker(from('198.51.100.9'))).toBe(a);
  });

  it('counts anything that is not a receipt on the visitor', async () => {
    const req = {
      ip: '172.25.0.1',
      headers: { 'x-real-ip': '203.0.113.7' },
      body: { receipt: 'x' },
    };
    expect(await guard.getTracker(req)).toBe('visitor:203.0.113.7');
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
