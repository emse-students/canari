import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import Stripe from 'stripe';

export interface ChargeResult {
  ok: boolean;
  requiresAction?: boolean;
  clientSecret?: string;
  error?: string;
}

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

  isConfigured(): boolean {
    return !!this.stripe;
  }

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

  async createCheckoutSession(params: {
    lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    stripeConnectAccountId?: string;
    customerId?: string;
    saveForFuture?: boolean;
  }) {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
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

    const session = await this.stripe.checkout.sessions.create(sessionParams);

    return session;
  }

  async getAccountStatus(
    accountId: string,
  ): Promise<{ chargesEnabled: boolean }> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    const account = await this.stripe.accounts.retrieve(accountId);
    return { chargesEnabled: account.charges_enabled ?? false };
  }

  // ── Customer & Payment Methods ────────────────────────────────────────────

  async getOrCreateCustomer(
    existingCustomerId: string | null,
    meta: { userId: string; displayName?: string | null },
  ): Promise<string> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    if (existingCustomerId) {
      try {
        const customer =
          await this.stripe.customers.retrieve(existingCustomerId);
        if (!customer.deleted) return existingCustomerId;
      } catch {
        // Customer no longer exists — create a new one
      }
    }

    const customer = await this.stripe.customers.create({
      metadata: { userId: meta.userId },
      name: meta.displayName ?? undefined,
    });
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

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async chargeWithSavedMethod(params: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    currency: string;
    metadata?: Record<string, string>;
    stripeConnectAccountId?: string;
  }): Promise<ChargeResult> {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: params.amountCents,
      currency: params.currency,
      customer: params.customerId,
      payment_method: params.paymentMethodId,
      confirm: true,
      off_session: true,
      metadata: params.metadata,
    };

    if (params.stripeConnectAccountId) {
      intentParams.transfer_data = {
        destination: params.stripeConnectAccountId,
      };
    }

    try {
      const intent = await this.stripe.paymentIntents.create(intentParams);
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
      return {
        ok: false,
        error: stripeErr?.message ?? 'Payment failed',
      };
    }
  }
}
