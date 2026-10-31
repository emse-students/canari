import { Injectable, Logger } from '@nestjs/common';
import { PostNotificationsService, SYSTEM_ACTOR_NAME } from '../posts/post-notifications.service';
import { PushService } from '../push/push.service';
import { lydiaPaymentsActiveContent, lydiaPaymentsPausedContent } from '../push/push-content';
import { NOTIFICATIONS_TARGET } from '../push/push-target';
import { forEachBounded, PUSH_FAN_OUT_LIMIT } from '../push/fan-out';

/**
 * THE GATE: the Lydia payments notices ship SWITCHED OFF, and only a pull request turns them on.
 *
 * Their notification types (`lydia_payments_active`, `lydia_payments_paused`) are new, and a client
 * older than the release CARRYING Lydia enrolment lot 2 (PR to be numbered) draws an unknown type
 * as the neutral unknown-type row - a wrong sentence no server change can take back
 * (legacy-compatibility.md, "a NEW notification type").
 *
 * WHAT FLIPS IT: `minClientVersion` at or above the first release carrying this pull request (the
 * release carrying Lydia enrolment lot 2), on BOTH estates (production and dev each hold their own
 * row), once BOTH Play AND the App Store serve it - THEN a one-line follow-up pull request setting
 * this to `true` and changing the spec that pins it.
 *
 * While it is off nothing is written: the caller's ERROR/WARN line and the payments screen state
 * carry the fact.
 */
export const LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED = false;

/** The bell row's type for "payments became active"; equals `libs/contracts/lydia-refusal-codes.json`. */
export const LYDIA_PAYMENTS_ACTIVE_TYPE = 'lydia_payments_active';

/** The bell row's type for "payments were paused"; equals `libs/contracts/lydia-refusal-codes.json`. */
export const LYDIA_PAYMENTS_PAUSED_TYPE = 'lydia_payments_paused';

/** Who the row names as its actor: nobody acted on the association, Lydia answered. */
const SYSTEM_ACTOR_ID = 'system';

/**
 * TELLS AN ASSOCIATION'S PAYOUT MANAGERS THAT ITS LYDIA PAYMENTS BECAME ACTIVE OR WERE PAUSED.
 *
 * WHO: the members whose OWN bitmask holds `MANAGE_PAYOUT_ACCOUNT` (`listFlagHolders`) - not a
 * global administrator and not the BDE super-admin, who cannot open the payments section.
 * WHAT: the association's name and nothing else; `postId` is the ASSOCIATION id, which the client
 * resolves to the edit page's `payments` section, and the push opens the notifications list
 * (`NOTIFICATIONS_TARGET`): no deep-link host exists for an association's edit section, and the
 * row there carries the tap.
 */
@Injectable()
export class LydiaPaymentsNotifier {
  private readonly logger = new Logger(LydiaPaymentsNotifier.name);

  constructor(
    private readonly notifications: PostNotificationsService,
    private readonly push: PushService
  ) {}

  /** Whether the notices may be sent at all - see {@link LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED}. */
  enabled(): boolean {
    return LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED;
  }

  /**
   * Writes the bell row for every payout manager of `association` (`recipients`, read by the caller
   * - `AssociationsService.setLydiaReadiness`, which owns `listFlagHolders`; this service takes no
   * dependency on it, so it can be injected there without a cycle), then pushes each one
   * best-effort. Returns the number of rows written (0 while switched off). THROWS when the insert
   * throws - the caller logs it; a push failure is logged per recipient and never thrown.
   */
  async tell(
    association: { id: string; name: string },
    kind: 'active' | 'paused',
    recipients: readonly string[]
  ): Promise<number> {
    const short = association.id.slice(0, 8);
    if (!this.enabled()) {
      this.logger.debug(`[LYDIA-NOTIFY] association ${short}: ${kind} notice switched off`);
      return 0;
    }
    const written = await this.notifications.createNotifications({
      recipientIds: [...recipients],
      type: kind === 'active' ? LYDIA_PAYMENTS_ACTIVE_TYPE : LYDIA_PAYMENTS_PAUSED_TYPE,
      postId: association.id,
      actorId: SYSTEM_ACTOR_ID,
      actorName: SYSTEM_ACTOR_NAME,
      text: association.name,
      // Pushed below with the explicit target: `createNotifications` would draw the ACTOR's
      // picture, and the actor here is nobody.
      skipPush: true,
    });
    this.logger.log(
      `[LYDIA-NOTIFY] association ${short}: payments ${kind} told to ${written} manager(s)`
    );
    const content =
      kind === 'active'
        ? lydiaPaymentsActiveContent(association.name)
        : lydiaPaymentsPausedContent(association.name);
    void forEachBounded(recipients, PUSH_FAN_OUT_LIMIT, (recipientId) =>
      this.push.notifyContent(recipientId, content, {
        type: 'social',
        target: NOTIFICATIONS_TARGET,
      })
    ).then((failures) => {
      for (const { item, error } of failures) {
        this.logger.warn(`[LYDIA-NOTIFY] push failed for ${item.slice(0, 8)}: ${String(error)}`);
      }
    });
    return written;
  }
}

/**
 * THE GATE OF THE CASHIER NOTICE (lot 3): ships SWITCHED OFF, and only a pull request turns it on.
 *
 * Its type, `lydia_cashier_added`, is new: a client older than the release CARRYING Lydia enrolment
 * lot 3 draws it as the neutral unknown-type row, a wrong sentence no server change can take back
 * (legacy-compatibility.md, "a NEW notification type").
 *
 * WHAT FLIPS IT: `minClientVersion` at or above the first release carrying Lydia enrolment lot 3,
 * on BOTH estates, once BOTH Play AND the App Store serve it - THEN a one-line pull request setting
 * this to `true` and changing the spec that pins it. Lydia's own SMS reaches the person meanwhile.
 */
export const LYDIA_CASHIER_NOTIFICATIONS_ENABLED = false;

/** The bell row's type for "you were added as a cashier"; equals `libs/contracts/lydia-refusal-codes.json`. */
export const LYDIA_CASHIER_ADDED_TYPE = 'lydia_cashier_added';

/**
 * TELLS A MEMBER THEY WERE ADDED AS A LYDIA CASHIER OF AN ASSOCIATION (lot 3): one bell row, its
 * `postId` the association id and its text the association's name; the client links it to the
 * Lydia Pro help page. No push: Lydia sends its own SMS, and a push would need a content key every
 * native build carries.
 */
@Injectable()
export class LydiaCashierNotifier {
  private readonly logger = new Logger(LydiaCashierNotifier.name);

  constructor(private readonly notifications: PostNotificationsService) {}

  /** Whether the notice may be sent at all - see {@link LYDIA_CASHIER_NOTIFICATIONS_ENABLED}. */
  enabled(): boolean {
    return LYDIA_CASHIER_NOTIFICATIONS_ENABLED;
  }

  /**
   * Writes the bell row for `recipientId`. Returns the rows written (0 while switched off). Never
   * throws: a notice that could not be written is logged at WARN - the add itself stands.
   */
  async tellAdded(association: { id: string; name: string }, recipientId: string): Promise<number> {
    const short = association.id.slice(0, 8);
    if (!this.enabled()) {
      this.logger.debug(`[LYDIA-NOTIFY] association ${short}: cashier notice switched off`);
      return 0;
    }
    try {
      const written = await this.notifications.createNotifications({
        recipientIds: [recipientId],
        type: LYDIA_CASHIER_ADDED_TYPE,
        postId: association.id,
        actorId: SYSTEM_ACTOR_ID,
        actorName: SYSTEM_ACTOR_NAME,
        text: association.name,
        skipPush: true,
      });
      this.logger.log(
        `[LYDIA-NOTIFY] association ${short}: cashier ${recipientId.slice(0, 8)} told (${written} row)`
      );
      return written;
    } catch (err: unknown) {
      this.logger.warn(
        `[LYDIA-NOTIFY] association ${short}: the cashier notice could not be written: ${String(err)}`
      );
      return 0;
    }
  }
}
