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
   * The person left the association: `cashier`, their access is being removed at Lydia (the
   * row's own state says whether Lydia confirmed it); `responsable`, they keep the Business's
   * current number and a new Responsable is needed. Null for a member.
   */
  departed: 'cashier' | 'responsable' | null;
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
  addEnabled: boolean = LYDIA_CASHIER_ADD_ENABLED
): LydiaCashiersView {
  const linked = account.lydiaAccountId != null;
  const responsableConfirmed =
    account.responsable != null && account.responsable.confirmed !== false;
  const visible = linked && responsableConfirmed;
  if (!visible) return { visible: false, canAdd: false, rows: [] };
  const cashiers = account.cashiers ?? [];
  const rank = (role: LydiaCashierRole) => (role === 'responsable' ? 0 : 1);
  const rows = [...cashiers]
    .sort((a, b) => rank(a.role) - rank(b.role) || a.addedAt.localeCompare(b.addedAt))
    .map((cashier) => ({
      cashier,
      // A person who left is never given a role (social-service refuses it, `NOT_A_MEMBER`).
      canChangeRole: addEnabled && cashier.role !== 'responsable' && cashier.departed !== true,
      canRevokeCurrent: cashier.role !== 'responsable',
      canRevokePrevious: cashier.previousPhoneEnd != null,
      departed:
        cashier.departed === true
          ? cashier.role === 'responsable'
            ? ('responsable' as const)
            : ('cashier' as const)
          : null,
    }));
  return { visible, canAdd: addEnabled, rows };
}
