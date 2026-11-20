import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LYDIA_CASHIER_PHONE_IN_USE, numberHeldBy } from './lydia-cashier-claim';

/**
 * THE HAND-OVER OF THE RESPONSABLE (owner, 2026-11-19: a Responsable may not leave before handing
 * over, "il doit d'abord passer la main lui-même"; docs/wiki/frontend/modules/payments.md, "Handing
 * the Responsable over"). The decisions it takes are pure functions of the rows the claim locked, so
 * a spec pins every refusal without a database.
 */

/**
 * THE OWNER'S GATE on the hand-over, OFF until it has run against Lydia homologation and the owner
 * has taken one in production. One switch in FOUR places changed together: this constant (it also
 * gates the departure refusal, `LYDIA_RESPONSABLE_MUST_HAND_OVER` - refusing a Responsable's
 * departure while nothing lets them hand over would trap them), core-service's constant of the same
 * name (`lydia-payment-provider.ts`), the frontend's (`lydiaCashiers.ts`) and
 * `switches.responsableHandoverEnabled` in `libs/contracts/lydia-refusal-codes.json`; each side's
 * contract spec asserts them equal.
 */
export const LYDIA_RESPONSABLE_HANDOVER_ENABLED = false;

/** The `code` (403) of a hand-over asked by someone who is neither the Responsable nor a platform admin. */
export const LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN = 'LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN';
/** The `code` (400) of a hand-over to the person who already is the Responsable. */
export const LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON = 'LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON';
/**
 * The `code` (409) of a membership removal - leaving, or being removed - of the live Responsable
 * while the hand-over is on: the role is handed over first (owner, 2026-11-19).
 */
export const LYDIA_RESPONSABLE_MUST_HAND_OVER = 'LYDIA_RESPONSABLE_MUST_HAND_OVER';

/** What the hand-over's checks read of one live cashier row (the claim's locked rows). */
export interface HandoverRow {
  id: string;
  userId: string;
  role: string;
  phoneSealed: string | null;
  previousPhoneSealed: string | null;
  confirmedAt: Date | null;
}

/** Who asks for the hand-over, to whom, and with which number. */
export interface HandoverAsk {
  actorId: string;
  globalAdmin: boolean;
  userId: string;
  phone: string;
}

/** What the checks answer when the hand-over may go on. */
export interface HandoverPlan {
  /** The live Responsable row the hand-over replaces. */
  previousResponsableId: string;
  /**
   * The number asked is the one an EARLIER hand-over left tracked as the Responsable's other number
   * (Lydia did not confirm it): this attempt retries it.
   */
  retry: boolean;
}

/** The typed refusals of the plan, in the order they are checked. */
type Refusal = { status: 400 | 403 | 409; code: string; message: string };

function refuse({ status, code, message }: Refusal): never {
  if (status === 403) throw new ForbiddenException({ code, message });
  if (status === 400) throw new BadRequestException({ code, message });
  throw new ConflictException({ code, message });
}

/**
 * THE CHECKS OF A HAND-OVER, on the rows the claim locked (`rows`, the live cashiers of the managed
 * Business) and the target's membership read in the same transaction (`targetIsMember`). In order:
 * a CONFIRMED Responsable exists (`LYDIA_CASHIER_NO_RESPONSABLE` - the removal of the old number
 * needs a confirmed context, and an unconfirmed one is confirmed by its own resend first); the asker
 * IS that Responsable or a platform admin (403 `LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN`); the target is
 * someone else (`LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON`), a member (`LYDIA_CASHIER_NOT_A_MEMBER`) and
 * not already a live cashier (`LYDIA_CASHIER_ALREADY_SET`: remove that role first - one live row per
 * member); the number is not the Responsable's (`LYDIA_CASHIER_PHONE_IN_USE`), the Responsable's other
 * number slot is free or holds exactly this number (`LYDIA_RESPONSABLE_PHONE_LOCKED` otherwise: a
 * number change is not finished), and no other live row holds it (`LYDIA_CASHIER_PHONE_IN_USE`). A seal
 * that does not open is a 503 for the Responsable's own numbers and counts as holding the number for
 * the others. `open` answers null for a seal that does not open (and logs it).
 */
export function planHandover(
  rows: HandoverRow[],
  ask: HandoverAsk,
  targetIsMember: boolean,
  open: (sealed: string) => string | null,
  codes: {
    noResponsable: string;
    notAMember: string;
    alreadySet: string;
    phoneLocked: string;
  }
): HandoverPlan {
  const responsable = rows.find((row) => row.role === 'responsable' && row.confirmedAt != null);
  if (!responsable) {
    refuse({
      status: 409,
      code: codes.noResponsable,
      message: 'The Responsable must be confirmed by Lydia first',
    });
  }
  if (ask.actorId !== responsable.userId && !ask.globalAdmin) {
    refuse({
      status: 403,
      code: LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN,
      message: 'Only the Responsable or a platform administrator may hand the role over',
    });
  }
  if (ask.userId === responsable.userId) {
    refuse({
      status: 400,
      code: LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON,
      message: 'This member already is the Responsable',
    });
  }
  if (!targetIsMember) {
    refuse({
      status: 400,
      code: codes.notAMember,
      message: 'The new Responsable must be a member of the association',
    });
  }
  if (rows.some((row) => row.userId === ask.userId)) {
    refuse({
      status: 409,
      code: codes.alreadySet,
      message: 'This member already is a cashier: remove that role first',
    });
  }
  const current = responsable.phoneSealed ? open(responsable.phoneSealed) : null;
  if (!current) throw new ServiceUnavailableException("The Responsable's number cannot be read");
  if (current === ask.phone) {
    refuse({
      status: 409,
      code: LYDIA_CASHIER_PHONE_IN_USE,
      message: "This number is the Responsable's",
    });
  }
  let retry = false;
  if (responsable.previousPhoneSealed) {
    const other = open(responsable.previousPhoneSealed);
    if (!other)
      throw new ServiceUnavailableException("The Responsable's other number cannot be read");
    if (other !== ask.phone) {
      refuse({
        status: 409,
        code: codes.phoneLocked,
        message: "Remove the Responsable's other number first",
      });
    }
    retry = true;
  }
  const held = numberHeldBy(
    rows
      .filter((row) => row.id !== responsable.id)
      .flatMap((row) => [row.phoneSealed, row.previousPhoneSealed]),
    ask.phone,
    open
  );
  if (held) {
    refuse({
      status: 409,
      code: LYDIA_CASHIER_PHONE_IN_USE,
      message: 'This number already is a cashier number',
    });
  }
  return { previousResponsableId: responsable.id, retry };
}

/**
 * What a hand-over's record did, once Lydia answered the add:
 * - `handed-over`: the target is the live Responsable; the old number is the new row's OTHER number,
 *   to remove next (`removeOther`) - or there was no old Responsable left to replace;
 * - `unconfirmed`: Lydia did not confirm the 13 rights - the old Responsable stays, the asked number
 *   is TRACKED as their other number (Lydia may list it), for a retry or a removal;
 * - `target-left`: Lydia confirmed, but the target is no longer a member - the old Responsable stays,
 *   the asked number is tracked as their other number and removed next (`removeOther`).
 */
export type HandoverOutcome = 'handed-over' | 'unconfirmed' | 'target-left';

/**
 * The outcome of a record, from what it read under its lock: whether the old Responsable row is
 * still live (`previousLive`), whether Lydia confirmed the rights, and whether the target is still
 * a member.
 */
export function handoverOutcome(
  previousLive: boolean,
  confirmed: boolean,
  targetIsMember: boolean
): HandoverOutcome {
  if (!confirmed) return 'unconfirmed';
  if (!previousLive) return 'handed-over';
  return targetIsMember ? 'handed-over' : 'target-left';
}
