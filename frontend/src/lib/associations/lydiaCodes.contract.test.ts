/**
 * The typed Lydia codes this screen reads are the ones in `libs/contracts/lydia-refusal-codes.json`,
 * which the servers assert against too - so a rename on one side fails a test on the other.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LYDIA_ENROLMENT_IN_FLIGHT,
  LYDIA_RESPONSABLE_REFUSAL,
  LYDIA_RESPONSABLE_SOCIAL_REFUSAL,
} from './lydiaResponsableRefusal';
import { PAYMENTS_BLOCKED, PAYMENTS_NOT_ACTIVATED } from './paymentRefusal';

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
    'utf8'
  )
) as { core: Record<string, string>; social: Record<string, string> };

describe('Lydia codes follow the shared contract', () => {
  it('the Responsable refusals are the contract core codes', () => {
    expect(LYDIA_RESPONSABLE_REFUSAL).toEqual({
      PHONE_INVALID: CONTRACT.core.cashierPhoneInvalid,
      NOT_A_MEMBER: CONTRACT.core.responsableNotAMember,
      NO_BUSINESS: CONTRACT.core.noBusiness,
      NOT_A_CASHIER: CONTRACT.core.responsableNotACashier,
      SIGNATURE_REFUSED: CONTRACT.core.signatureRefused,
      PERMISSIONS_INVALID: CONTRACT.core.cashierPermissionsInvalid,
      TOKEN_REJECTED: CONTRACT.core.businessTokenRejected,
      RIGHTS_INCOMPLETE: CONTRACT.core.cashierRightsIncomplete,
      NOT_CONFIGURED: CONTRACT.core.cashierNotConfigured,
      UNREACHABLE: CONTRACT.core.unreachable,
    });
  });
  it('the social codes are the contract social codes', () => {
    expect(PAYMENTS_NOT_ACTIVATED).toBe(CONTRACT.social.paymentsNotActivated);
    expect(PAYMENTS_BLOCKED).toBe(CONTRACT.social.paymentsBlocked);
    expect(LYDIA_ENROLMENT_IN_FLIGHT).toBe(CONTRACT.social.enrolmentInFlight);
    expect(LYDIA_RESPONSABLE_SOCIAL_REFUSAL).toEqual({
      ALREADY_SET: CONTRACT.social.responsableAlreadySet,
      PHONE_LOCKED: CONTRACT.social.responsablePhoneLocked,
      IN_FLIGHT: CONTRACT.social.responsableInFlight,
      BUSINESS_CHANGED: CONTRACT.social.businessChanged,
    });
  });
});
