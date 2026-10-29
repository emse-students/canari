/**
 * Lifecycle of an association's payout account, as the edit UI renders it.
 *
 * Defined HERE, in the provider-agnostic contract, rather than in the Stripe module it started in:
 * `LydiaPaymentProvider` implements this method too, and importing a type called
 * `StripeConnectStatusResponse` to do it made the neutral contract depend on one implementation.
 * The shape was already neutral - only its name was not.
 */
export type ConnectAccountStatus =
  | 'not_started'
  | 'onboarding_required'
  | 'pending'
  | 'active'
  | 'restricted';

/** Live payout-account status returned to the association edit UI. */
export type ConnectAccountStatusResponse = {
  status: ConnectAccountStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** Requirement field keys the provider is still waiting on (onboarding). */
  currentlyDue: string[];
  /** Requirement field keys under provider review (pending). */
  pendingVerification: string[];
  disabledReason: string | null;
};

/** One purchasable line, collapsed by the caller into a single total before it reaches the provider. */
export interface CheckoutLineItem {
  productName: string;
  unitAmountCents: number;
  quantity: number;
  currency: string;
}

/**
 * The association's legal profile, required upfront by Lydia's `business/create` (no hosted
 * collection page exists on Lydia's side). LydiaPaymentProvider rejects an onboarding call
 * missing any of these.
 */
export interface BusinessLegalProfile {
  name: string;
  address: string;
  zipcode: string;
  city: string;
  country: string;
  businessEmail: string;
  businessPhone: string;
}

export interface OnboardingParams {
  associationId: string;
  refreshUrl: string;
  returnUrl: string;
  existingAccountId?: string;
  legalProfile?: BusinessLegalProfile;
}

export interface OnboardingResult {
  url: string;
  accountId: string;
}

/** Identifies the payer up front: Lydia's request/do requires it (see LydiaPaymentProvider). */
export interface PayerRecipient {
  value: string;
  type: 'email' | 'phone';
}

export interface CreateCheckoutSessionParams {
  lineItems: CheckoutLineItem[];
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
  connectAccountId?: string;
  payerRecipient?: PayerRecipient;
  /** Stable key for idempotency; derived from submission ID or a client-supplied UUID. */
  idempotencyKey?: string;
  /**
   * How long the request stays payable, in whole SECONDS from its creation (Lydia's `expire_time`,
   * measured on the sandbox 2026-10-15: payments.md). Must be positive - Lydia reads 0 as "never".
   */
  expireAfterSeconds?: number;
}

export interface CheckoutSessionResult {
  id: string;
  url: string | null;
  /**
   * The provider's OWN id of the request, the one its callbacks and its cancel call carry (Lydia's
   * numeric `request_id`, which is NOT `id`, the `request_uuid`). Null when the provider has none.
   */
  requestId: string | null;
}

/**
 * What cancelling a request achieved: cancelled now, or ALREADY PROCESSED - Lydia's error 2,
 * measured on cancelled and expired requests only. A PAID request very probably answers the same,
 * so `already-settled` never means "nobody paid": the caller reads the request's state next.
 */
export type CancelRequestOutcome = 'cancelled' | 'already-settled';

/**
 * What a payment request IS, classified ONCE, at the provider boundary (`getCheckoutRequestState`),
 * so no caller reads a provider code or a message. Lydia's codes, measured on the sandbox
 * (2026-10-15 and 2026-10-21, payments.md): `0` open (still payable), `1` paid, `5` declined by the
 * payer (final: Lydia sends no callback and shows its own error page), `6` cancelled or expired (a
 * cancel and an expiry both leave it). `unknown` is any other code: NEVER paid and NEVER settled -
 * a caller that meets it records no payment and releases nothing.
 * `not-found` is answered ONLY to a lookup by `orderRef`: the provider holds no request carrying it
 * (Lydia's error 2, "Requete introuvable", measured on an unknown order_ref 2026-10-15) - an attempt
 * whose request/do never reached it. A lookup by uuid never answers it.
 */
export type CheckoutRequestStateKind =
  | 'open'
  | 'paid'
  | 'declined'
  | 'cancelled-or-expired'
  | 'unknown'
  | 'not-found';

/**
 * A request's classified state; `raw` is the provider's own code, for the log only. `signature` is
 * what the provider answered to prove the answer is its own (Lydia's `request/state` signs it when
 * the vendor token is sent), or null when it answered none: verified by `PaymentService` when its
 * caller asks, and NEVER logged nor returned over the wire.
 */
export interface CheckoutRequestState {
  state: CheckoutRequestStateKind;
  raw: string;
  signature: string | null;
}

/**
 * Which request a state read names: the `request_uuid` the issuing call answered, or - for an
 * attempt whose issuing call never came back with one - the `order_ref` it was sent with, which
 * Lydia's `request/state` also finds (measured on the sandbox 2026-10-15, payments.md).
 */
export type CheckoutRequestLookup = { requestUuid: string } | { orderRef: string };

/** Collect balance snapshot for a connected account (single currency). */
export interface ConnectBalanceSummary {
  availableCents: number;
  pendingCents: number;
  currency: string;
}

/**
 * Provider-agnostic surface for Connect-style onboarding and one-off checkout. `Lydia` is the only
 * live implementation since Stripe left the product (docs/wiki/stripe-archive.md); `disabled`
 * refuses everything. `PaymentService` is the only caller.
 */
export type PaymentProviderId = 'lydia' | 'disabled';

export interface PaymentProvider {
  readonly id: PaymentProviderId;

  isConfigured(): boolean;

  createOnboarding(params: OnboardingParams): Promise<OnboardingResult>;
  getAccountStatus(accountId: string): Promise<{ chargesEnabled: boolean }>;
  getConnectAccountStatus(accountId: string): Promise<ConnectAccountStatusResponse>;
  getConnectBalance(accountId: string): Promise<ConnectBalanceSummary>;
  createConnectDashboardLink(accountId: string): Promise<string>;

  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult>;
  /** Makes a request no longer payable. `requestId` is `CheckoutSessionResult.requestId`. */
  cancelCheckoutRequest(requestId: string, connectAccountId: string): Promise<CancelRequestOutcome>;
  /** Reads a request's state, by `CheckoutSessionResult.id` (Lydia's `request_uuid`) or its order_ref. */
  getCheckoutRequestState(
    lookup: CheckoutRequestLookup,
    connectAccountId: string
  ): Promise<CheckoutRequestState>;
}

/**
 * The line-item shape social-service sends over the internal wire (`price_data` naming, kept from
 * the Stripe era so no caller changed). Collapsed into a `CheckoutLineItem` by `PaymentService`.
 */
export interface WireLineItem {
  quantity?: number;
  price_data?: {
    currency: string;
    unit_amount?: number | null;
    product_data?: { name?: string };
  };
}
