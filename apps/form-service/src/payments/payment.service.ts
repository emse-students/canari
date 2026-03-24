import { Injectable, BadRequestException, NotFoundException, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Stripe from 'stripe';
import { Association } from '../schemas/association.schema';
import { User } from '../schemas/user.schema';
import { Event } from '../schemas/event.schema';

@Injectable()
export class PaymentService {
  private stripe: Stripe;

  constructor(
    @InjectModel(Association.name) private associationModel: Model<Association>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Event.name) private eventModel: Model<Event>,
  ) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_123', { apiVersion: '2025-01-27.acacia' as any });
  }

  // --- CREATION USER & STRIPE CUSTOMER ---
  async createUser(userData: { email: string; name: string }) {
    const customer = await this.stripe.customers.create({
      email: userData.email,
      name: userData.name,
    });

    const newUser = new this.userModel({
      ...userData,
      stripeCustomerId: customer.id,
    });

    return newUser.save();
  }

  // --- ONBOARDING ASSOCIATION ---
  async createOnboardingLink(associationId: string) {
    const association = await this.associationModel.findById(associationId);
    if (!association) throw new NotFoundException('Association introuvable');

    let accountId = association.stripeAccountId;

    if (!accountId) {
      const account = await this.stripe.accounts.create({
        type: 'express',
        capabilities: {
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      association.stripeAccountId = accountId;
      await association.save();
    }

    const accountLink = await this.stripe.accountLinks.create({
      account: accountId,
      refresh_url: process.env.STRIPE_REFRESH_URL || 'http://localhost:3000/refresh',
      return_url: process.env.STRIPE_RETURN_URL || 'http://localhost:3000/return',
      type: 'account_onboarding',
    });

    return { url: accountLink.url };
  }

  // --- CHECKOUT SESSION ---
  async createCheckoutSession(userId: string, eventId: string, options: { isMemberBDE: boolean; wantsMeal: boolean }) {
    const user = await this.userModel.findById(userId);
    if (!user || !user.stripeCustomerId) throw new BadRequestException('Utilisateur ou ID Client Stripe manquant');

    // Replace populate logic with standard mongoose find to avoid typing issues from mongoose types
    const event = await this.eventModel.findById(eventId).populate('association').exec();
    if (!event) throw new NotFoundException('Événement introuvable');

    const association = event.association as unknown as Association;
    if (!association.stripeAccountId) {
      throw new BadRequestException('L\'association organisatrice n\'est pas connectée à Stripe');
    }

    let finalPriceCents = event.basePriceCents;
    let description = `Billet pour ${event.name}`;

    if (options.isMemberBDE) {
      finalPriceCents -= 200; // ex: 2€ de réduction
      description += ' (Tarif Adhérent)';
    }
    if (options.wantsMeal) {
      finalPriceCents += 500; // ex: 5€ le repas
      description += ' + Repas';
    }

    if (finalPriceCents < 50) throw new BadRequestException('Le montant minimum est de 0.50€');

    const session = await this.stripe.checkout.sessions.create({
      customer: user.stripeCustomerId,
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
         {
          price_data: {
            currency: 'eur',
            product_data: {
              name: event.name,
              description: description,
            },
            unit_amount: finalPriceCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        setup_future_usage: 'on_session',
        transfer_data: {
          destination: association.stripeAccountId,
        },
      },
      metadata: {
        eventId: (event._id as any).toString(),
        userId: (user._id as any).toString(),
      },
      success_url: `${process.env.FRONTEND_URL || 'http://localhost'}/events/${eventId}/success`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost'}/events/${eventId}/cancel`,
    });

    return { url: session.url };
  }
}
