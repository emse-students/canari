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
  retrieveSession(sessionId: string): Promise<CheckoutSessionInfo>;
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
