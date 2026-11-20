import { m } from '$lib/paraglide/messages';
import type {
  AssociationPayoutAccount,
  LydiaAddableCashierRole,
  LydiaCashier,
  LydiaCashierRole,
} from './api';

/**
 * THE OWNER'S GATE (Lydia enrolment lot 3), ON since 1.7.1 (owner, 2026-11-18): adding a cashier,
 * changing a cashier's role and changing the Responsable's number are offered.
 *
 * It moves in ONE pull request together with core-service's `LYDIA_CASHIER_ADD_ENABLED` (which
 * refuses the add and the role change with the typed `LYDIA_CASHIER_ADD_DISABLED` while off) and
 * `switches.cashierAddEnabled` in `libs/contracts/lydia-refusal-codes.json`, which
 * `lydiaCodes.contract.test.ts` asserts this equals. Removal is NOT gated: it only takes rights away.
 */
export const LYDIA_CASHIER_ADD_ENABLED = true;

/**
 * THE OWNER'S GATE ON THE RESPONSABLE HAND-OVER (owner, 2026-11-19), OFF: it has never run against
 * Lydia. It moves in ONE pull request with core-service's and social-service's constants of the same
 * name and `switches.responsableHandoverEnabled` in `libs/contracts/lydia-refusal-codes.json`
 * (asserted equal by `lydiaCodes.contract.test.ts`). Off, "Transferer le role" is never drawn.
 */
export const LYDIA_RESPONSABLE_HANDOVER_ENABLED = false;

/** Who reads the screen: the hand-over is offered to the Responsable themselves or a platform admin. */
export interface LydiaCashiersViewer {
  userId: string | null;
  globalAdmin: boolean;
}

/**
 * The Responsable's resend control, in the reader's language. Changing the Responsable's number is
 * behind the same gate as adding a cashier (core-service refuses it with
 * `LYDIA_RESPONSABLE_PHONE_LOCKED` while off), so while the gate is off the control only
 * offers to resend the SMS and never mentions another number.
 */
export function responsableResendText(enabled: boolean = LYDIA_CASHIER_ADD_ENABLED): {
  button: string;
  hint: string;
} {
  return enabled
    ? { button: m.asso_lydia_resp_resend_button(), hint: m.asso_lydia_resp_resend_hint() }
    : {
        button: m.asso_lydia_resp_resend_only_button(),
        hint: m.asso_lydia_resp_resend_only_hint(),
      };
}

/** The roles a payout manager may give, in the order the picker lists them. */
export const LYDIA_ADDABLE_CASHIER_ROLES: readonly LydiaAddableCashierRole[] = [
  'vendeur',
  'tresorier',
];

/** One row of the "Caissiers" section and the actions it offers. */
interface LydiaCashierRowView {
  cashier: LydiaCashier;
  /** "Changer le rôle": gate on, and never the Responsable (whose role is all the rights). */
  canChangeRole: boolean;
  /** "Retirer" for the current number: never the Responsable's (the Business would have no manager). */
  canRevokeCurrent: boolean;
  /** "Retirer" for the older number a Responsable number change left behind. */
  canRevokePrevious: boolean;
  /**
   * "Transferer le role": the confirmed Responsable's row, to the Responsable themselves or a
   * platform admin (a departed Responsable's too - the admin hands it over for them), gate on.
   */
  canHandOver: boolean;
  /**
   * The person left the association: `cashier`, their access is being removed at Lydia (the
   * row's own state says whether Lydia confirmed it); `responsable`, they keep the Business's
   * current number and a new Responsable is needed. Null for a member.
   */
  departed: 'cashier' | 'responsable' | null;
  /**
   * The Responsable, still a member, does NOT hold MANAGE_PAYOUT_ACCOUNT: they cannot reach these
   * screens to manage cashiers or hand over. A hand-over recorded with no old Responsable left can
   * produce it (nothing else could hold the number), and so can a manager taking the right away
   * later. Read from `payoutManagerIds`, sent while the hand-over is on; false without it.
   */
  withoutPayout: boolean;
}

/** Everything the "Caissiers" section draws, from ONE payout-account read. */
export interface LydiaCashiersView {
  /** A Business is linked and its Responsable is confirmed: the section is drawn at all. */
  visible: boolean;
  /** "Ajouter un caissier": only while the owner's gate is on. */
  canAdd: boolean;
  rows: LydiaCashierRowView[];
}

/**
 * The "Caissiers" section as a pure function of the payout account and the gate, so a refresh
 * redraws the same screen and a test pins every rule. A row whose removal was asked and not
 * confirmed keeps its "Retirer" so the manager can try again.
 */
export function lydiaCashiersView(
  account: AssociationPayoutAccount,
  addEnabled: boolean = LYDIA_CASHIER_ADD_ENABLED,
  viewer: LydiaCashiersViewer = { userId: null, globalAdmin: false },
  handoverEnabled: boolean = LYDIA_RESPONSABLE_HANDOVER_ENABLED
): LydiaCashiersView {
  const linked = account.lydiaAccountId != null;
  const responsableConfirmed =
    account.responsable != null && account.responsable.confirmed !== false;
  const visible = linked && responsableConfirmed;
  if (!visible) return { visible: false, canAdd: false, rows: [] };
  const cashiers = account.cashiers ?? [];
  const payoutManagers = account.payoutManagerIds ? new Set(account.payoutManagerIds) : null;
  const rank = (role: LydiaCashierRole) => (role === 'responsable' ? 0 : 1);
  const rows = [...cashiers]
    .sort((a, b) => rank(a.role) - rank(b.role) || a.addedAt.localeCompare(b.addedAt))
    .map((cashier) => ({
      cashier,
      // A person who left is never given a role (social-service refuses it, `NOT_A_MEMBER`).
      canChangeRole: addEnabled && cashier.role !== 'responsable' && cashier.departed !== true,
      canRevokeCurrent: cashier.role !== 'responsable',
      canRevokePrevious: cashier.previousPhoneEnd != null,
      canHandOver:
        handoverEnabled &&
        cashier.role === 'responsable' &&
        cashier.state === 'confirmed' &&
        (viewer.globalAdmin || (viewer.userId != null && viewer.userId === cashier.userId)),
      departed:
        cashier.departed === true
          ? cashier.role === 'responsable'
            ? ('responsable' as const)
            : ('cashier' as const)
          : null,
      withoutPayout:
        payoutManagers != null &&
        cashier.role === 'responsable' &&
        cashier.departed !== true &&
        !payoutManagers.has(cashier.userId),
    }));
  return { visible, canAdd: addEnabled, rows };
}

/**
 * The question "Transferer le role" asks before anything is sent, naming the consequence: the heir
 * becomes Responsable and the current number loses its Lydia rights. `self` when the Responsable
 * asks (their own number), otherwise a platform admin (the number named by its last two digits).
 */
export function handoverConfirmText(heirName: string, phoneEnd: string, self: boolean): string {
  return self
    ? m.asso_lydia_handover_confirm_self({ name: heirName })
    : m.asso_lydia_handover_confirm_admin({ name: heirName, phoneEnd });
}

/**
 * What the screen says once the hand-over answered: done, and whether the old number's removal was
 * confirmed by Lydia - if not, the card still lists it with "Retirer cet autre numero".
 */
export function handoverDoneText(heirName: string, previousNumberRemoved: boolean): string {
  return previousNumberRemoved
    ? m.asso_lydia_handover_done({ name: heirName })
    : m.asso_lydia_handover_done_old_kept({ name: heirName });
}

/** One roster row as the cashier pickers read it: who, and nothing else. */
interface PickableMember {
  userId: string;
}

/**
 * Who the ADD form offers: the members who are not cashiers yet (the Responsable included - they
 * are a cashier), each once, in roster order.
 */
export function addableMembers<T extends PickableMember>(
  rows: T[],
  account: Pick<AssociationPayoutAccount, 'cashiers'>
): T[] {
  const taken = new Set((account.cashiers ?? []).map((c) => c.userId));
  return rows.filter(
    (row, index) =>
      !taken.has(row.userId) && rows.findIndex((other) => other.userId === row.userId) === index
  );
}

/**
 * Who the HAND-OVER offers (owner, 2026-11-20): the members holding MANAGE_PAYOUT_ACCOUNT
 * (`payoutManagerIds`) - an heir without it could never reach these screens to hand over in turn,
 * nor leave - other than the Responsable, each once. A Tresorier or Vendeur among them is offered
 * too: the hand-over PROMOTES them, with their own number.
 */
export function handoverHeirs<T extends PickableMember>(
  rows: T[],
  account: Pick<AssociationPayoutAccount, 'payoutManagerIds'>,
  responsableUserId: string
): T[] {
  const allowed = new Set(account.payoutManagerIds ?? []);
  return rows.filter(
    (row, index) =>
      allowed.has(row.userId) &&
      row.userId !== responsableUserId &&
      rows.findIndex((other) => other.userId === row.userId) === index
  );
}
