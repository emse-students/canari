/**
 * The typed refusals core-service answers on the cashier routes of lot 3
 * (`/api/payments/lydia-cashiers/...`), shared as data with the servers
 * (`libs/contracts/lydia-refusal-codes.json`, asserted by `lydiaCodes.contract.test.ts`).
 */
export const LYDIA_CASHIER_REFUSAL = {
  ADD_DISABLED: 'LYDIA_CASHIER_ADD_DISABLED',
  REVOKE_UNCONFIRMED: 'LYDIA_CASHIER_REVOKE_UNCONFIRMED',
  /** Lydia's answer about a cashier's rights could not be trusted: nothing is counted as done. */
  READBACK_INVALID: 'LYDIA_CASHIER_READBACK_INVALID',
  /** The check before a removal refused it: nothing was removed. */
  REMOVAL_PRECONDITION: 'LYDIA_CASHIER_REMOVAL_PRECONDITION',
  /** Changing the Responsable's number is off while the add gate is off. */
  /** Only the Responsable themselves, or a global admin, may change their number. */
  RESPONSABLE_NUMBER_CHANGE_FORBIDDEN: 'LYDIA_RESPONSABLE_NUMBER_CHANGE_FORBIDDEN',
  /** Handing the Responsable over is off (the owner's gate). */
  RESPONSABLE_HANDOVER_DISABLED: 'LYDIA_RESPONSABLE_HANDOVER_DISABLED',
  /**
   * A cashier promoted in place lost MANAGE_PAYOUT_ACCOUNT before the record: the hand-over is not
   * made and their own number was removed - they are no longer a cashier.
   */
  RESPONSABLE_HANDOVER_HEIR_CASHIER_REMOVED: 'LYDIA_RESPONSABLE_HANDOVER_HEIR_CASHIER_REMOVED',
  /** The same refusal, but that number's removal did not complete: it is still on the card. */
  RESPONSABLE_HANDOVER_HEIR_CASHIER_ON_CARD: 'LYDIA_RESPONSABLE_HANDOVER_HEIR_CASHIER_ON_CARD',
} as const;

/** The typed refusals social-service answers on the same routes (core passes them on as given). */
export const LYDIA_CASHIER_SOCIAL_REFUSAL = {
  IN_FLIGHT: 'LYDIA_CASHIER_IN_FLIGHT',
  NOT_A_MEMBER: 'LYDIA_CASHIER_NOT_A_MEMBER',
  ALREADY_SET: 'LYDIA_CASHIER_ALREADY_SET',
  PHONE_IN_USE: 'LYDIA_CASHIER_PHONE_IN_USE',
  NO_RESPONSABLE: 'LYDIA_CASHIER_NO_RESPONSABLE',
  RESPONSABLE_NUMBER: 'LYDIA_CASHIER_RESPONSABLE_NUMBER',
  NOT_FOUND: 'LYDIA_CASHIER_NOT_FOUND',
  ROLE_FIXED: 'LYDIA_CASHIER_ROLE_FIXED',
  /** The operation's hold on the association was cleared meanwhile: its outcome was not recorded. */
  CLAIM_LOST: 'LYDIA_CASHIER_CLAIM_LOST',
  /** The number acted on changed meanwhile: nothing recorded against another number. */
  NUMBER_CHANGED: 'LYDIA_CASHIER_NUMBER_CHANGED',
  /** A malformed record (no explicit confirmation): never shown as such, the generic sentence. */
  CONFIRMED_REQUIRED: 'LYDIA_CASHIER_CONFIRMED_REQUIRED',
  /** Deleting the association is refused while its Lydia Business still lists cashiers to remove. */
  LIVE_ON_DELETE: 'LYDIA_CASHIERS_LIVE',
  /** Only the Responsable themselves, or a platform admin, hands the role over. */
  RESPONSABLE_HANDOVER_FORBIDDEN: 'LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN',
  /** The member picked already is the Responsable. */
  RESPONSABLE_HANDOVER_SAME_PERSON: 'LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON',
  /** The heir does not hold MANAGE_PAYOUT_ACCOUNT: they could never hand over in turn. */
  RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER:
    'LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER',
  /** A cashier heir is promoted with the number they are cashier with, never another one. */
  RESPONSABLE_HANDOVER_CASHIER_NUMBER: 'LYDIA_RESPONSABLE_HANDOVER_CASHIER_NUMBER',
} as const;
