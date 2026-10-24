import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PUSH_SECRET_USER } from './push-secret.guard';

/**
 * A `ThrottlerGuard` counting per USER on a PushSecret route - the push-path twin of
 * `UserThrottlerGuard`, which keys on the `x-user-id` that `HeaderAuthGuard` proves. A shut app
 * has no session, so the proven user is the one {@link PushSecretGuard} wrote, and this guard MUST
 * run after it: `@UseGuards(PushSecretGuard, PushSecretThrottlerGuard)`, in that order.
 */
@Injectable()
export class PushSecretThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = req[PUSH_SECRET_USER];
    // Unreachable behind PushSecretGuard; if the order is ever inverted every request shares one
    // key, which is strict rather than open.
    return typeof userId === 'string' && userId ? `user:${userId}` : 'user:unidentified';
  }
}
