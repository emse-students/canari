import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import {
  buildStripeConnectStatusResponse,
  type StripeConnectStatusResponse,
} from './stripeConnectStatus';

export interface ChargeResult {
  ok: boolean;
  requiresAction?: boolean;
  clientSecret?: string;
  error?: string;
}

/** Service wrapping Stripe SDK calls for Connect onboarding, checkout, and payment method management. */
@Injectable()
export class PaymentService {
  private readonly stripe: Stripe | null;
  private readonly logger = new Logger(PaymentService.name);

  constructor() {
    const key = process.env.STRIPE_SECRET_KEY;
    this.stripe = key
      ? new Stripe(key, { apiVersion: '2026-03-25.dahlia' })
      : null;
    this.logger.log(`Stripe configured: ${key ? 'yes' : 'no'}`);
  }

  /** Returns true when a Stripe secret key is present and the client is initialized. */
  isConfigured(): boolean {
    return !!this.stripe;
  }

  /** Creates or resumes a Stripe Connect account onboarding link for the given association. */
  async createConnectOnboarding(params: {
    associationId: string;
    refreshUrl: string;
    returnUrl: string;
    existingAccountId?: string;
  }): Promise<{ url: string; accountId: string }> {
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

  /** Creates a Stripe Checkout session in payment mode with optional Connect destination charge. */
  async createCheckoutSession(params: {
    lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    stripeConnectAccountId?: string;
    customerId?: string;
    saveForFuture?: boolean;
    /** Stable key for idempotency; derived from submission ID or a client-supplied UUID. */
    idempotencyKey?: string;
  }) {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: params.lineItems,
      metadata: params.metadata,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    };

    if (params.customerId) {
      sessionParams.customer = params.customerId;
    }

    if (params.saveForFuture) {
      sessionParams.payment_intent_data = {
        ...(sessionParams.payment_intent_data ?? {}),
        setup_future_usage: 'off_session',
      };
    }

    // Destination charge: funds go to the connected account
    if (params.stripeConnectAccountId) {
      sessionParams.payment_intent_data = {
        ...(sessionParams.payment_intent_data ?? {}),
        transfer_data: {
          destination: params.stripeConnectAccountId,
        },
      };
    }

    const requestOptions: Stripe.RequestOptions | undefined =
      params.idempotencyKey
        ? { idempotencyKey: `checkout_${params.idempotencyKey}` }
        : undefined;

    const session = await this.stripe.checkout.sessions.create(
      sessionParams,
      requestOptions,
    );

    return session;
  }

  /** Retrieves the charges-enabled status for a Stripe Connect account. */
  async getAccountStatus(
    accountId: string,
  ): Promise<{ chargesEnabled: boolean }> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    const account = await this.stripe.accounts.retrieve(accountId);
    return { chargesEnabled: account.charges_enabled ?? false };
  }

  /** Returns treasurer-facing Connect lifecycle state from the live Stripe account. */
  async getConnectAccountStatus(
    accountId: string,
  ): Promise<StripeConnectStatusResponse> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    const account = await this.stripe.accounts.retrieve(accountId);
    this.logger.debug(
      `[Stripe] Connect status account=${accountId.slice(0, 8)} charges=${account.charges_enabled} details=${account.details_submitted}`,
    );
    return buildStripeConnectStatusResponse(account);
  }

  // ── Customer & Payment Methods ────────────────────────────────────────────

  /** Returns the existing Stripe customer ID or creates a new customer and returns its ID. */
  async getOrCreateCustomer(
    existingCustomerId: string | null | undefined,
    meta: { userId: string; displayName?: string | null },
  ): Promise<string> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    if (existingCustomerId) {
      try {
        const customer =
          await this.stripe.customers.retrieve(existingCustomerId);
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
      { idempotencyKey: `customer-create-${meta.userId}` },
    );
    return customer.id;
  }

  /** Creates a Stripe Checkout session in setup mode so a customer can save a card for future use. */
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

  /** Lists all saved card payment methods attached to the given Stripe customer. */
  async listPaymentMethods(customerId: string): Promise<
    {
      id: string;
      brand: string;
      last4: string;
      expMonth: number;
      expYear: number;
    }[]
  > {
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

  /** Detaches a payment method from its Stripe customer so it can no longer be charged. */
  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  /** Charges a saved payment method off-session and returns the payment result or required-action details. */
  async chargeWithSavedMethod(params: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    currency: string;
    metadata?: Record<string, string>;
    stripeConnectAccountId?: string;
    /** Stable key for idempotency — prevents double-charge on network retry. */
    idempotencyKey?: string;
  }): Promise<ChargeResult> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: params.amountCents,
      currency: params.currency.toLowerCase(),
      customer: params.customerId,
      payment_method: params.paymentMethodId,
      // Required for off-session charges with a saved card — dynamic payment methods
      // do not apply when creating a PaymentIntent directly (unlike Checkout).
      payment_method_types: ['card'],
      confirm: true,
      off_session: true,
      metadata: params.metadata,
    };

    if (params.stripeConnectAccountId) {
      intentParams.transfer_data = {
        destination: params.stripeConnectAccountId,
      };
    }

    const requestOptions: Stripe.RequestOptions = {};
    if (params.idempotencyKey) {
      requestOptions.idempotencyKey = `charge_${params.idempotencyKey}`;
    }

    try {
      const intent = await this.stripe.paymentIntents.create(
        intentParams,
        requestOptions,
      );
      if (intent.status === 'succeeded') {
        return { ok: true };
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
        `[Stripe] chargeWithSavedMethod failed: ${stripeErr?.message ?? (err instanceof Error ? err.message : String(err))}`,
      );
      return {
        ok: false,
        error: stripeErr?.message ?? 'Payment failed',
      };
    }
  }

  /** Retrieves a Stripe Checkout session by ID. */
  async retrieveSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    return this.stripe.checkout.sessions.retrieve(sessionId);
  }
}
