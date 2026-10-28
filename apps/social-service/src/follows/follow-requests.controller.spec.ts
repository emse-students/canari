import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { FOLLOW_ASKS_PER_MINUTE, FollowRequestsController } from './follow-requests.controller';

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
});
