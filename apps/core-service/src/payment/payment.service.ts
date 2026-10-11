import { Injectable, Logger } from '@nestjs/common';
import { LydiaPaymentProvider } from './lydia-payment-provider';
import { DisabledPaymentProvider } from './disabled-payment-provider';
import { PlatformService } from '../platform/platform.service';

import type {
  BusinessLegalProfile,
  CheckoutLineItem,
  CheckoutSessionInfo,
  CheckoutSessionResult,
  ConnectAccountStatusResponse,
  ConnectBalanceSummary,
  PaymentProvider,
  PaymentProviderId,
  WireLineItem,
  PayerRecipient,
} from './payment-provider.interface';

export type { CheckoutSessionInfo, ConnectBalanceSummary };

/**
 * Orchestrates payment operations against the active PaymentProvider (Lydia, or `disabled`; Stripe
 * left the product, see docs/wiki/stripe-archive.md). Selection is an admin-editable platform_config
 * field (`paymentProvider`, PATCH /api/users/admin/platform), not an env var - PlatformService reads
 * straight from Postgres on every call with no caching (same pattern as maintenanceEnabled /
 * minClientVersion), so flipping the switch in the admin UI takes effect immediately, no restart.
 * The Lydia provider is built once at startup from its env-held secrets
 * (LYDIA_PROVIDER_TOKEN/_PRIVATE_TOKEN) - only the choice of WHETHER it is live moves to the DB.
 *
 * Line items are translated here from the `price_data` wire contract (still used by
 * payment.controller.ts and social-service) into the types in payment-provider.interface.ts.
 */
@Injectable()
export class PaymentService {
  private readonly lydiaProvider: LydiaPaymentProvider;
  private readonly disabledProvider = new DisabledPaymentProvider();
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly platformService: PlatformService) {
    this.lydiaProvider = new LydiaPaymentProvider({
      LYDIA_ENV: process.env.LYDIA_ENV,
      LYDIA_PROVIDER_TOKEN: process.env.LYDIA_PROVIDER_TOKEN,
      LYDIA_PROVIDER_PRIVATE_TOKEN: process.env.LYDIA_PROVIDER_PRIVATE_TOKEN,
    });
  }

  /** Reads the admin-configured provider choice and returns the matching instance. */
  private async getProvider(): Promise<PaymentProvider> {
    const { paymentProvider } = await this.platformService.getConfig();
    if (paymentProvider === 'disabled') return this.disabledProvider;
    return this.lydiaProvider;
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
   * token even if the admin disables payments before it resolves.
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
    /** Required by Lydia's business/create. */
    legalProfile?: BusinessLegalProfile;
  }): Promise<{ url: string; accountId: string }> {
    return (await this.getProvider()).createOnboarding(params);
  }

  /** Creates a one-off checkout session with optional Connect destination. */
  async createCheckoutSession(params: {
    lineItems: WireLineItem[];
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    connectAccountId?: string;
    /** Payer identity, required by Lydia's request/do. */
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
      connectAccountId: params.connectAccountId,
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

  /** Retrieves a checkout session by ID. */
  async retrieveSession(sessionId: string): Promise<CheckoutSessionInfo> {
    return (await this.getProvider()).retrieveSession(sessionId);
  }
}

/** Adapts the `price_data`-shaped wire line item into the provider-agnostic CheckoutLineItem. */
function toGenericLineItem(item: WireLineItem): CheckoutLineItem {
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
