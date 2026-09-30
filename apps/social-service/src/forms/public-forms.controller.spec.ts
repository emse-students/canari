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
    expect(service.submit).toHaveBeenCalledWith('f1', { answers: { q1: 'Ada' } }, 'guest');
    expect(res).toEqual({ ok: true });
  });
});

/** The throttle is only a throttle if two visitors are two buckets - the defect it replaced. */
describe('ClientIpThrottlerGuard', () => {
  const guard = Object.create(ClientIpThrottlerGuard.prototype) as any;
  guard.logger = { warn: jest.fn() };

  it('counts the visitor nginx names, not the nginx hop', async () => {
    const req = { ip: '172.25.0.1', headers: { 'x-real-ip': '203.0.113.7' } };
    expect(await guard.getTracker(req)).toBe('203.0.113.7');
  });

  it('falls to the socket, loudly, when nothing named the visitor', async () => {
    const req = { ip: '127.0.0.1', headers: {}, method: 'POST', url: '/x' };
    expect(await guard.getTracker(req)).toBe('127.0.0.1');
    expect(guard.logger.warn).toHaveBeenCalled();
  });
});
