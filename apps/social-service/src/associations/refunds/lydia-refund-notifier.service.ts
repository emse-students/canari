import { Injectable, Logger } from '@nestjs/common';
import {
  PostNotificationsService,
  SYSTEM_ACTOR_NAME,
} from '../../posts/post-notifications.service';
import { PushService } from '../../push/push.service';
import { lydiaRefundIssuedContent } from '../../push/push-content';
import { NOTIFICATIONS_TARGET } from '../../push/push-target';
import { LYDIA_REFUND_ISSUED_TYPE } from './refund-codes';

/**
 * THE GATE: the payer's refund notice ships SWITCHED OFF, and only a pull request turns it on.
 *
 * Its notification type (`lydia_refund_issued`) is new, and a client older than the release CARRYING
 * Lydia refunds (enrolment chantier lot 4) draws an unknown type as the neutral unknown-type row - a
 * wrong sentence no server change can take back (legacy-compatibility.md, "a NEW notification type").
 *
 * FLOOR VERSION: the first release carrying lot 4 (the version is named in legacy-compatibility.md
 * once it is cut). WHAT FLIPS IT: `minClientVersion` at or above that release on BOTH estates, once
 * BOTH Play AND the App Store serve it - then a one-line pull request setting this to `true` and
 * changing the spec that pins it.
 *
 * While it is off nothing is written; Lydia's own e-mail to the payer (`notify_payer`, on by
 * default) still tells them, and the refund's audit row is the record.
 */
export const LYDIA_REFUND_NOTIFICATIONS_ENABLED = false;

/** Who the row names as its actor: the association refunded, not a person the payer knows. */
const SYSTEM_ACTOR_ID = 'system';

/**
 * TELLS A PAYER THAT AN ASSOCIATION REFUNDED THEM. One bell row (`lydia_refund_issued`, the
 * association's name as its text, `postId` the association id) and a best-effort push to the
 * notifications list. A guest payment has nobody to tell here.
 */
@Injectable()
export class LydiaRefundNotifier {
  private readonly logger = new Logger(LydiaRefundNotifier.name);

  constructor(
    private readonly notifications: PostNotificationsService,
    private readonly push: PushService
  ) {}

  /** Whether the notice may be sent at all - see {@link LYDIA_REFUND_NOTIFICATIONS_ENABLED}. */
  enabled(): boolean {
    return LYDIA_REFUND_NOTIFICATIONS_ENABLED;
  }

  /**
   * Writes the payer's bell row and pushes it. Never throws: a refund Lydia confirmed stays
   * confirmed whatever happens here, so every failure is logged and swallowed.
   */
  async tell(association: { id: string; name: string }, payerId: string | null): Promise<void> {
    const short = association.id.slice(0, 8);
    if (!payerId) {
      this.logger.debug(`[LYDIA-REFUND] association ${short}: a guest payment - nobody to notify`);
      return;
    }
    if (!this.enabled()) {
      this.logger.debug(`[LYDIA-REFUND] association ${short}: payer notice switched off`);
      return;
    }
    try {
      await this.notifications.createNotifications({
        recipientIds: [payerId],
        type: LYDIA_REFUND_ISSUED_TYPE,
        postId: association.id,
        actorId: SYSTEM_ACTOR_ID,
        actorName: SYSTEM_ACTOR_NAME,
        text: association.name,
        skipPush: true,
      });
      await this.push.notifyContent(payerId, lydiaRefundIssuedContent(association.name), {
        type: 'social',
        target: NOTIFICATIONS_TARGET,
      });
      this.logger.log(`[LYDIA-REFUND] association ${short}: payer ${payerId.slice(0, 8)} notified`);
    } catch (err: unknown) {
      this.logger.warn(
        `[LYDIA-REFUND] association ${short}: the payer notice failed - ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
