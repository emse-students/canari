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
 * collection page exists on Lydia's side, unlike Stripe's `accountLinks`). Ignored by
 * StripePaymentProvider; LydiaPaymentProvider rejects an onboarding call missing any of these.
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

/** Identifies the payer up front. Stripe Checkout never needed this (anyone with the link could
 *  pay); Lydia's request/do requires it (see LydiaPaymentProvider). Ignored by StripePaymentProvider. */
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
  customerId?: string;
  saveForFuture?: boolean;
  payerRecipient?: PayerRecipient;
  /** Stable key for idempotency; derived from submission ID or a client-supplied UUID. */
  idempotencyKey?: string;
}

export interface CheckoutSessionResult {
  id: string;
  url: string | null;
}

/** Minimal session shape consumed by verify/cancel - decoupled from any provider SDK type. */
export interface CheckoutSessionInfo {
  id: string;
  paid: boolean;
  metadata: Record<string, string | undefined>;
}

export interface ChargeResult {
  ok: boolean;
  requiresAction?: boolean;
  clientSecret?: string;
  error?: string;
  /** Set when the charge succeeded (used to fulfill boutique purchases). */
  paymentReference?: string;
}

/** Collect balance snapshot for a connected account (single currency). */
export interface ConnectBalanceSummary {
  availableCents: number;
  pendingCents: number;
  currency: string;
}

export interface SavedPaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface ChargeWithSavedMethodParams {
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  metadata?: Record<string, string>;
  connectAccountId?: string;
  /** Stable key for idempotency - prevents double-charge on network retry. */
  idempotencyKey?: string;
}

/**
 * Provider-agnostic surface for Connect-style onboarding, one-off checkout, and saved-method
 * charging. `StripePaymentProvider` is the current implementation; a `LydiaPaymentProvider` is
 * being added alongside it (see docs/wiki - WP-LYDIA-1). `PaymentService` is the only caller.
 */
export type PaymentProviderId = 'stripe' | 'lydia';

export interface PaymentProvider {
  readonly id: PaymentProviderId;

  isConfigured(): boolean;

  createOnboarding(params: OnboardingParams): Promise<OnboardingResult>;
  getAccountStatus(accountId: string): Promise<{ chargesEnabled: boolean }>;
  getConnectAccountStatus(accountId: string): Promise<ConnectAccountStatusResponse>;
  getConnectBalance(accountId: string): Promise<ConnectBalanceSummary>;
  createConnectDashboardLink(accountId: string): Promise<string>;

  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult>;
  retrieveSession(sessionId: string): Promise<CheckoutSessionInfo>;

  getOrCreateCustomer(
    existingCustomerId: string | null | undefined,
    meta: { userId: string; displayName?: string | null }
  ): Promise<string>;
  createSetupCheckoutSession(params: {
    customerId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }>;
  listPaymentMethods(customerId: string): Promise<SavedPaymentMethod[]>;
  detachPaymentMethod(paymentMethodId: string): Promise<void>;
  chargeWithSavedMethod(params: ChargeWithSavedMethodParams): Promise<ChargeResult>;
}
