import { Logger } from '@nestjs/common';
import { UserResourceThrottlerGuard } from './user-resource-throttler.guard';

/**
 * The throttle on `confirm-payment` is only a throttle if its buckets are the right ones: one per
 * signed-in user AND per submission. A constant key would put every payer in one bucket, so one
 * stuck tab would starve everyone else's confirmation.
 */
describe('UserResourceThrottlerGuard', () => {
  const guard = Object.create(UserResourceThrottlerGuard.prototype) as {
    getTracker(req: Record<string, unknown>): Promise<string>;
  };
  const req = (userId: string | undefined, submissionId: string) => ({
    ip: '172.25.0.1',
    method: 'POST',
    url: `/api/forms/submissions/${submissionId}/confirm-payment`,
    headers: userId === undefined ? {} : { 'x-user-id': userId },
    params: { submissionId },
  });

  it('gives two users two buckets on the same submission', async () => {
    const a = await guard.getTracker(req('user-a', 'sub-1'));
    const b = await guard.getTracker(req('user-b', 'sub-1'));
    expect(a).not.toBe(b);
  });

  it('gives one user two buckets on two submissions', async () => {
    const one = await guard.getTracker(req('user-a', 'sub-1'));
    const two = await guard.getTracker(req('user-a', 'sub-2'));
    expect(one).not.toBe(two);
  });

  it('gives the same user on the same submission ONE bucket', async () => {
    const first = await guard.getTracker(req('user-a', 'sub-1'));
    const again = await guard.getTracker(req('user-a', 'sub-1'));
    expect(again).toBe(first);
  });

  it('keys a route that names its resource `:id` on that id too', async () => {
    const tracker = (id: string) =>
      guard.getTracker({
        ip: '172.25.0.1',
        method: 'PUT',
        url: `/api/associations/${id}/lydia-business-key`,
        headers: { 'x-user-id': 'user-a' },
        params: { id },
      });
    expect(await tracker('asso-1')).toBe('user-a:asso-1');
    expect(await tracker('asso-2')).not.toBe(await tracker('asso-1'));
  });

  it('gives one user two buckets on two boutique attempts of ONE association (`:checkoutId`)', async () => {
    // The control: keyed on `:id` before `:checkoutId`, both attempts landed in ONE bucket
    // ('user-a:asso-1'), because a checkout route names its association `:id` too.
    const attempt = (checkoutId: string) => ({
      ...req('user-a', ''),
      params: { id: 'asso-1', productId: 'prod-1', checkoutId },
    });
    const one = await guard.getTracker(attempt('co-1'));
    const two = await guard.getTracker(attempt('co-2'));
    expect(one).toBe('user-a:co-1');
    expect(two).toBe('user-a:co-2');
  });

  it('falls to the socket, at ERROR, when no user was named', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect(await guard.getTracker(req(undefined, 'sub-1'))).toBe('172.25.0.1:sub-1');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
