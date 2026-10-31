import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';
import { LYDIA_CASHIER_REFUSAL, LYDIA_CASHIER_SOCIAL_REFUSAL } from './lydiaCashierCodes';
import { LYDIA_RESPONSABLE_REFUSAL } from './lydiaResponsableRefusal';

export { LYDIA_CASHIER_REFUSAL, LYDIA_CASHIER_SOCIAL_REFUSAL };

/** The sentence for a code only the cashier routes answer; null for any other. */
export function lydiaCashierCodeText(code: string | null | undefined): string | null {
  switch (code) {
    case LYDIA_CASHIER_REFUSAL.ADD_DISABLED:
      return m.asso_lydia_cashier_err_add_disabled();
    case LYDIA_CASHIER_REFUSAL.REVOKE_UNCONFIRMED:
      return m.asso_lydia_cashier_err_revoke_unconfirmed();
    case LYDIA_CASHIER_REFUSAL.READBACK_INVALID:
      return m.asso_lydia_cashier_err_rights();
    case LYDIA_CASHIER_REFUSAL.REMOVAL_PRECONDITION:
      return m.asso_lydia_cashier_err_removal_refused();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.CLAIM_LOST:
      return m.asso_lydia_cashier_err_interrupted();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.NUMBER_CHANGED:
      return m.asso_lydia_cashier_err_number_changed();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.IN_FLIGHT:
      return m.asso_lydia_cashier_err_in_flight();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.NOT_A_MEMBER:
      return m.asso_lydia_cashier_err_not_a_member();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.ALREADY_SET:
      return m.asso_lydia_cashier_err_already_set();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.PHONE_IN_USE:
      return m.asso_lydia_cashier_err_phone_in_use();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.NO_RESPONSABLE:
      return m.asso_lydia_cashier_err_no_holder();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.RESPONSABLE_NUMBER:
      return m.asso_lydia_cashier_err_last_holder();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.NOT_FOUND:
      return m.asso_lydia_cashier_err_not_found();
    case LYDIA_CASHIER_SOCIAL_REFUSAL.ROLE_FIXED:
      return m.asso_lydia_cashier_err_role_fixed();
  }
  return null;
}

/**
 * The sentence for a cashier add, role change or removal failure, in the reader's language: one per
 * typed code (the cashier ones, then the Lydia ones the Responsable step shares), one for a 403,
 * and a generic one for anything else.
 */
export function lydiaCashierErrorText(err: unknown): string {
  if (err instanceof SocialApiError) {
    const own = lydiaCashierCodeText(err.code);
    if (own) return own;
    switch (err.code) {
      case LYDIA_RESPONSABLE_REFUSAL.PHONE_INVALID:
        return m.asso_lydia_resp_err_phone_invalid();
      case LYDIA_RESPONSABLE_REFUSAL.NO_BUSINESS:
        return m.asso_lydia_resp_err_no_business();
      case LYDIA_RESPONSABLE_REFUSAL.NOT_CONFIGURED:
        return m.asso_lydia_cashier_err_not_configured();
      case LYDIA_RESPONSABLE_REFUSAL.UNREACHABLE:
        return m.asso_lydia_resp_err_unreachable();
      case LYDIA_RESPONSABLE_REFUSAL.RIGHTS_INCOMPLETE:
        return m.asso_lydia_cashier_err_rights();
      case LYDIA_RESPONSABLE_REFUSAL.SIGNATURE_REFUSED:
      case LYDIA_RESPONSABLE_REFUSAL.PERMISSIONS_INVALID:
      case LYDIA_RESPONSABLE_REFUSAL.TOKEN_REJECTED:
        return m.asso_lydia_cashier_err_lydia_refused();
    }
    if (err.status === 403) return m.asso_lydia_resp_err_forbidden();
  }
  return m.asso_lydia_cashier_err_generic();
}
