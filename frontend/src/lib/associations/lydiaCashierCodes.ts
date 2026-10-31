/**
 * The typed refusals core-service answers on the cashier routes of lot 3
 * (`/api/payments/lydia-cashiers/...`), shared as data with the servers
 * (`libs/contracts/lydia-refusal-codes.json`, asserted by `lydiaCodes.contract.test.ts`).
 */
export const LYDIA_CASHIER_REFUSAL = {
  ADD_DISABLED: 'LYDIA_CASHIER_ADD_DISABLED',
  REVOKE_UNCONFIRMED: 'LYDIA_CASHIER_REVOKE_UNCONFIRMED',
} as const;

/** The typed refusals social-service answers on the same routes (core passes them on as given). */
export const LYDIA_CASHIER_SOCIAL_REFUSAL = {
  IN_FLIGHT: 'LYDIA_CASHIER_IN_FLIGHT',
  NOT_A_MEMBER: 'LYDIA_CASHIER_NOT_A_MEMBER',
  ALREADY_SET: 'LYDIA_CASHIER_ALREADY_SET',
  PHONE_IN_USE: 'LYDIA_CASHIER_PHONE_IN_USE',
  NO_HOLDER: 'LYDIA_CASHIER_NO_HOLDER',
  LAST_HOLDER: 'LYDIA_CASHIER_LAST_HOLDER',
  NOT_FOUND: 'LYDIA_CASHIER_NOT_FOUND',
  ROLE_FIXED: 'LYDIA_CASHIER_ROLE_FIXED',
} as const;
