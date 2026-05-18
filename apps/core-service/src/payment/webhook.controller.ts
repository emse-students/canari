import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { UsersService } from '../users/users.service';

/** Parse a service base URL for server-to-server calls: http(s) only, no userinfo, path must be empty or "/". */
function parseSafeServiceOrigin(raw: string, envName: string): URL {
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${envName} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${envName} must not include credentials`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`${envName} must be an origin only (no path)`);
  }
  return parsed;
}

@Controller('payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = key
      ? new Stripe(key, { apiVersion: '2026-03-25.dahlia' })
      : (null as unknown as Stripe);
  }

  @Post('webhook')
  async handle(@Req() req: Request, @Res() res: Response) {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    let event: Stripe.Event;

    try {
      if (webhookSecret) {
        const sig = req.headers['stripe-signature'] as string;
        const raw = req.body as Buffer;
        event = this.stripe.webhooks.constructEvent(raw, sig, webhookSecret);
      } else if (process.env.NODE_ENV === 'production') {
        this.logger.error(
          'STRIPE_WEBHOOK_SECRET is required in production — refusing unsigned webhook',
        );
        return res
          .status(503)
          .send('Stripe webhook signing secret not configured');
      } else {
        event = req.body as Stripe.Event;
      }
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(
        'Webhook signature verification failed',
        error?.message || error,
      );
      return res.status(400).send(`Webhook Error: ${error?.message || error}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const submissionId = session.metadata?.submissionId;
      const productId = session.metadata?.productId;
      const userId = session.metadata?.userId;

      // Save the Stripe customer ID back to the user if they just paid for the first time
      if (userId && session.customer && typeof session.customer === 'string') {
        const customerId = session.customer;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) {
          this.logger.error(`Invalid userId in webhook metadata: ${userId}`);
        } else {
          try {
            const user = await this.usersService
              .findOne(userId)
              .catch(() => null);
            if (user && !user.stripeCustomerId) {
              await this.usersService.update(userId, {
                stripeCustomerId: customerId,
              });
              this.logger.log(
                `Saved stripeCustomerId ${customerId} for user ${userId}`,
              );
            }
          } catch (err: unknown) {
            const error = err as Error;
            this.logger.error(
              'Failed to save stripeCustomerId to user',
              error?.message,
            );
          }
        }
      }

      if (submissionId) {
        // Prevent SSRF: submissionId originates from Stripe session metadata which was
        // set by the client at checkout creation time — validate before embedding in URL.
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(submissionId)) {
          this.logger.error(
            `Invalid submissionId in webhook metadata: ${submissionId}`,
          );
          return res.status(400).send('Invalid submissionId');
        }
        try {
          const formServiceBase =
            this.config.get<string>('FORM_SERVICE_URL') ||
            'http://localhost:3014';
          const parsedBase = parseSafeServiceOrigin(
            formServiceBase,
            'FORM_SERVICE_URL',
          );
          const url = new URL(
            `/api/forms/submissions/${encodeURIComponent(submissionId)}/mark-paid`,
            `${parsedBase.origin}/`,
          ).href;
          await axios.post(
            url,
            { sessionId: session.id },
            {
              maxRedirects: 0,
              timeout: 15_000,
              validateStatus: (s) => s >= 200 && s < 300,
            },
          );
          this.logger.log(
            `Marked submission ${submissionId} as paid via form-service`,
          );
        } catch (err: unknown) {
          const error = err as Error & { response?: { data?: unknown } };
          this.logger.error(
            'Failed to notify form-service about payment',
            error?.response?.data || error?.message || error,
          );
          return res.status(500).send('Failed to notify form-service');
        }
      } else if (productId && userId) {
        // Boutique product purchase — notify social-service
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId)
        ) {
          this.logger.error(`Invalid productId in webhook metadata: ${productId}`);
          return res.status(400).send('Invalid productId');
        }
        try {
          const socialBase =
            this.config.get<string>('SOCIAL_SERVICE_URL') ||
            'http://localhost:3014';
          const parsedBase = parseSafeServiceOrigin(
            socialBase,
            'SOCIAL_SERVICE_URL',
          );
          const url = new URL(
            `/api/associations/products/${encodeURIComponent(productId)}/purchase-completed`,
            `${parsedBase.origin}/`,
          ).href;
          await axios.post(
            url,
            {
              userId,
              amountCents: session.amount_total ?? 0,
              paymentIntentId:
                typeof session.payment_intent === 'string'
                  ? session.payment_intent
                  : '',
            },
            {
              maxRedirects: 0,
              timeout: 15_000,
              validateStatus: (s) => s >= 200 && s < 300,
            },
          );
          this.logger.log(
            `Product purchase completed: productId=${productId} userId=${userId}`,
          );
        } catch (err: unknown) {
          const error = err as Error & { response?: { data?: unknown } };
          this.logger.error(
            'Failed to notify social-service about product purchase',
            error?.response?.data || error?.message || error,
          );
          return res.status(500).send('Failed to notify social-service');
        }
      } else {
        this.logger.warn(
          'checkout.session.completed without submissionId or productId metadata',
        );
      }
    }

    if (event.type === 'account.updated') {
      const account = event.data.object;
      const associationId = account.metadata?.associationId;
      if (associationId && account.charges_enabled) {
        // Prevent SSRF: associationId originates from Stripe account metadata which was
        // set by the client at onboarding time — validate before embedding in URL.
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(associationId)) {
          this.logger.error(
            `Invalid associationId in webhook metadata: ${associationId}`,
          );
        } else {
          try {
            const socialServiceBase =
              this.config.get<string>('SOCIAL_SERVICE_URL') ||
              'http://localhost:3014';
            const parsedBase = parseSafeServiceOrigin(
              socialServiceBase,
              'SOCIAL_SERVICE_URL',
            );
            const url = new URL(
              `/api/associations/${encodeURIComponent(associationId)}/stripe-complete`,
              `${parsedBase.origin}/`,
            ).href;
            await axios.post(url, undefined, {
              maxRedirects: 0,
              timeout: 15_000,
              validateStatus: (s) => s >= 200 && s < 300,
            });
            this.logger.log(
              `Marked association ${associationId} stripe onboarding complete`,
            );
          } catch (err: unknown) {
            const error = err as Error & { response?: { data?: unknown } };
            this.logger.error(
              'Failed to notify social-service about stripe onboarding',
              error?.response?.data || error?.message || error,
            );
          }
        }
      }
    }

    return res.json({ received: true });
  }
}
