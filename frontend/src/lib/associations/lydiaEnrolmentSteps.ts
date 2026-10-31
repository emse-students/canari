import type { AssociationPayoutAccount, LydiaReadinessCause } from './api';

/** The four steps of a Lydia enrolment, in the order a manager walks them. */
export type LydiaEnrolmentStepId = 'details' | 'responsable' | 'activate' | 'validation';

/**
 * Where a step stands. `in-flight` (details only): a `business/create` was started and its outcome
 * is unknown. `paused` (validation only): Lydia refused or blocked after the Business was ready.
 * `unconfirmed` (responsable only): Lydia answered the add but did not confirm every right.
 */
export type LydiaEnrolmentStepState =
  | 'done'
  | 'current'
  | 'upcoming'
  | 'in-flight'
  | 'paused'
  | 'unconfirmed';

/** One step of the enrolment screen. */
export interface LydiaEnrolmentStep {
  id: LydiaEnrolmentStepId;
  state: LydiaEnrolmentStepState;
}

/** The pause a Lydia refusal or block put on a Business, with its date. */
export interface LydiaEnrolmentPause {
  cause: Extract<LydiaReadinessCause, 'request-refused' | 'request-blocked'>;
  /** ISO instant of the readiness change. */
  at: string;
}

/** Everything the enrolment screen draws, derived from ONE payout-account read. */
export interface LydiaEnrolmentView {
  /** `lydiaOnboardingComplete` with a linked Business: the folded "payments active" summary. */
  active: boolean;
  steps: LydiaEnrolmentStep[];
  /** A linked, ready Business with no Responsable recorded: offer the read-only `record` prompt. */
  recordResponsable: boolean;
  /** The global admin may confirm Lydia's validation by hand (linked and not ready). */
  adminCanValidate: boolean;
  /**
   * The global admin may clear the in-flight markers after checking with Lydia: whenever EITHER is
   * set (the enrolment's or the Responsable step's), linked or not, so a claim never sticks with no
   * screen to clear it.
   */
  adminCanClearInFlight: boolean;
  /** A Responsable step was claimed and its outcome is unknown (the admin's notice). */
  responsableInFlight: boolean;
  /** The Responsable is a cashier at Lydia whose rights were not confirmed: the resend confirms. */
  responsableUnconfirmed: boolean;
  /** Set when a request-refused / request-blocked change is the latest one and not ready. */
  pause: LydiaEnrolmentPause | null;
}

/**
 * The enrolment screen as a pure function of ONE payout-account read, so a refresh redraws the same
 * screen. "Activate at Lydia" has no server fact, so it is never `done`: it is `current` once the
 * Responsable exists and the Business is not ready, and the Business becoming ready folds the whole
 * list into `active`.
 */
export function lydiaEnrolmentView(
  account: AssociationPayoutAccount,
  isGlobalAdmin: boolean
): LydiaEnrolmentView {
  const linked = account.lydiaAccountId != null;
  const ready = linked && account.lydiaOnboardingComplete;
  const hasResponsable = account.responsable != null;
  const responsableUnconfirmed = hasResponsable && account.responsable?.confirmed === false;
  const inFlight = !linked && account.enrolmentInFlightSince != null;
  const responsableInFlight = account.responsableInFlightSince != null;
  const readiness = account.readiness ?? null;
  const pause: LydiaEnrolmentPause | null =
    linked &&
    !ready &&
    readiness &&
    (readiness.cause === 'request-refused' || readiness.cause === 'request-blocked')
      ? { cause: readiness.cause, at: readiness.at }
      : null;

  const detailsState: LydiaEnrolmentStepState = linked
    ? 'done'
    : inFlight
      ? 'in-flight'
      : 'current';
  const responsableState: LydiaEnrolmentStepState = responsableUnconfirmed
    ? 'unconfirmed'
    : hasResponsable
      ? 'done'
      : linked
        ? 'current'
        : 'upcoming';
  const waiting = linked && hasResponsable && !responsableUnconfirmed && !ready;
  const activateState: LydiaEnrolmentStepState = waiting ? 'current' : 'upcoming';
  const validationState: LydiaEnrolmentStepState = pause
    ? 'paused'
    : waiting
      ? 'current'
      : 'upcoming';

  return {
    active: ready,
    steps: [
      { id: 'details', state: detailsState },
      { id: 'responsable', state: responsableState },
      { id: 'activate', state: activateState },
      { id: 'validation', state: validationState },
    ],
    recordResponsable: ready && !hasResponsable,
    adminCanValidate: isGlobalAdmin && linked && !ready,
    adminCanClearInFlight:
      isGlobalAdmin && (account.enrolmentInFlightSince != null || responsableInFlight),
    responsableInFlight,
    responsableUnconfirmed,
    pause,
  };
}
