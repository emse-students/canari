import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CreatePostDto, RegisterEventDto, VotePollDto } from './dto/post.dto';
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

    for (const btn of eventButtons) {
      if (btn.requiresPayment && !btn.amountCents && !btn.stripePriceId) {
        throw new BadRequestException('paid event button requires amountCents or stripePriceId');
      }
    }

    return await this.postModel.create({
      authorId,
      markdown,
      mentions,
      links,
      images: input.images ?? [],
      polls,
      eventButtons,
      createdAt: now,
      updatedAt: now,
    });
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

  private extractLinks(markdown: string): string[] {
    return [...new Set(Array.from(markdown.matchAll(LINK_REGEX), (m) => m[1]))];
  }

  private extractMentions(markdown: string): string[] {
    return [...new Set(Array.from(markdown.matchAll(MENTION_REGEX), (m) => m[1]))];
  }
}
