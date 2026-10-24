/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { SessionPushEndService } from './session-push-end.service';

jest.mock('axios');

/**
 * The call that ends a device's push registration on chat-delivery-service when its session ends:
 * the address (with the callee's `/api` prefix, the defect class `service-urls.ts` exists for), the
 * one internal credential, and a failure that is logged and never thrown at the revocation.
 */
describe('SessionPushEndService', () => {
  const axiosMock = jest.requireMock('axios') as { delete: jest.Mock };
  let del: jest.Mock;
  let previousSecret: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    del = jest.fn();
    axiosMock.delete = del;
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = 'internal-secret-for-tests';
    delete process.env.CHAT_DELIVERY_URL;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  it('deletes the device registration on the internal route, with the internal secret', async () => {
    del.mockResolvedValue({ data: { removed: 1 } });

    await expect(
      new SessionPushEndService().endDevice('user-1', 'phone-1', 'logout')
    ).resolves.toBe(true);

    expect(del).toHaveBeenCalledWith(
      'http://chat-delivery-service:3010/api/internal/push/users/user-1/devices/phone-1',
      expect.objectContaining({
        headers: { 'x-internal-secret': 'internal-secret-for-tests' },
      })
    );
  });

  it('logs a failed call as an error and answers false, never throwing', async () => {
    del.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), {
        config: { method: 'delete', url: 'http://chat-delivery-service:3010/api/internal/x' },
      })
    );
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(
      new SessionPushEndService().endDevice('user-1', 'phone-1', 'logout')
    ).resolves.toBe(false);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT ended'));
    // The rendered error never carries the credential the call authenticated with.
    expect(String(error.mock.calls[0][0])).not.toContain('internal-secret-for-tests');
  });
});
