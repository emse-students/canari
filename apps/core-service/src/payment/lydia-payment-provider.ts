import { BadRequestException, Logger } from '@nestjs/common';
import axios from 'axios';
import { signLydiaParams } from './lydia-signature';
import { parseLydiaOrderRef, orderRefToMetadata } from './lydia-order-ref';
import type { ConnectAccountStatusResponse } from './payment-provider.interface';
import type {
  ChargeResult,
  ChargeWithSavedMethodParams,
  CheckoutSessionInfo,
  CheckoutSessionResult,
  ConnectBalanceSummary,
  CreateCheckoutSessionParams,
  OnboardingParams,
  OnboardingResult,
  PaymentProvider,
  SavedPaymentMethod,
} from './payment-provider.interface';

const HOMOLOGATION_BASE_URL = 'https://homologation.lydia-app.com';
const PRODUCTION_BASE_URL = 'https://lydia-app.com';

/**
 * Lydia API implementation of PaymentProvider (WP-LYDIA-1). Platform config still defaults
 * `paymentProvider` to `stripe` - flipping it live is gated on the two gaps below, not on code.
 * Covers checkout (`request/do`, confirmed server-side via its signed per-request callback - see
 * `webhook.controller.ts`'s `lydia-request-callback` route) and session lookup (`request/state`).
 *
 * Everything else throws deliberately instead of faking a result - each throw below documents a
 * real gap found while implementing this, not a missing feature to silently stub:
 * - Account/balance status (`getAccountStatus`, `getConnectAccountStatus`, `getConnectBalance`,
 *   `createConnectDashboardLink`) has no live-poll equivalent: Lydia pushes a `BUSINESS_VALIDATED`
 *   webhook event once, it does not expose a "retrieve current status" call. The PaymentProvider
 *   interface assumes a Stripe-style live poll; serving this correctly needs the interface extended
 *   to read Canari's own DB-tracked state (written by the webhook) instead of calling Lydia live.
 *   That webhook receiver is deliberately not built either (2026-08-19): it has no documented
 *   signature and `vendor_token` is PUBLIC, so building it as-is would be forgeable.
 * - Saved payment method methods: retired per the WP-LYDIA-1 decision (see plan) - every purchase
 *   becomes its own `request/do` with payer interaction, there is no server-side vaulted instrument.
 * - `createCheckoutSession` still requires `payerRecipient`, which no caller in social-service
 *   resolves yet (2026-08-19) - a Lydia checkout throws until that's wired.
 */
export class LydiaPaymentProvider implements PaymentProvider {
  readonly id = 'lydia' as const;
  private readonly logger = new Logger(LydiaPaymentProvider.name);
  private readonly baseUrl: string;
  private readonly providerToken: string | undefined;
  private readonly providerPrivateToken: string | undefined;

  constructor(env: {
    LYDIA_ENV?: string;
    LYDIA_PROVIDER_TOKEN?: string;
    LYDIA_PROVIDER_PRIVATE_TOKEN?: string;
  }) {
    this.baseUrl =
      (env.LYDIA_ENV || '').trim().toLowerCase() === 'production'
        ? PRODUCTION_BASE_URL
        : HOMOLOGATION_BASE_URL;
    this.providerToken = env.LYDIA_PROVIDER_TOKEN;
    this.providerPrivateToken = env.LYDIA_PROVIDER_PRIVATE_TOKEN;
    this.logger.log(`Lydia configured: ${this.isConfigured() ? 'yes' : 'no'} (${this.baseUrl})`);
  }

  /**
   * URL Lydia calls back on a `request/do` outcome (`webhook.controller.ts`'s
   * `lydia-request-callback` route). Built from `FRONTEND_URL` because nginx is the single public
   * entry point - `/api/...` under it already reaches core-service, exactly like every
   * success/cancel URL this controller already hands to Stripe and Lydia.
   */
  private callbackUrl(outcome: 'confirm' | 'cancel' | 'expire'): string {
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost').replace(/\/$/, '');
    return `${frontendUrl}/api/payments/lydia-request-callback?outcome=${outcome}`;
  }

  isConfigured(): boolean {
    return !!this.providerToken;
  }

  private async postForm<T>(path: string, fields: Record<string, string>): Promise<T> {
    const body = new URLSearchParams(fields);
    const res = await axios.post<T & { error?: string; message?: string }>(
      `${this.baseUrl}${path}.json`,
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (res.data && 'error' in res.data && res.data.error && res.data.error !== '0') {
      throw new BadRequestException(`Lydia error ${res.data.error}: ${res.data.message ?? ''}`);
    }
    return res.data;
  }

  /**
   * Creates a payment request via `POST /api/request/do`. `connectAccountId` is the target
   * Business's `vendor_token` (unchanged storage shape from Stripe's `stripeAccountId` - confirmed
   * by the doc that `vendor_token` is a per-request field, so Canari's existing payment-delegation
   * logic keeps choosing the destination exactly as it does today).
   *
   * `request/do` needs no signature (confirmed by the doc: "you can't sign a call to
   * api/request/do.json, it's reserved to another Lydia product"), so no private_token is needed
   * here - only the provider_token and the target vendor_token, both already available.
   */
  async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult> {
    if (!this.providerToken) throw new BadRequestException('Lydia not configured');
    if (!params.connectAccountId) {
      throw new BadRequestException('Lydia checkout requires a target vendor_token');
    }
    if (!params.payerRecipient) {
      throw new BadRequestException('Lydia request/do requires payerRecipient (email or phone)');
    }
    const { value: recipient, type: recipientType } = params.payerRecipient;

    const totalCents = params.lineItems.reduce(
      (sum, item) => sum + item.unitAmountCents * item.quantity,
      0
    );
    const currency = params.lineItems[0]?.currency?.toUpperCase() ?? 'EUR';
    const description = params.lineItems.map((i) => i.productName).join(', ');

    const fields: Record<string, string> = {
      amount: (totalCents / 100).toFixed(2),
      currency,
      type: recipientType,
      recipient,
      message: description,
      vendor_token: params.connectAccountId,
      provider_token: this.providerToken,
      payment_method: 'auto',
      browser_success_url: params.successUrl,
      browser_fail_url: params.cancelUrl,
      confirm_url: this.callbackUrl('confirm'),
      cancel_url: this.callbackUrl('cancel'),
      expire_url: this.callbackUrl('expire'),
    };
    if (params.idempotencyKey) fields.order_ref = params.idempotencyKey;

    const data = await this.postForm<{ request_uuid: string; mobile_url: string }>(
      '/api/request/do',
      fields
    );
    return { id: data.request_uuid, url: data.mobile_url };
  }

  /**
   * Looks up a request's state via `POST /api/request/state`. `sessionId` is the `request_uuid`
   * returned by `createCheckoutSession`. State 1 = accepted/paid (see doc's Request-State codes).
   */
  async retrieveSession(sessionId: string): Promise<CheckoutSessionInfo> {
    if (!this.providerToken) throw new BadRequestException('Lydia not configured');
    const data = await this.postForm<{ state: string; order_ref?: string }>('/api/request/state', {
      request_uuid: sessionId,
    });
    return {
      id: sessionId,
      paid: data.state === '1',
      // Best-effort: only populated if request/state actually echoes order_ref back. The
      // authoritative confirmation path is the signed request/do callback (webhook.controller.ts),
      // not this synchronous poll.
      metadata: orderRefToMetadata(parseLydiaOrderRef(data.order_ref)),
    };
  }

  /**
   * Creates a Business via `POST /api/business/create`. Unlike Stripe's `accountLinks` (a hosted
   * page the association fills in itself), Lydia needs the legal profile as request fields - the
   * caller must collect it first (see the onboarding form, WP-LYDIA-1). `dashboard_url` is returned
   * as `OnboardingResult.url` so the treasurer has somewhere to go manage the Business; there is no
   * separate "finish onboarding" redirect step like Stripe's, the Business exists immediately.
   *
   * `api_token_id` (the Business's own private_token) is deliberately NOT returned/persisted:
   * Canari calls Lydia as a provider, and provider-signed calls (`business/addcashier`, etc.) use
   * Canari's OWN provider private_token, never the target Business's - confirmed by the
   * `business/addcashier` signature spec ("cashier_phone + permissions + Provider private token").
   */
  async createOnboarding(params: OnboardingParams): Promise<OnboardingResult> {
    if (!this.providerToken) throw new BadRequestException('Lydia not configured');
    const profile = params.legalProfile;
    if (
      !profile?.name ||
      !profile.address ||
      !profile.zipcode ||
      !profile.city ||
      !profile.country ||
      !profile.businessEmail ||
      !profile.businessPhone
    ) {
      throw new BadRequestException(
        'Lydia business/create requires the full association legal profile (name, address, zipcode, city, country, businessEmail, businessPhone)'
      );
    }

    const data = await this.postForm<{ api_token: string; dashboard_url: string }>(
      '/api/business/create',
      {
        provider_token: this.providerToken,
        name: profile.name,
        address: profile.address,
        zipcode: profile.zipcode,
        city: profile.city,
        country: profile.country,
        business_email: profile.businessEmail,
        business_phone: profile.businessPhone,
      }
    );
    return { url: data.dashboard_url, accountId: data.api_token };
  }

  async getAccountStatus(_accountId: string): Promise<{ chargesEnabled: boolean }> {
    throw new BadRequestException(
      "Lydia has no live account-status poll - status must be read from Canari's DB, updated by the BUSINESS_VALIDATED webhook (see WP-LYDIA-1)."
    );
  }

  async getConnectAccountStatus(_accountId: string): Promise<ConnectAccountStatusResponse> {
    throw new BadRequestException(
      "Lydia has no live account-status poll - status must be read from Canari's DB, updated by the BUSINESS_VALIDATED webhook (see WP-LYDIA-1)."
    );
  }

  async getConnectBalance(_accountId: string): Promise<ConnectBalanceSummary> {
    throw new BadRequestException(
      'Lydia exposes no generic collect balance endpoint (only business/b2cbalance, B2C-only) - see WP-LYDIA-1 open question.'
    );
  }

  async createConnectDashboardLink(_accountId: string): Promise<string> {
    throw new BadRequestException(
      'Lydia Business dashboard access is via the dashboard_url returned once at business/create, not a re-issuable login link like Stripe.'
    );
  }

  async getOrCreateCustomer(): Promise<string> {
    throw new BadRequestException(
      'Lydia has no Customer object - payer identity is inline (email/phone) per request/do call, see WP-LYDIA-1.'
    );
  }

  async createSetupCheckoutSession(): Promise<{ url: string; sessionId: string }> {
    throw new BadRequestException(
      'Saved payment methods are retired for Lydia by decision (WP-LYDIA-1) - every purchase is its own request/do.'
    );
  }

  async listPaymentMethods(): Promise<SavedPaymentMethod[]> {
    throw new BadRequestException(
      'Saved payment methods are retired for Lydia by decision (WP-LYDIA-1) - every purchase is its own request/do.'
    );
  }

  async detachPaymentMethod(): Promise<void> {
    throw new BadRequestException(
      'Saved payment methods are retired for Lydia by decision (WP-LYDIA-1) - every purchase is its own request/do.'
    );
  }

  async chargeWithSavedMethod(_params: ChargeWithSavedMethodParams): Promise<ChargeResult> {
    throw new BadRequestException(
      'Saved payment methods are retired for Lydia by decision (WP-LYDIA-1) - every purchase is its own request/do.'
    );
  }

  /** Verifies a `confirm_url`/`cancel_url`/`expire_url` callback signature from `request/do`. */
  verifyRequestCallback(fields: Record<string, string>, signature: string): boolean {
    if (!this.providerPrivateToken) return false;
    const expected = signLydiaParams(fields, this.providerPrivateToken);
    return expected === signature;
  }
}
