import { ConflictException } from '@nestjs/common';

/**
 * Why an association's `lydiaOnboardingComplete` last changed (migration 118). The two `request-*`
 * causes are Lydia's own answer to a real `request/do` (error 5, the Business is not validated;
 * error 2701, the Business is blocked), the only fact Lydia gives about a Business's state
 * (lydia-api.md); `webhook-validated` is the UNSIGNED `BUSINESS_VALIDATED` webhook (risk accepted by
 * the owner, 2026-10-30), `admin` the global admin's "Valider l'onboarding".
 */
export type LydiaReadinessCause =
  | 'webhook-validated'
  | 'admin'
  | 'request-refused'
  | 'request-blocked';

/** Every cause, for the readers that check a value they did not write. */
export const LYDIA_READINESS_CAUSES: readonly LydiaReadinessCause[] = [
  'webhook-validated',
  'admin',
  'request-refused',
  'request-blocked',
];

/** The tag of every readiness line: a transition, a replay and a revert. */
export const LYDIA_READINESS_LOG_TAG = '[LYDIA-READINESS]';

/**
 * The `code` of the 409 answered when an association's payments cannot be taken because its Lydia
 * Business (or its approved parent's) is not validated or not linked. Mirrored in
 * `libs/contracts/lydia-refusal-codes.json` and the frontend's `paymentRefusal.ts`.
 */
export const PAYMENTS_NOT_ACTIVATED = 'PAYMENTS_NOT_ACTIVATED';

/** The `code` of the same 409 when Lydia reported the Business BLOCKED (error 2701). */
export const PAYMENTS_BLOCKED = 'PAYMENTS_BLOCKED';

/**
 * The `code` of the 409 refusing to start a `business/create` while another one's outcome is not
 * known (`associations."lydiaEnrolmentStartedAt"`, migration 118).
 */
export const LYDIA_ENROLMENT_IN_FLIGHT = 'LYDIA_ENROLMENT_IN_FLIGHT';

/**
 * The `code` of the 503 the internal readiness route answers for a `BUSINESS_VALIDATED` naming the
 * PENDING token of an enrolment not linked yet: an expected retry, which core logs at WARN. Every
 * other failure to apply carries no such code and stays an ERROR.
 */
export const LYDIA_ENROLMENT_PENDING = 'LYDIA_ENROLMENT_PENDING';

/**
 * The typed 409 for a payment target that is not ready: `PAYMENTS_BLOCKED` when the target's last
 * readiness cause is Lydia's "blocked" answer, `PAYMENTS_NOT_ACTIVATED` otherwise. ONE builder for
 * `assertPaymentsReady`, `preparePurchase`, `decidePurchase` and the checkout refusals, so the payer
 * reads the same sentence whichever path refused.
 */
export function paymentsNotReady(
  cause: LydiaReadinessCause | null | undefined,
  delegated: boolean
): ConflictException {
  if (cause === 'request-blocked') {
    return new ConflictException({
      code: PAYMENTS_BLOCKED,
      delegated,
      message: 'Lydia reports the payment account of this association blocked',
    });
  }
  return new ConflictException({
    code: PAYMENTS_NOT_ACTIVATED,
    delegated,
    message: 'This association cannot receive online payments yet',
  });
}
