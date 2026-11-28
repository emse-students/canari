import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { hashMailAlertToken, isMailAlertToken } from '../utils/mail-alert';
import { refuseThrottled } from './throttle-refusal';

// Module-level rather than a field: `ThrottlerGuard` declares members of its own.
const logger = new Logger('MailAlertThrottlerGuard');

/**
 * A `ThrottlerGuard` counting per mail alert TOKEN on `POST /api/hooks/mail-alert` (mail lot 5): one
 * account's mailbox flooded, or a token replayed, is bounded without slowing any other account. The
 * key is the token's hash, never the token. A body with no well-formed token shares ONE key, which is
 * strict rather than open (the controller refuses it anyway).
 */
@Injectable()
export class MailAlertThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const token = (req.body as { token?: unknown } | undefined)?.token;
    return isMailAlertToken(token) ? `mail-alert:${hashMailAlertToken(token)}` : 'mail-alert:none';
  }

  /** Refused out loud, as every throttler guard here: {@link refuseThrottled}. */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail
  ): Promise<void> {
    refuseThrottled(logger, context, detail);
  }
}
