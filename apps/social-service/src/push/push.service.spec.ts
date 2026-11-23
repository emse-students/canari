import { Logger } from '@nestjs/common';
import { describePushFailure, PushService } from './push.service';

describe('PushService failure line', () => {
  afterEach(() => jest.restoreAllMocks());

  it('names a timeout and the budget it ran out of, inside one line', () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const line = describePushFailure(timeout);
    expect(line).toContain('TimeoutError: The operation timed out.');
    expect(line).toContain('chat-delivery did not answer within');
  });

  it('carries any other error as name and message, and a non-error as text', () => {
    expect(describePushFailure(new TypeError('fetch failed'))).toBe('TypeError: fetch failed');
    expect(describePushFailure('boom')).toBe('boom');
  });

  it('logs ONE warn whose message holds the error, never a second context line', async () => {
    process.env.INTERNAL_SECRET = 'secret';
    const service = new PushService();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    await service.notify('user-1', 't', 'b');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[PUSH] notify failed for user=user-1: TypeError: fetch failed'
    );
  });
});
