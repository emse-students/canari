import { Injectable, Logger } from '@nestjs/common';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { PushService } from '../push/push.service';
import { formPaidOverCapacityContent } from '../push/push-content';
import { FORM_RESPONSES_TARGET } from '../push/push-target';
import { forEachBounded, PUSH_FAN_OUT_LIMIT } from '../push/fan-out';
import type { Form } from './entities/form.entity';

/**
 * THE GATE: the organiser alert ships SWITCHED OFF, and only a pull request turns it on.
 *
 * Its notification type (`form_paid_over_capacity`) is new, and a client older than PR #1911 draws
 * an unknown type as a COMMENT with a dead link to `/posts/<formId>` - a wrong sentence no server
 * change can take back (legacy-compatibility.md, "a NEW notification type"). #1911's first stable is
 * `v1.2.9`; `minClientVersion` reads `1.2.7` on both estates since 2026-10-17 (backlog.md).
 *
 * WHAT FLIPS IT: `minClientVersion` raised to `1.2.9` or more in `/admin/platform` on BOTH estates
 * (production and dev each hold their own row) - the user's own gesture, once both stores serve it -
 * THEN a pull request setting this to `true`. A runtime read of the floor was not taken: the floor
 * lives in core-service's `platform_config`, and this service reads it nowhere else.
 *
 * While it is off a payment over capacity still lands, is still logged at WARN by `markPaid`, and
 * leaves `organiserNotifiedAt` NULL - nothing is claimed for a notice that was not written.
 */
export const FORM_ORGANISER_ALERT_ENABLED = false;

/** The bell row's type; the push's `contentKey` is `form_paid_over_capacity` too. */
export const FORM_PAID_OVER_CAPACITY_TYPE = 'form_paid_over_capacity';

/** Who the row names as its actor: nobody acted on the organiser, a payment provider answered. */
const SYSTEM_ACTOR_ID = 'system';
const SYSTEM_ACTOR_NAME = 'Canari';

/**
 * TELLS A FORM'S MANAGERS THAT A PAYMENT LANDED ON IT WHILE IT WAS FULL - a refund they owe.
 *
 * The row is already `paid_over_capacity` when this runs (`FormsService.markPaid`), and AT MOST
 * ONCE is not decided here: the caller claims `organiserNotifiedAt` on the row first and releases
 * it when this throws, so a replayed callback or a second settle writes nothing twice. This method
 * only knows WHO and WHAT.
 *
 * WHO: the form's owner, and every member of its association whose OWN bitmask holds
 * `MANAGE_FORMS` (`listFlagHolders`, the member tier of `mayAct`: the same bit `callerHasFlag`
 * tests). The two tiers `mayAct` adds above it are left out on purpose: a global administrator as
 * such (decided 2026-10-15), and the BDE super-admin of the association's space - the tap opens
 * `/forms`, whose list is the reader's own forms and those of associations where they hold
 * `MANAGE_FORMS` themselves (`FormsService.list`), so a super-admin would be told about a form that
 * list does not show them. Filtering the member tier through `mayAct` again would be a no-op.
 *
 * WHAT: the form's title and nothing else - no payer, no amount (`formPaidOverCapacityContent`).
 */
@Injectable()
export class FormOrganiserAlertService {
  private readonly logger = new Logger(FormOrganiserAlertService.name);

  constructor(
    private readonly associationsService: AssociationsService,
    private readonly notifications: PostNotificationsService,
    private readonly push: PushService
  ) {}

  /** Whether the alert may be sent at all - see {@link FORM_ORGANISER_ALERT_ENABLED}. */
  enabled(): boolean {
    return FORM_ORGANISER_ALERT_ENABLED;
  }

  /**
   * The user ids told about `form`: its owner, plus its association's members holding
   * `MANAGE_FORMS`. Deduplicated; the owner first.
   */
  async recipientsOf(form: Pick<Form, 'id' | 'ownerId' | 'associationId'>): Promise<string[]> {
    const ids = new Set<string>([form.ownerId]);
    if (form.associationId) {
      const holders = await this.associationsService.listFlagHolders(
        form.associationId,
        AssociationPermissionFlag.MANAGE_FORMS
      );
      for (const userId of holders) ids.add(userId);
    }
    this.logger.debug(
      `[FORM-ALERT] form ${form.id.slice(0, 8)}: ${ids.size} recipient(s) (owner + MANAGE_FORMS)`
    );
    return [...ids];
  }

  /**
   * Writes the bell row for every recipient, then pushes each one. THROWS when the rows could not
   * be written (the recipient lookup or the insert), which is what the caller releases its claim
   * on. The pushes are best-effort and never throw here: a delivery failure is logged per
   * recipient, and re-sending the whole notice to retry one push would tell the others twice.
   */
  async tell(form: Pick<Form, 'id' | 'title' | 'ownerId' | 'associationId'>): Promise<void> {
    const recipients = await this.recipientsOf(form);
    const title = form.title ?? '';
    const written = await this.notifications.createNotifications({
      recipientIds: recipients,
      type: FORM_PAID_OVER_CAPACITY_TYPE,
      postId: form.id,
      actorId: SYSTEM_ACTOR_ID,
      actorName: SYSTEM_ACTOR_NAME,
      text: title,
      // The push is sent below with the explicit target: `createNotifications` would draw the
      // ACTOR's picture, and the actor here is nobody.
      skipPush: true,
    });
    this.logger.log(
      `[FORM-ALERT] form ${form.id.slice(0, 8)}: payment over capacity told to ${written} manager(s)`
    );
    const content = formPaidOverCapacityContent(title);
    void forEachBounded(recipients, PUSH_FAN_OUT_LIMIT, (recipientId) =>
      this.push.notifyContent(recipientId, content, {
        type: 'social',
        target: FORM_RESPONSES_TARGET,
        formId: form.id,
      })
    ).then((failures) => {
      for (const { item, error } of failures) {
        this.logger.warn(`[FORM-ALERT] push failed for ${item.slice(0, 8)}: ${String(error)}`);
      }
    });
  }
}
