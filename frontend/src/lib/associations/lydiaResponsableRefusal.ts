import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';

/**
 * The typed refusals of `POST /api/payments/lydia-responsable/:id`, shared as data with the servers
 * (`libs/contracts/lydia-refusal-codes.json`, asserted by `lydiaCodes.contract.test.ts`). A screen
 * reads the code, never the server's English sentence.
 */
export const LYDIA_RESPONSABLE_REFUSAL = {
  PHONE_INVALID: 'LYDIA_CASHIER_PHONE_INVALID',
  NOT_A_MEMBER: 'LYDIA_RESPONSABLE_NOT_A_MEMBER',
  NO_BUSINESS: 'LYDIA_NO_BUSINESS',
  NOT_A_CASHIER: 'LYDIA_RESPONSABLE_NOT_A_CASHIER',
  SIGNATURE_REFUSED: 'LYDIA_SIGNATURE_REFUSED',
  PERMISSIONS_INVALID: 'LYDIA_CASHIER_PERMISSIONS_INVALID',
  TOKEN_REJECTED: 'LYDIA_BUSINESS_TOKEN_REJECTED',
  RIGHTS_INCOMPLETE: 'LYDIA_CASHIER_RIGHTS_INCOMPLETE',
  NOT_CONFIGURED: 'LYDIA_CASHIER_NOT_CONFIGURED',
  UNREACHABLE: 'LYDIA_UNREACHABLE',
} as const;

/**
 * The typed refusals social-service answers on the same route (core passes them on as given):
 * another Responsable, another number for the live one (changing it is lot 3), another step in
 * flight, or the Business changed meanwhile. Shared as data like the core codes.
 */
export const LYDIA_RESPONSABLE_SOCIAL_REFUSAL = {
  ALREADY_SET: 'LYDIA_RESPONSABLE_ALREADY_SET',
  PHONE_LOCKED: 'LYDIA_RESPONSABLE_PHONE_LOCKED',
  IN_FLIGHT: 'LYDIA_RESPONSABLE_IN_FLIGHT',
  BUSINESS_CHANGED: 'LYDIA_BUSINESS_CHANGED',
} as const;

/**
 * The body code of the 409 a new enrolment gets while a `business/create` is in flight
 * (social-service): the outcome of the earlier attempt must be checked first.
 */
export const LYDIA_ENROLMENT_IN_FLIGHT = 'LYDIA_ENROLMENT_IN_FLIGHT';

/**
 * The sentence for a Responsable add / record failure, in the reader's language: one per typed
 * code, one for a 403, and a generic one for anything else.
 */
export function lydiaResponsableErrorText(err: unknown): string {
  if (err instanceof SocialApiError) {
    switch (err.code) {
      case LYDIA_RESPONSABLE_REFUSAL.PHONE_INVALID:
        return m.asso_lydia_resp_err_phone_invalid();
      case LYDIA_RESPONSABLE_REFUSAL.NOT_A_MEMBER:
        return m.asso_lydia_resp_err_not_a_member();
      case LYDIA_RESPONSABLE_REFUSAL.NO_BUSINESS:
        return m.asso_lydia_resp_err_no_business();
      case LYDIA_RESPONSABLE_REFUSAL.NOT_A_CASHIER:
        return m.asso_lydia_resp_err_not_a_cashier();
      case LYDIA_RESPONSABLE_REFUSAL.SIGNATURE_REFUSED:
        return m.asso_lydia_resp_err_signature();
      case LYDIA_RESPONSABLE_REFUSAL.PERMISSIONS_INVALID:
        return m.asso_lydia_resp_err_permissions();
      case LYDIA_RESPONSABLE_REFUSAL.TOKEN_REJECTED:
        return m.asso_lydia_resp_err_token();
      case LYDIA_RESPONSABLE_REFUSAL.RIGHTS_INCOMPLETE:
        return m.asso_lydia_resp_err_rights();
      case LYDIA_RESPONSABLE_REFUSAL.NOT_CONFIGURED:
        return m.asso_lydia_resp_err_not_configured();
      case LYDIA_RESPONSABLE_REFUSAL.UNREACHABLE:
        return m.asso_lydia_resp_err_unreachable();
      case LYDIA_RESPONSABLE_SOCIAL_REFUSAL.ALREADY_SET:
        return m.asso_lydia_resp_err_already_set();
      case LYDIA_RESPONSABLE_SOCIAL_REFUSAL.PHONE_LOCKED:
        return m.asso_lydia_resp_err_phone_locked();
      case LYDIA_RESPONSABLE_SOCIAL_REFUSAL.IN_FLIGHT:
        return m.asso_lydia_resp_err_in_flight();
      case LYDIA_RESPONSABLE_SOCIAL_REFUSAL.BUSINESS_CHANGED:
        return m.asso_lydia_resp_err_business_changed();
    }
    if (err.status === 403) return m.asso_lydia_resp_err_forbidden();
  }
  return m.asso_lydia_resp_err_generic();
}
