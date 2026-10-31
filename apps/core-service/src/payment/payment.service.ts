import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
  LydiaPaymentProvider,
  type LydiaCashierRemoval,
  type LydiaCashierRole,
} from './lydia-payment-provider';
import { verifyLydiaCallback, type LydiaCallbackVerdict } from './lydia-callback-verification';
import { internalLydiaCallbackKeyUrl, internalSocialRequestConfig } from './social-internal-client';
import { DisabledPaymentProvider } from './disabled-payment-provider';
import {
  verifyLydiaStateSignature,
  type RequestStateVerification,
} from './lydia-state-verification';
import { PlatformService } from '../platform/platform.service';

import type {
  BusinessLegalProfile,
  CancelRequestOutcome,
  CheckoutLineItem,
  CheckoutRequestLookup,
  CheckoutRequestState,
  CheckoutRequestStateKind,
  CheckoutSessionResult,
  ConnectAccountStatusResponse,
  ConnectBalanceSummary,
  OnboardingResult,
  PaymentProvider,
  PaymentProviderId,
  WireLineItem,
  PayerRecipient,
} from './payment-provider.interface';

export type { ConnectBalanceSummary };

/**
 * Orchestrates payment operations against the active PaymentProvider (Lydia, or `disabled`; Stripe
 * left the product, see docs/wiki/stripe-archive.md). Selection is an admin-editable platform_config
 * field (`paymentProvider`, PATCH /api/users/admin/platform), not an env var - PlatformService reads
 * straight from Postgres on every call with no caching (same pattern as maintenanceEnabled /
 * minClientVersion), so flipping the switch in the admin UI takes effect immediately, no restart.
 * The Lydia provider is built once at startup from its env-held secrets
 * (LYDIA_PROVIDER_TOKEN) - only the choice of WHETHER it is live moves to the DB. Callbacks verify
 * with each association's own Business key, never a platform secret (`verifyLydiaRequestCallback`).
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

  /**
   * Adds the Responsable of an association's Business at Lydia with every right and reads them back
   * (`LydiaPaymentProvider.addBusinessHolder`). Lydia-specific and independent of which provider is
   * ACTIVE: enrolling is allowed while payments are switched off platform-wide.
   */
  async addLydiaBusinessHolder(
    associationId: string,
    vendorToken: string,
    phone: string
  ): Promise<void> {
    return this.lydiaProvider.addBusinessHolder(associationId, vendorToken, phone);
  }

  /** Reads one cashier's rights at Lydia, read-only (`LydiaPaymentProvider.readCashierRights`). */
  async readLydiaCashierRights(associationId: string, vendorToken: string, phone: string) {
    return this.lydiaProvider.readCashierRights(associationId, vendorToken, phone);
  }

  /**
   * Adds a cashier with exactly the rights of `role` and reads them back
   * (`LydiaPaymentProvider.addCashier`, lot 3). Like the Responsable's add, independent of which
   * provider is ACTIVE.
   */
  async addLydiaCashier(
    associationId: string,
    vendorToken: string,
    phone: string,
    role: LydiaCashierRole
  ): Promise<void> {
    return this.lydiaProvider.addCashier(associationId, vendorToken, phone, role);
  }

  /**
   * Removes a cashier at Lydia, then re-reads its rights
   * (`LydiaPaymentProvider.removeCashier`): `verified` only at 0 rights.
   */
  async removeLydiaCashier(
    associationId: string,
    vendorToken: string,
    actorPhone: string,
    cashierPhone: string
  ): Promise<LydiaCashierRemoval> {
    return this.lydiaProvider.removeCashier(associationId, vendorToken, actorPhone, cashierPhone);
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
   * Verifies a `confirm_url`/`cancel_url`/`expire_url` callback from Lydia's `request/do`
   * (webhook.controller.ts) with the BUSINESS private token of the association its `vendor_token`
   * names, over every received field but `sig` (`verifyLydiaCallback`). Independent of which
   * provider is currently ACTIVE: a payment in flight must still be verifiable after an admin
   * disables payments. A failure to REACH social-service throws - it is not a verdict.
   */
  async verifyLydiaRequestCallback(
    body: Record<string, unknown> | undefined
  ): Promise<LydiaCallbackVerdict> {
    return verifyLydiaCallback(body, (vendorToken) => this.fetchLydiaBusinessKey(vendorToken));
  }

  /**
   * The decrypted Business private token of the association holding `vendorToken`, from
   * social-service's internal route (X-Internal-Secret, never routed by nginx). Null when no
   * association holds that token or it has no key. NEVER logged, never cached, never returned.
   */
  private async fetchLydiaBusinessKey(vendorToken: string): Promise<string | null> {
    const { data } = await axios.post<{ businessPrivateToken?: unknown }>(
      internalLydiaCallbackKeyUrl(),
      { vendorToken },
      {
        ...internalSocialRequestConfig(),
        timeout: 10_000,
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );
    const key = data?.businessPrivateToken;
    return typeof key === 'string' && key ? key : null;
  }

  /** Creates or resumes a Connect-style onboarding link for the given association. */
  async createConnectOnboarding(params: {
    associationId: string;
    refreshUrl: string;
    returnUrl: string;
    existingAccountId?: string;
    /** Required by Lydia's business/create. */
    legalProfile?: BusinessLegalProfile;
    /** `OnboardingParams.onBusinessCreated`: the vendor token, before the key check and link. */
    onBusinessCreated?: (vendorToken: string) => Promise<void>;
  }): Promise<OnboardingResult> {
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
    /** The request's lifetime in seconds; the caller's seat hold (social-service `seat-hold.ts`). */
    expireAfterSeconds?: number;
  }): Promise<CheckoutSessionResult> {
    return (await this.getProvider()).createCheckoutSession({
      lineItems: params.lineItems.map(toGenericLineItem),
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      metadata: params.metadata,
      payerRecipient: params.payerRecipient,
      connectAccountId: params.connectAccountId,
      idempotencyKey: params.idempotencyKey,
      expireAfterSeconds: params.expireAfterSeconds,
    });
  }

  /** Makes a payment request no longer payable (`PaymentProvider.cancelCheckoutRequest`). */
  async cancelCheckoutRequest(
    requestId: string,
    connectAccountId: string
  ): Promise<CancelRequestOutcome> {
    return (await this.getProvider()).cancelCheckoutRequest(requestId, connectAccountId);
  }

  /** Reads a payment request's state (`PaymentProvider.getCheckoutRequestState`). */
  async getCheckoutRequestState(
    lookup: CheckoutRequestLookup,
    connectAccountId: string
  ): Promise<CheckoutRequestState> {
    return (await this.getProvider()).getCheckoutRequestState(lookup, connectAccountId);
  }

  /**
   * Reads a request's state AND verifies the answer's signature with the Business private token of
   * `connectAccountId`, over `expectedAmountCents` and the id read (`verifyLydiaStateSignature`).
   * The key is fetched FIRST: with none stored, nothing can be verified, so Lydia is not asked at
   * all and the answer is `no-key` with no state. A failure to reach social-service for the key, or
   * Lydia for the state, throws - neither is a verdict. The signature never leaves this method.
   */
  async getVerifiedCheckoutRequestState(
    lookup: CheckoutRequestLookup,
    connectAccountId: string,
    expectedAmountCents: number
  ): Promise<
    | { verification: 'no-key' }
    | {
        verification: Exclude<RequestStateVerification, 'no-key'>;
        state: CheckoutRequestStateKind;
        raw: string;
      }
  > {
    const named = 'orderRef' in lookup ? `order_ref ${lookup.orderRef}` : lookup.requestUuid;
    const key = await this.fetchLydiaBusinessKey(connectAccountId);
    if (!key) {
      this.logger.log(`request ${named}: no Business key stored for its vendor token - not read`);
      return { verification: 'no-key' };
    }
    const { state, raw, signature } = await this.getCheckoutRequestState(lookup, connectAccountId);
    const verification = verifyLydiaStateSignature(lookup, expectedAmountCents, key, signature);
    if (verification === 'verified') {
      this.logger.debug(`request ${named}: ${state}, signature verified`);
    } else {
      // The caller (social-service) accuses the ROW at ERROR; this line is the provider's side.
      this.logger.warn(
        `request ${named}: ${state} (code ${raw}), signature ${verification} over ` +
          `${expectedAmountCents} cents`
      );
    }
    return { verification, state, raw };
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
