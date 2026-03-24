import { BadRequestException, Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClientProxy } from '@nestjs/microservices';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CreatePostDto, RegisterEventDto, VotePollDto, SubmitFormDto } from './dto/post.dto';
import { Post } from './schemas/post.schema';

const LINK_REGEX = /(https?:\/\/[^\s)\]]+)/gi;
const MENTION_REGEX = /@([a-zA-Z0-9_-]{2,64})/g;

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

@Injectable()
export class PostsService {
  private readonly stripe: Stripe | null;
  private readonly logger = new Logger(PostsService.name);
  private readonly userServiceUrl: string;

  constructor(
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @Inject('KAFKA_CLIENT') private readonly kafkaClient: ClientProxy,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    this.stripe = secretKey ? new Stripe(secretKey, { apiVersion: '2025-08-27.basil' }) : null;
    this.userServiceUrl = this.configService.get<string>(
      'USER_SERVICE_URL',
      'http://localhost:3004'
    );
  }

  async createPost(input: CreatePostDto) {
    const authorId = input.authorId.trim();
    const markdown = input.markdown.trim();

    const links = this.extractLinks(markdown).map((url) => ({ url }));
    const mentions = this.extractMentions(markdown);
    const now = new Date();

    const polls = (input.polls ?? []).map((poll) => ({
      id: poll.id?.trim() || makeId('poll'),
      question: poll.question.trim(),
      options: poll.options.map((opt) => ({
        id: makeId('opt'),
        label: opt.label.trim(),
        votes: 0,
      })),
      multipleChoice: Boolean(poll.multipleChoice),
      endsAt: poll.endsAt ? new Date(poll.endsAt) : undefined,
      votesByUser: {},
    }));

    const eventButtons = (input.eventButtons ?? []).map((button) => ({
      id: button.id?.trim() || makeId('event_btn'),
      label: button.label.trim(),
      eventId: button.eventId.trim(),
      requiresPayment: Boolean(button.requiresPayment),
      amountCents: button.amountCents,
      currency: (button.currency || 'eur').toLowerCase(),
      stripePriceId: button.stripePriceId,
      capacity: button.capacity,
      registrants: [],
    }));

    const forms = (input.forms ?? []).map((form) => ({
      id: form.id?.trim() || makeId('form'),
      title: form.title.trim(),
      eventId: form.eventId.trim(),
      basePrice: form.basePrice,
      currency: (form.currency || 'eur').toLowerCase(),
      submitLabel: form.submitLabel.trim(),
      items: form.items.map((item) => ({
        id: item.id?.trim() || makeId('item'),
        label: item.label.trim(),
        required: item.required,
        type: item.type,
        options: (item.options ?? []).map((opt) => ({
          id: opt.id?.trim() || makeId('opt'),
          label: opt.label.trim(),
          priceModifier: opt.priceModifier,
        })),
        rows: item.rows,
        scale: item.scale,
      })),
    }));

    for (const btn of eventButtons) {
      if (btn.requiresPayment && !btn.amountCents && !btn.stripePriceId) {
        throw new BadRequestException('paid event button requires amountCents or stripePriceId');
      }
    }

    const post = await this.postModel.create({
      authorId,
      markdown,
      mentions,
      links,
      images: input.images ?? [],
      polls,
      eventButtons,
      forms,
      attachedFormId: input.attachedFormId,
      createdAt: now,
      updatedAt: now,
    });

    this.kafkaClient.emit('post.created', post).subscribe();
    return post;
  }

  async listPosts(limit: number, offset: number = 0) {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const safeOffset = Math.max(0, offset);
    return await this.postModel
      .find()
      .sort({ createdAt: -1 })
      .skip(safeOffset)
      .limit(safeLimit)
      .lean();
  }

  async votePoll(postId: string, pollId: string, input: VotePollDto) {
    const post = await this.postModel.findById(postId);
    if (!post) {
      throw new NotFoundException('post not found');
    }

    const userId = input.userId.trim();

    const poll = post.polls.find((p) => p.id === pollId);
    if (!poll) {
      throw new NotFoundException('poll not found');
    }
    if (poll.endsAt && new Date(poll.endsAt).getTime() < Date.now()) {
      throw new BadRequestException('poll is closed');
    }

    const optionIds = [...new Set(input.optionIds)].filter(Boolean);

    if (!poll.multipleChoice && optionIds.length > 1) {
      throw new BadRequestException('this poll does not allow multiple selections');
    }

    const votesByUser = (poll.votesByUser as Record<string, string[]>) || {};
    const existing = votesByUser[userId] ?? [];

    for (const previous of existing) {
      const prevOpt = poll.options.find((o) => o.id === previous);
      if (prevOpt && prevOpt.votes > 0) {
        prevOpt.votes -= 1;
      }
    }

    for (const selected of optionIds) {
      const option = poll.options.find((o) => o.id === selected);
      if (!option) {
        throw new BadRequestException(`invalid option id: ${selected}`);
      }
      option.votes += 1;
    }

    votesByUser[userId] = optionIds;
    poll.votesByUser = votesByUser;

    post.markModified('polls');
    post.updatedAt = new Date();
    await post.save();

    return {
      ok: true,
      poll,
    };
  }

  async registerEvent(postId: string, buttonId: string, input: RegisterEventDto) {
    const post = await this.postModel.findById(postId);
    if (!post) {
      throw new NotFoundException('post not found');
    }

    const userId = input.userId.trim();
    const button = post.eventButtons.find((b) => b.id === buttonId);
    if (!button) {
      throw new NotFoundException('event button not found');
    }

    if (button.registrants.includes(userId)) {
      return { ok: true, alreadyRegistered: true, requiresPayment: button.requiresPayment };
    }

    if (button.capacity && button.registrants.length >= button.capacity) {
      throw new BadRequestException('event is full');
    }

    if (!button.requiresPayment) {
      button.registrants.push(userId);
      post.markModified('eventButtons');
      post.updatedAt = new Date();
      await post.save();
      return {
        ok: true,
        registered: true,
        requiresPayment: false,
      };
    }

    if (!this.stripe) {
      this.logger.warn('Stripe is not configured but a paid event was requested');
      return {
        ok: true,
        registered: false,
        requiresPayment: true,
        paymentPending: true,
        message: 'Stripe not configured on post-service',
      };
    }

    const successUrl = this.configService.get<string>(
      'STRIPE_SUCCESS_URL',
      'http://localhost:5173/posts?registration=success'
    );
    const cancelUrl = this.configService.get<string>(
      'STRIPE_CANCEL_URL',
      'http://localhost:5173/posts?registration=cancel'
    );

    let customerId: string | undefined;

    // Fetch user from user-service
    try {
      const userRes = await firstValueFrom(
        this.httpService.get(`${this.userServiceUrl}/users/${userId}`)
      );
      customerId = userRes.data?.stripeCustomerId;
    } catch (err: any) {
      if (err.response?.status === 404) {
        this.logger.warn(
          `User ${userId} not found in user-service, will attempt creation upon successful stripe customer gen`
        );
      } else {
        this.logger.error(`Failed to fetch user from user-service: ${err.message}`);
      }
    }

    if (!customerId) {
      // Create new customer
      try {
        const customer = await this.stripe.customers.create({
          email: input.email,
          metadata: { userId },
        });
        customerId = customer.id;

        // Update user-service
        try {
          await firstValueFrom(
            this.httpService.patch(`${this.userServiceUrl}/users/${userId}`, {
              stripeCustomerId: customerId,
            })
          );
        } catch (updateErr: any) {
          if (updateErr.response?.status === 404) {
            await firstValueFrom(
              this.httpService.post(`${this.userServiceUrl}/users`, {
                id: userId,
                email: input.email || `user-${userId}@example.com`,
                stripeCustomerId: customerId,
              })
            );
          } else {
            this.logger.error(
              `Failed to sync stripeCustomerId to user-service: ${updateErr.message}`
            );
          }
        }
      } catch (err: any) {
        this.logger.error('Failed to create Stripe customer', err.stack);
        throw new BadRequestException(`Failed to create payment profile: ${err.message}`);
      }
    }

    let session;
    try {
      const lineItems = button.stripePriceId
        ? [{ price: button.stripePriceId, quantity: 1 }]
        : [
            {
              quantity: 1,
              price_data: {
                currency: button.currency || 'eur',
                unit_amount: button.amountCents || 0,
                product_data: {
                  name: button.label,
                  description: `Registration for ${button.eventId}`,
                },
              },
            },
          ];

      session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer: customerId,
        customer_update: {
          address: 'auto',
          name: 'auto',
        },
        payment_intent_data: {
          setup_future_usage: 'off_session',
        },
        metadata: {
          postId,
          buttonId,
          userId,
        },
        line_items: lineItems,
      });
    } catch (err: any) {
      this.logger.error('Stripe checkout session creation failed', err.stack);
      throw new BadRequestException(`Failed to initiate payment: ${err.message}`);
    }

    return {
      ok: true,
      requiresPayment: true,
      paymentPending: true,
      checkoutUrl: session.url,
      sessionId: session.id,
    };
  }

  async submitForm(postId: string, formId: string, input: SubmitFormDto) {
    const post = await this.postModel.findById(postId);
    if (!post) throw new NotFoundException('post not found');

    const form = (post.forms || []).find((f) => f.id === formId);
    if (!form) throw new NotFoundException('form not found');

    const userId = input.userId.trim();
    let totalCents = form.basePrice;
    const currency = form.currency.toLowerCase();

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

    if (form.basePrice > 0) {
      lineItems.push({
        price_data: {
          currency,
          product_data: {
            name: `${form.title} (Registration)`,
          },
          unit_amount: form.basePrice,
        },
        quantity: 1,
      });
    }

    // Validate selections & modifiers
    for (const item of form.items) {
      const selectedValue = input.selections[item.id];

      // Check required
      if (item.required) {
        let isPresent = false;
        if (Array.isArray(selectedValue)) {
          isPresent = selectedValue.length > 0;
        } else if (selectedValue && typeof selectedValue === 'object') {
          isPresent = Object.keys(selectedValue).length > 0;
        } else {
          isPresent = !!selectedValue;
        }

        if (!isPresent) {
          throw new BadRequestException(`Missing required field: ${item.label}`);
        }
      }

      // Calculate Price Modifiers
      if (selectedValue && item.options && item.options.length > 0) {
        const processOption = (optId: string) => {
          const option = item.options?.find((o) => o.id === optId);
          if (option && option.priceModifier !== 0) {
            totalCents += option.priceModifier;
            if (option.priceModifier > 0) {
              lineItems.push({
                price_data: {
                  currency,
                  product_data: {
                    name: `${item.label}: ${option.label}`,
                  },
                  unit_amount: option.priceModifier,
                },
                quantity: 1,
              });
            }
          }
        };

        if (Array.isArray(selectedValue)) {
          (selectedValue as string[]).forEach(processOption);
        } else if (typeof selectedValue === 'object') {
          Object.values(selectedValue)
            .flat()
            .forEach((val: any) => {
              if (typeof val === 'string') processOption(val);
            });
        } else if (typeof selectedValue === 'string') {
          processOption(selectedValue);
        }
      }
    }

    if (totalCents <= 0) {
      return { ok: true, requiresPayment: false, message: 'Free registration confirmed.' };
    }

    if (!this.stripe) {
      return {
        ok: false,
        requiresPayment: true,
        message: 'Stripe not configured on backend.',
      };
    }

    // Stripe Customer Logic
    let customerId: string | undefined;
    try {
      const userRes = await firstValueFrom(
        this.httpService.get(`${this.userServiceUrl}/users/${userId}`)
      );
      customerId = userRes.data?.stripeCustomerId;
    } catch (err) {
      // ignore
    }

    if (!customerId) {
      try {
        const c = await this.stripe.customers.create({
          email: input.email,
          metadata: { userId },
        });
        customerId = c.id;
        // Try update user service... (omitted for brevity here as it's best effort)
      } catch (e) {
        this.logger.warn('Failed to create stripe customer', e);
      }
    }

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer: customerId,
      line_items: lineItems,
      mode: 'payment',
      success_url: process.env.STRIPE_SUCCESS_URL || 'http://localhost:5173/posts?success=true',
      cancel_url: process.env.STRIPE_CANCEL_URL || 'http://localhost:5173/posts?cancel=true',
      metadata: {
        userId,
        postId,
        formId,
        type: 'form_submission',
      },
    });

    return {
      ok: true,
      requiresPayment: true,
      checkoutUrl: session.url,
    };
  }

  private extractLinks(markdown: string): string[] {
    return [...new Set(Array.from(markdown.matchAll(LINK_REGEX), (m) => m[1]))];
  }

  private extractMentions(markdown: string): string[] {
    return [...new Set(Array.from(markdown.matchAll(MENTION_REGEX), (m) => m[1]))];
  }
}
