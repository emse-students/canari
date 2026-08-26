import { BadRequestException, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import {
  buildStripeConnectStatusResponse,
  type StripeConnectStatusResponse,
} from './stripeConnectStatus';
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
import { STRIPE_API_VERSION } from './stripe-api-version';

/** Stripe SDK implementation of PaymentProvider - pure extraction from the former PaymentService, no behavior change. */
export class StripePaymentProvider implements PaymentProvider {
  readonly id = 'stripe' as const;
  private readonly stripe: Stripe | null;
  private readonly logger = new Logger(StripePaymentProvider.name);

  constructor(secretKey: string | undefined) {
    this.stripe = secretKey ? new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION }) : null;
    this.logger.log(`Stripe configured: ${secretKey ? 'yes' : 'no'}`);
  }

  isConfigured(): boolean {
    return !!this.stripe;
  }

  async createOnboarding(params: OnboardingParams): Promise<OnboardingResult> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    // Reuse existing account or create a new one
    const accountId =
      params.existingAccountId ||
      (
        await this.stripe.accounts.create({
          type: 'standard',
          metadata: { associationId: params.associationId },
        })
      ).id;

    const accountLink = await this.stripe.accountLinks.create({
      account: accountId,
      refresh_url: params.refreshUrl,
      return_url: params.returnUrl,
      type: 'account_onboarding',
    });

    return { url: accountLink.url, accountId };
  }

  async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = params.lineItems.map(
      (item) => ({
        price_data: {
          currency: item.currency,
          product_data: { name: item.productName },
          unit_amount: item.unitAmountCents,
        },
        quantity: item.quantity,
      })
    );

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      metadata: params.metadata,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    };

    if (params.customerId) {
      sessionParams.customer = params.customerId;
    }

    if (params.saveForFuture) {
      sessionParams.payment_intent_data = {
        ...sessionParams.payment_intent_data,
        setup_future_usage: 'off_session',
      };
    }

    // Destination charge: funds go to the connected account
    if (params.connectAccountId) {
      sessionParams.payment_intent_data = {
        ...sessionParams.payment_intent_data,
        transfer_data: {
          destination: params.connectAccountId,
        },
      };
    }

    const requestOptions: Stripe.RequestOptions | undefined = params.idempotencyKey
      ? { idempotencyKey: `checkout_${params.idempotencyKey}` }
      : undefined;

    const session = await this.stripe.checkout.sessions.create(sessionParams, requestOptions);

    return { id: session.id, url: session.url };
  }

  async getAccountStatus(accountId: string): Promise<{ chargesEnabled: boolean }> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    const account = await this.stripe.accounts.retrieve(accountId);
    return { chargesEnabled: account.charges_enabled ?? false };
  }

  async getConnectAccountStatus(accountId: string): Promise<StripeConnectStatusResponse> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    const account = await this.stripe.accounts.retrieve(accountId);
    this.logger.debug(
      `[Stripe] Connect status account=${accountId.slice(0, 8)} charges=${account.charges_enabled} details=${account.details_submitted}`
    );
    return buildStripeConnectStatusResponse(account);
  }

  /**
   * Returns available and pending balances for a Connect Standard account.
   * Prefers EUR when present; otherwise uses the first currency in the response.
   */
  async getConnectBalance(accountId: string): Promise<ConnectBalanceSummary> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    // v22: stripeAccount is a request option, no longer mixed into params.
    const balance = await this.stripe.balance.retrieve({}, { stripeAccount: accountId });
    const currency =
      balance.available.find((b) => b.currency === 'eur')?.currency ??
      balance.available[0]?.currency ??
      balance.pending[0]?.currency ??
      'eur';
    const available = balance.available.find((b) => b.currency === currency)?.amount ?? 0;
    const pending = balance.pending.find((b) => b.currency === currency)?.amount ?? 0;

    this.logger.debug(
      `[Stripe] Connect balance account=${accountId.slice(0, 8)} available=${available} pending=${pending} ${currency}`
    );

    return {
      availableCents: available,
      pendingCents: pending,
      currency,
    };
  }

  /**
   * Returns a URL to manage payouts for a Connect account.
   * Express accounts get a single-use login link; Standard accounts use dashboard.stripe.com
   * (createLoginLink is Express-only and fails on Standard accounts).
   */
  async createConnectDashboardLink(accountId: string): Promise<string> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const account = await this.stripe.accounts.retrieve(accountId);
    this.logger.debug(
      `[Stripe] Dashboard link account=${accountId.slice(0, 8)} type=${account.type}`
    );

    if (account.type === 'express') {
      const link = await this.stripe.accounts.createLoginLink(accountId);
      return link.url;
    }

    return 'https://dashboard.stripe.com';
  }

  // ── Customer & Payment Methods ────────────────────────────────────────────

  async getOrCreateCustomer(
    existingCustomerId: string | null | undefined,
    meta: { userId: string; displayName?: string | null }
  ): Promise<string> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    if (existingCustomerId) {
      try {
        const customer = await this.stripe.customers.retrieve(existingCustomerId);
        if (!customer.deleted) return existingCustomerId;
      } catch {
        // Customer no longer exists - create a new one
      }
    }

    // Idempotency key scoped to the userId prevents duplicate Stripe customers when
    // two concurrent requests both see stripeCustomerId as null.
    const customer = await this.stripe.customers.create(
      {
        metadata: { userId: meta.userId },
        name: meta.displayName ?? undefined,
      },
      { idempotencyKey: `customer-create-${meta.userId}` }
    );
    return customer.id;
  }

  async createSetupCheckoutSession(params: {
    customerId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const session = await this.stripe.checkout.sessions.create({
      mode: 'setup',
      customer: params.customerId,
      payment_method_types: ['card'],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });

    return { url: session.url!, sessionId: session.id };
  }

  async listPaymentMethods(customerId: string): Promise<SavedPaymentMethod[]> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const methods = await this.stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    });

    return methods.data.map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand ?? 'unknown',
      last4: pm.card?.last4 ?? '????',
      expMonth: pm.card?.exp_month ?? 0,
      expYear: pm.card?.exp_year ?? 0,
    }));
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async chargeWithSavedMethod(params: ChargeWithSavedMethodParams): Promise<ChargeResult> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: params.amountCents,
      currency: params.currency.toLowerCase(),
      customer: params.customerId,
      payment_method: params.paymentMethodId,
      // Required for off-session charges with a saved card - dynamic payment methods
      // do not apply when creating a PaymentIntent directly (unlike Checkout).
      payment_method_types: ['card'],
      confirm: true,
      off_session: true,
      metadata: params.metadata,
    };

    if (params.connectAccountId) {
      intentParams.transfer_data = {
        destination: params.connectAccountId,
      };
    }

    const requestOptions: Stripe.RequestOptions = {};
    if (params.idempotencyKey) {
      requestOptions.idempotencyKey = `charge_${params.idempotencyKey}`;
    }

    try {
      const intent = await this.stripe.paymentIntents.create(intentParams, requestOptions);
      if (intent.status === 'succeeded') {
        return { ok: true, paymentReference: intent.id };
      }
      if (intent.status === 'requires_action' && intent.client_secret) {
        return {
          ok: false,
          requiresAction: true,
          clientSecret: intent.client_secret,
        };
      }
      return {
        ok: false,
        error: `Unexpected payment status: ${intent.status}`,
      };
    } catch (err: unknown) {
      const stripeErr = err as {
        code?: string;
        payment_intent?: { client_secret?: string };
        message?: string;
      };
      if (
        stripeErr?.code === 'authentication_required' &&
        stripeErr?.payment_intent?.client_secret
      ) {
        return {
          ok: false,
          requiresAction: true,
          clientSecret: stripeErr.payment_intent.client_secret,
        };
      }
      this.logger.error(
        `[Stripe] chargeWithSavedMethod failed: ${stripeErr?.message ?? (err instanceof Error ? err.message : String(err))}`
      );
      return {
        ok: false,
        error: stripeErr?.message ?? 'Payment failed',
      };
    }
  }

  async retrieveSession(sessionId: string): Promise<CheckoutSessionInfo> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    return {
      id: session.id,
      paid: session.payment_status === 'paid',
      metadata: session.metadata ?? {},
    };
  }
}
