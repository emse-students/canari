import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { StripePaymentProvider } from './stripe-payment-provider';
import { LydiaPaymentProvider } from './lydia-payment-provider';
import { PlatformService } from '../platform/platform.service';

import type {
  BusinessLegalProfile,
  ChargeResult,
  CheckoutLineItem,
  CheckoutSessionInfo,
  CheckoutSessionResult,
  ConnectAccountStatusResponse,
  ConnectBalanceSummary,
  PaymentProvider,
  PaymentProviderId,
  PayerRecipient,
  SavedPaymentMethod,
} from './payment-provider.interface';

export type { ChargeResult, CheckoutSessionInfo, ConnectBalanceSummary };

/**
 * Orchestrates payment operations against the active PaymentProvider (Stripe today; Lydia is being
 * added alongside it, see docs/wiki - WP-LYDIA-1). Selection is an admin-editable platform_config
 * field (`paymentProvider`, PATCH /api/users/admin/platform), not an env var - PlatformService reads
 * straight from Postgres on every call with no caching (same pattern as maintenanceEnabled /
 * minClientVersion), so flipping the switch in the admin UI takes effect immediately, no restart.
 * Both provider instances are built once at startup from their env-held secrets (STRIPE_SECRET_KEY,
 * LYDIA_PROVIDER_TOKEN/_PRIVATE_TOKEN) - only the choice of WHICH one is live moves to the DB.
 *
 * Line items and session shapes are translated here from the legacy Stripe-flavored wire contract
 * (still used by payment.controller.ts and social-service) into the provider-agnostic types in
 * payment-provider.interface.ts - callers of this service are unaffected by which provider is active.
 */
@Injectable()
export class PaymentService {
  private readonly stripeProvider: PaymentProvider;
  private readonly lydiaProvider: LydiaPaymentProvider;
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly platformService: PlatformService) {
    this.stripeProvider = new StripePaymentProvider(process.env.STRIPE_SECRET_KEY);
    this.lydiaProvider = new LydiaPaymentProvider({
      LYDIA_ENV: process.env.LYDIA_ENV,
      LYDIA_PROVIDER_TOKEN: process.env.LYDIA_PROVIDER_TOKEN,
      LYDIA_PROVIDER_PRIVATE_TOKEN: process.env.LYDIA_PROVIDER_PRIVATE_TOKEN,
    });
  }

  /** Reads the admin-configured provider choice and returns the matching instance. */
  private async getProvider(): Promise<PaymentProvider> {
    const { paymentProvider } = await this.platformService.getConfig();
    return paymentProvider === 'lydia' ? this.lydiaProvider : this.stripeProvider;
  }

  /** Returns true when the active provider has valid credentials configured. */
  async isConfigured(): Promise<boolean> {
    return (await this.getProvider()).isConfigured();
  }

  /** Identifies the active provider so callers (e.g. the association edit UI) can render the right onboarding flow. */
  async getActiveProviderId(): Promise<PaymentProviderId> {
    return (await this.getProvider()).id;
  }

  /**
   * Verifies a `confirm_url`/`cancel_url`/`expire_url` callback signature from Lydia's
   * `request/do` (webhook.controller.ts). Independent of which provider is currently ACTIVE - a
   * Lydia payment in flight must still be verifiable against the Lydia provider's own private
   * token even if the admin flips the switch back to Stripe before it resolves.
   */
  verifyLydiaRequestCallback(fields: Record<string, string>, signature: string): boolean {
    return this.lydiaProvider.verifyRequestCallback(fields, signature);
  }

  /** Creates or resumes a Connect-style onboarding link for the given association. */
  async createConnectOnboarding(params: {
    associationId: string;
    refreshUrl: string;
    returnUrl: string;
    existingAccountId?: string;
    /** Required by Lydia's business/create, ignored by Stripe. */
    legalProfile?: BusinessLegalProfile;
  }): Promise<{ url: string; accountId: string }> {
    return (await this.getProvider()).createOnboarding(params);
  }

  /** Creates a one-off checkout session with optional Connect destination. */
  async createCheckoutSession(params: {
    lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    stripeConnectAccountId?: string;
    customerId?: string;
    saveForFuture?: boolean;
    /** Payer identity, required by Lydia's request/do, ignored by Stripe. Not yet wired up from any caller. */
    payerRecipient?: PayerRecipient;
    /** Stable key for idempotency; derived from submission ID or a client-supplied UUID. */
    idempotencyKey?: string;
  }): Promise<CheckoutSessionResult> {
    return (await this.getProvider()).createCheckoutSession({
      lineItems: params.lineItems.map(toGenericLineItem),
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      metadata: params.metadata,
      payerRecipient: params.payerRecipient,
      connectAccountId: params.stripeConnectAccountId,
      customerId: params.customerId,
      saveForFuture: params.saveForFuture,
      idempotencyKey: params.idempotencyKey,
    });
  }

  /** Retrieves the charges-enabled status for a Connect-style account. */
  async getAccountStatus(accountId: string): Promise<{ chargesEnabled: boolean }> {
    return (await this.getProvider()).getAccountStatus(accountId);
  }

  /** Returns treasurer-facing Connect lifecycle state from the live account. */
  async getConnectAccountStatus(accountId: string): Promise<ConnectAccountStatusResponse> {
    return (await this.getProvider()).getConnectAccountStatus(accountId);
  }

  /** Returns available and pending balances for a Connect-style account. */
  async getConnectBalance(accountId: string): Promise<ConnectBalanceSummary> {
    return (await this.getProvider()).getConnectBalance(accountId);
  }

  /** Returns a URL to manage payouts for a Connect-style account. */
  async createConnectDashboardLink(accountId: string): Promise<string> {
    return (await this.getProvider()).createConnectDashboardLink(accountId);
  }

  // ── Customer & Payment Methods ────────────────────────────────────────────

  /** Returns the existing customer ID or creates a new customer and returns its ID. */
  async getOrCreateCustomer(
    existingCustomerId: string | null | undefined,
    meta: { userId: string; displayName?: string | null }
  ): Promise<string> {
    return (await this.getProvider()).getOrCreateCustomer(existingCustomerId, meta);
  }

  /** Creates a setup session so a customer can save a card for future use. */
  async createSetupCheckoutSession(params: {
    customerId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }> {
    return (await this.getProvider()).createSetupCheckoutSession(params);
  }

  /** Lists all saved card payment methods attached to the given customer. */
  async listPaymentMethods(customerId: string): Promise<SavedPaymentMethod[]> {
    return (await this.getProvider()).listPaymentMethods(customerId);
  }

  /** Detaches a payment method so it can no longer be charged. */
  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    return (await this.getProvider()).detachPaymentMethod(paymentMethodId);
  }

  /** Charges a saved payment method off-session and returns the payment result or required-action details. */
  async chargeWithSavedMethod(params: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    currency: string;
    metadata?: Record<string, string>;
    stripeConnectAccountId?: string;
    /** Stable key for idempotency - prevents double-charge on network retry. */
    idempotencyKey?: string;
  }): Promise<ChargeResult> {
    return (await this.getProvider()).chargeWithSavedMethod({
      customerId: params.customerId,
      paymentMethodId: params.paymentMethodId,
      amountCents: params.amountCents,
      currency: params.currency,
      metadata: params.metadata,
      connectAccountId: params.stripeConnectAccountId,
      idempotencyKey: params.idempotencyKey,
    });
  }

  /** Retrieves a checkout session by ID. */
  async retrieveSession(sessionId: string): Promise<CheckoutSessionInfo> {
    return (await this.getProvider()).retrieveSession(sessionId);
  }
}

/** Adapts the legacy Stripe-shaped wire line item into the provider-agnostic CheckoutLineItem. */
function toGenericLineItem(item: Stripe.Checkout.SessionCreateParams.LineItem): CheckoutLineItem {
  const priceData = item.price_data;
  if (!priceData || typeof priceData.unit_amount !== 'number' || !priceData.product_data?.name) {
    throw new Error('Line item must specify price_data.{currency,unit_amount,product_data.name}');
  }
  return {
    productName: priceData.product_data.name,
    unitAmountCents: priceData.unit_amount,
    quantity: item.quantity ?? 1,
    currency: priceData.currency,
  };
}
