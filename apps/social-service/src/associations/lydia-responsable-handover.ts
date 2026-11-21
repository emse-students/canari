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

/**
 * The `code` (409) of a hand-over step reaching this service while its switch is off - core's own
 * code, the same string, answered here too as defence in depth.
 */
export const LYDIA_RESPONSABLE_HANDOVER_DISABLED = 'LYDIA_RESPONSABLE_HANDOVER_DISABLED';
/** The `code` (403) of a hand-over asked by someone who is neither the Responsable nor a platform admin. */
export const LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN = 'LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN';
/** The `code` (400) of a hand-over to the person who already is the Responsable. */
export const LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON = 'LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON';
/**
 * The `code` (409) of a membership removal - leaving, or being removed - of the live Responsable
 * while the hand-over is on: the role is handed over first (owner, 2026-11-19).
 */
export const LYDIA_RESPONSABLE_MUST_HAND_OVER = 'LYDIA_RESPONSABLE_MUST_HAND_OVER';
/**
 * The `code` (400) of a hand-over to a member who does not hold MANAGE_PAYOUT_ACCOUNT (owner,
 * 2026-11-20): such an heir could never reach the cashier screens to hand over in turn, so could
 * never leave.
 */
export const LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER =
  'LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER';
/**
 * The `code` (409) of a hand-over to a member who already is a cashier, asked with ANOTHER number
 * than theirs: the promotion replaces that number's rights, and a second number would leave the
 * first one holding rights no row could remove.
 */
export const LYDIA_RESPONSABLE_HANDOVER_CASHIER_NUMBER =
  'LYDIA_RESPONSABLE_HANDOVER_CASHIER_NUMBER';

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
  /**
   * The heir's own live cashier row (a Tresorier or a Vendeur promoted in one step, owner,
   * 2026-11-20), or null: the record closes it in the transaction that makes them Responsable.
   */
  heirCashierId: string | null;
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
 * someone else (`LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON`), a member (`LYDIA_CASHIER_NOT_A_MEMBER`)
 * holding MANAGE_PAYOUT_ACCOUNT (`LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER`); an heir who
 * already is a cashier is PROMOTED (owner, 2026-11-20) with their own number only
 * (`LYDIA_RESPONSABLE_HANDOVER_CASHIER_NUMBER`); the number is not the Responsable's (`LYDIA_CASHIER_PHONE_IN_USE`), the Responsable's other
 * number slot is free or holds exactly this number (`LYDIA_RESPONSABLE_PHONE_LOCKED` otherwise: a
 * number change is not finished), and no other live row holds it (`LYDIA_CASHIER_PHONE_IN_USE`). A seal
 * that does not open is a 503 for the Responsable's own numbers and counts as holding the number for
 * the others. `open` answers null for a seal that does not open (and logs it).
 */
export function planHandover(
  rows: HandoverRow[],
  ask: HandoverAsk,
  target: { isMember: boolean; managesPayout: boolean },
  open: (sealed: string) => string | null,
  codes: {
    noResponsable: string;
    notAMember: string;
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
  if (!target.isMember) {
    refuse({
      status: 400,
      code: codes.notAMember,
      message: 'The new Responsable must be a member of the association',
    });
  }
  if (!target.managesPayout) {
    refuse({
      status: 400,
      code: LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER,
      message: 'The new Responsable must be allowed to manage the payout account',
    });
  }
  const heirRow = rows.find((row) => row.userId === ask.userId) ?? null;
  if (heirRow) {
    const theirs = heirRow.phoneSealed ? open(heirRow.phoneSealed) : null;
    if (!theirs) throw new ServiceUnavailableException("The heir's cashier number cannot be read");
    if (theirs !== ask.phone) {
      refuse({
        status: 409,
        code: LYDIA_RESPONSABLE_HANDOVER_CASHIER_NUMBER,
        message: 'This member already is a cashier: hand over to the number they are cashier with',
      });
    }
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
      .filter((row) => row.id !== responsable.id && row.id !== heirRow?.id)
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
  return { previousResponsableId: responsable.id, retry, heirCashierId: heirRow?.id ?? null };
}

/**
 * What a hand-over's record did, once Lydia answered the add:
 * - `handed-over`: the target is the live Responsable; the old number is the new row's OTHER number,
 *   to remove next - or there was no old Responsable left to replace;
 * - `unconfirmed`: Lydia did not confirm the 13 rights to an heir still eligible - the old
 *   Responsable stays, the asked number is TRACKED (as the Responsable's other number, or on the
 *   heir's own cashier row, unconfirmed), for a retry or a removal; with no old Responsable left, the
 *   heir is recorded as an unconfirmed Responsable;
 * - `target-left`: the target is no longer a member, Lydia confirmed or NOT - the asked number is
 *   tracked and removed next (its rights, whatever they are, belong to nobody here);
 * - `heir-ineligible`: the target is still a member but no longer holds MANAGE_PAYOUT_ACCOUNT (it
 *   was taken away between the claim and the record) - handled as `target-left`: never recorded as
 *   the Responsable, the number tracked and removed next.
 * With NO old Responsable left (an erasure took it meanwhile), no other Responsable number remains
 * to remove the heir's with (a removal needs one as its context), so the heir is RECORDED as the
 * Responsable whatever the outcome: a `target-left` heir as a departed Responsable (a platform admin
 * hands the role over, which removes the number); a `heir-ineligible` heir, still a member, is
 * answered as recorded (`handed-over` or `unconfirmed`), and the card names the missing permission
 * until a manager grants it or a platform admin hands the role over.
 */
export type HandoverOutcome = 'handed-over' | 'unconfirmed' | 'target-left' | 'heir-ineligible';

/**
 * The outcome of a record, from what it read under its lock: whether Lydia confirmed the rights, and
 * the target's membership and MANAGE_PAYOUT_ACCOUNT re-read there. Whether the old Responsable row is
 * still live changes what the record WRITES, never the outcome. An heir who is no longer eligible wins over everything:
 * whatever Lydia answered, their number must not stay with rights.
 */
export function handoverOutcome(
  confirmed: boolean,
  target: { isMember: boolean; managesPayout: boolean }
): HandoverOutcome {
  if (!target.isMember) return 'target-left';
  if (!target.managesPayout) return 'heir-ineligible';
  if (!confirmed) return 'unconfirmed';
  return 'handed-over';
}

/** Whether an outcome leaves the heir out (their number tracked and removed, never recorded). */
export function heirRefused(outcome: HandoverOutcome): boolean {
  return outcome === 'target-left' || outcome === 'heir-ineligible';
}
