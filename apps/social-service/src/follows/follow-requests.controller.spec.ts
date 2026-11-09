import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import {
  FOLLOW_ASKS_PER_MINUTE,
  FOLLOW_STATUS_BATCH_MAX,
  FollowRequestsController,
} from './follow-requests.controller';

/**
 * What the controller itself decides before the service runs: nobody follows themselves, and a
 * muted account may not ask (a request is a push to a person). The service's rules are proven
 * against PostgreSQL in `follow-requests.integration.spec.ts`.
 */
describe('FollowRequestsController', () => {
  function controller(muted: boolean) {
    const ask = jest.fn(() => Promise.resolve({ ok: true, status: 'pending' }));
    const userFollowStatus = jest.fn(() => Promise.resolve('pending'));
    const ctl = new FollowRequestsController(
      { ask } as never,
      { userFollowStatus } as never,
      { isUserMuted: jest.fn(() => Promise.resolve(muted)) } as never
    );
    return { ctl, ask };
  }

  it('refuses a follow of oneself, and asks nothing', async () => {
    const { ctl, ask } = controller(false);
    await expect(ctl.followUser('me', 'me')).rejects.toBeInstanceOf(BadRequestException);
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses a muted account, and asks nothing', async () => {
    const { ctl, ask } = controller(true);
    await expect(ctl.followUser('me', 'you')).rejects.toBeInstanceOf(ForbiddenException);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks for anyone else, and answers the status', async () => {
    const { ctl, ask } = controller(false);
    expect(await ctl.followUser('me', 'you')).toEqual({ ok: true, status: 'pending' });
    expect(ask).toHaveBeenCalledWith('me', 'you');
  });

  it('throttles the ask per caller, and only the ask', () => {
    const proto = FollowRequestsController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata('__guards__', proto.followUser)).toContain(
      UserResourceThrottlerGuard
    );
    expect(Reflect.getMetadata('__guards__', proto.accept)).toBeUndefined();
    expect(FOLLOW_ASKS_PER_MINUTE).toBeGreaterThanOrEqual(10);
    expect(FOLLOW_ASKS_PER_MINUTE).toBeLessThanOrEqual(60);
  });

  it('answers following: true for a pending request, the meaning older clients give it', async () => {
    const { ctl } = controller(false);
    expect(await ctl.getUserFollowStatus('me', 'you')).toEqual({
      following: true,
      status: 'pending',
    });
  });

  it('answers no follow across the review cohort, either way, and asks the service nothing', async () => {
    const saved = process.env.SERVICE_ACCOUNT_USER_ID;
    process.env.SERVICE_ACCOUNT_USER_ID = 'reviewer';
    try {
      const { ctl } = controller(false);
      for (const [me, you] of [
        ['me', 'reviewer'],
        ['reviewer', 'me'],
      ]) {
        expect(await ctl.getUserFollowStatus(me, you)).toEqual({ following: false, status: null });
      }
    } finally {
      if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
      else process.env.SERVICE_ACCOUNT_USER_ID = saved;
    }
  });
});

describe('FollowRequestsController.statuses (engagement WP-2)', () => {
  function ctl() {
    const userFollowStatuses = jest.fn(() => Promise.resolve({ bob: 'pending' }));
    const c = new FollowRequestsController(
      {} as never,
      { userFollowStatuses } as never,
      {} as never
    );
    return { c, userFollowStatuses };
  }
  const codeOf = (e: unknown) => (e as BadRequestException).getResponse() as { code: string };

  it('answers the statuses of the caller, for the ids asked', async () => {
    const { c, userFollowStatuses } = ctl();
    expect(await c.statuses('me', { userIds: ['bob', 'cid'] })).toEqual({
      statuses: { bob: 'pending' },
    });
    expect(userFollowStatuses).toHaveBeenCalledWith('me', ['bob', 'cid']);
  });

  it('refuses more than the cap with a typed 400 and reads nothing', async () => {
    const { c, userFollowStatuses } = ctl();
    const ids = Array.from({ length: FOLLOW_STATUS_BATCH_MAX + 1 }, (_, i) => `u${i}`);
    const err = await c.statuses('me', { userIds: ids }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(codeOf(err).code).toBe('FOLLOW_STATUS_BATCH_TOO_LARGE');
    expect(userFollowStatuses).not.toHaveBeenCalled();
  });

  it('accepts exactly the cap', async () => {
    const { c } = ctl();
    const ids = Array.from({ length: FOLLOW_STATUS_BATCH_MAX }, (_, i) => `u${i}`);
    await expect(c.statuses('me', { userIds: ids })).resolves.toBeDefined();
  });

  it.each([[undefined], ['bob'], [[1]], [['']], [[null]]])('refuses a body of %j', async (bad) => {
    const { c, userFollowStatuses } = ctl();
    const err = await c.statuses('me', { userIds: bad }).catch((e: unknown) => e);
    expect(codeOf(err).code).toBe('FOLLOW_STATUS_BATCH_INVALID');
    expect(userFollowStatuses).not.toHaveBeenCalled();
  });
});

describe('FollowRequestsController.withdrawRequest (engagement WP-2)', () => {
  it('withdraws through the pending-only service call, never the unfollow', async () => {
    const withdraw = jest.fn(() => Promise.resolve({ ok: true }));
    const leave = jest.fn();
    const c = new FollowRequestsController({ withdraw, leave } as never, {} as never, {} as never);
    expect(await c.withdrawRequest('me', 'you')).toEqual({ ok: true });
    expect(withdraw).toHaveBeenCalledWith('me', 'you');
    expect(leave).not.toHaveBeenCalled();
  });
});
