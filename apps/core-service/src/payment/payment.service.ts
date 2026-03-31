import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import Stripe from 'stripe';

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

    // Destination charge: funds go to the connected account
    if (params.stripeConnectAccountId) {
      sessionParams.payment_intent_data = {
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
}
