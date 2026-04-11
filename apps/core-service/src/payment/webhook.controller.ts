import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Controller('payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);
  private readonly stripe: Stripe;

  constructor(private readonly config: ConfigService) {
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
            this.config.get<string>('FORM_URL') || 'http://localhost:3014';
          const url = `${formServiceBase.replace(/\/$/, '')}/api/forms/submissions/${submissionId}/mark-paid`;
          await axios.post(url, { sessionId: session.id }, { maxRedirects: 0 });
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
      } else {
        this.logger.warn(
          'checkout.session.completed without submissionId metadata',
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
              this.config.get<string>('FORM_URL') || 'http://localhost:3014';
            const url = `${socialServiceBase.replace(/\/$/, '')}/api/associations/${associationId}/stripe-complete`;
            await axios.post(url, undefined, { maxRedirects: 0 });
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
