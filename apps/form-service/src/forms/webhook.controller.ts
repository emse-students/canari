import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Submission } from './schemas/submission.schema';

@Controller('forms')
export class FormsWebhookController {
  private readonly logger = new Logger(FormsWebhookController.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Submission.name) private readonly submissionModel: Model<Submission>
  ) {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = secretKey
      ? new Stripe(secretKey, { apiVersion: '2025-08-27.basil' })
      : (null as unknown as Stripe);
  }

  @Post('webhook')
  async handleWebhook(@Req() req: Request, @Res() res: Response) {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    let event: Stripe.Event;

    // If webhook secret is configured, verify signature using raw body
    try {
      if (webhookSecret) {
        const sig = req.headers['stripe-signature'] as string;
        // req.body is a Buffer when using raw body parser for this route
        const raw = req.body as Buffer;
        event = this.stripe.webhooks.constructEvent(raw, sig, webhookSecret);
      } else {
        // Fallback: accept parsed JSON (insecure, for local/dev only)
        event = req.body as Stripe.Event;
      }
    } catch (err) {
      this.logger.error('Webhook signature verification failed', err as any);
      return res.status(400).send(`Webhook Error: ${(err as any).message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;

      try {
        const sessionId = session.id;
        // Try metadata.submissionId first
        const submissionId = session.metadata?.submissionId as string | undefined;

        let submission;
        if (submissionId) {
          submission = await this.submissionModel.findById(submissionId).exec();
        }

        if (!submission && sessionId) {
          submission = await this.submissionModel.findOne({ stripeSessionId: sessionId }).exec();
        }

        if (submission) {
          submission.paymentStatus = 'paid';
          await submission.save();
          this.logger.log(`Marked submission ${submission._id} as paid (session ${session.id})`);
        } else {
          this.logger.warn(`No submission found for session ${session.id}`);
        }
      } catch (err) {
        this.logger.error('Failed processing checkout.session.completed', err as any);
        return res.status(500).send('Error processing webhook');
      }
    }

    res.json({ received: true });
  }
}
