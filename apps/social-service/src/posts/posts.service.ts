/* eslint-disable */
import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import { Post } from './entities/post.entity';
import * as cheerio from 'cheerio';
import { URL } from 'url';

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);
  private readonly userServiceUrl: string;

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.userServiceUrl = configService.get<string>('USER_SERVICE_URL', 'http://core-service:3012');
  }

  async createPost(data: any) {
    const post = this.postRepo.create(data);
    return this.postRepo.save(post);
  }

  async listPosts(limit: number = 20, offset: number = 0) {
    return this.postRepo.find({
      order: { createdAt: 'DESC' },
      take: Number(limit),
      skip: Number(offset),
    });
  }

  async listMentions(userId: string, limit = 20) {
    return this.postRepo
      .createQueryBuilder('post')
      .where('post.mentions LIKE :userId', { userId: `%${userId}%` })
      .orderBy('post.createdAt', 'DESC')
      .take(Number(limit))
      .getMany();
  }

  async getById(id: string) {
    return this.postRepo.findOne({ where: { id } });
  }

  async setLinks(id: string, data: any) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();
    post.links = [...(post.links || []), ...data.links];
    return this.postRepo.save(post);
  }

  async setImages(id: string, data: any) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();
    post.images = [...(post.images || []), ...data.images];
    return this.postRepo.save(post);
  }

  async setForm(id: string, formId: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();
    post.attachedFormId = formId;
    return this.postRepo.save(post);
  }

  async parsePostLinks(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = post.markdown?.match(urlRegex) || [];
    if (!urls.length) return post;

    const newLinks: any[] = [];
    for (const url of urls) {
      if (post.links?.some((l: any) => l.url === url)) continue;
      try {
        const meta = await this.fetchUrlMeta(url);
        if (meta) {
          newLinks.push({
            url,
            title: meta.title || url,
            description: meta.description,
            imageUrl: meta.image,
          });
        }
      } catch (err) {
        this.logger.error(`Failed to parse URL: ${url}`, err);
      }
    }

    if (newLinks.length > 0) {
      post.links = [...(post.links || []), ...newLinks];
      return this.postRepo.save(post);
    }

    return post;
  }

  private async fetchUrlMeta(url: string) {
    try {
      const resp = await lastValueFrom(
        this.httpService.get(url, {
          timeout: 3000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Bot)' },
        })
      );
      if (!resp.data) return null;

      const $ = cheerio.load(resp.data);
      const title = $('head title').text() || $('meta[property="og:title"]').attr('content');
      const description =
        $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content');
      const image = $('meta[property="og:image"]').attr('content');

      return { title, description, image };
    } catch {
      return null;
    }
  }

  async notifyMentions(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post || !post.mentions?.length) return post;

    this.logger.log(`Notifying mentions for post ${id}: ${post.mentions.join(',')}`);
    return post;
  }

  async addPoll(id: string, question: string, options: string[]) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();

    const { randomUUID } = await import('crypto');
    const poll = {
      id: randomUUID(),
      question,
      options: options.map((opt) => ({
        id: randomUUID(),
        text: opt,
        votes: [],
      })),
    };

    post.polls = [...(post.polls || []), poll];
    return this.postRepo.save(post);
  }

  async votePoll(postId: string, pollId: string, data: any) {
    const post = await this.postRepo
      .createQueryBuilder('post')
      .where('post.id = :postId', { postId })
      .getOne();

    if (!post) throw new NotFoundException('Poll not found');

    let updated = false;
    for (const p of post.polls || []) {
      if (p.id === pollId) {
        for (const opt of p.options) {
          opt.votes = (opt.votes || []).filter((v: string) => v !== data.userId);
        }
        const targetOpt = p.options.find(
          (o: any) => data.optionIds?.includes(o.id) || o.id === data.optionId
        );
        if (targetOpt) {
          targetOpt.votes.push(data.userId);
          updated = true;
        }
      }
    }

    if (updated) {
      return this.postRepo.save(post);
    }
    return post;
  }

  async addEventButton(id: string, text: string, eventPayload: any) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();

    const { randomUUID } = await import('crypto');
    const btn = {
      id: randomUUID(),
      text,
      eventPayload,
      clickCount: 0,
    };

    post.eventButtons = [...(post.eventButtons || []), btn];
    return this.postRepo.save(post);
  }

  async registerEvent(postId: string, buttonId: string, data: any) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');

    const buttons: any[] = post.eventButtons || [];
    const btnIndex = buttons.findIndex((b: any) => b.id === buttonId);
    if (btnIndex === -1) throw new NotFoundException('Event button not found');

    const btn = { ...buttons[btnIndex] };
    if (!Array.isArray(btn.registrants)) btn.registrants = [];

    if (btn.capacity && btn.registrants.length >= btn.capacity) {
      throw new BadRequestException('Event is full');
    }

    if (btn.registrants.includes(data.userId)) {
      return { alreadyRegistered: true, requiresPayment: false };
    }

    if (btn.requiresPayment && btn.amountCents > 0) {
      const paymentBase =
        this.configService.get<string>('PAYMENT_SERVICE_URL') || 'http://core-service:3012';
      const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost';
      try {
        const res = await lastValueFrom(
          this.httpService.post(
            `${paymentBase.replace(/\/$/, '')}/api/payments/create-checkout-session`,
            {
              lineItems: [
                {
                  price_data: {
                    currency: (btn.currency || 'eur').toLowerCase(),
                    product_data: { name: btn.label },
                    unit_amount: btn.amountCents,
                  },
                  quantity: 1,
                },
              ],
              successUrl: `${frontendUrl}/posts?registered=${buttonId}`,
              cancelUrl: `${frontendUrl}/posts`,
              metadata: { postId, buttonId, userId: data.userId },
            }
          )
        );
        const checkoutUrl = (res.data as any)?.url;
        if (checkoutUrl) {
          return { requiresPayment: true, checkoutUrl };
        }
      } catch (err: any) {
        this.logger.error('Payment service error', err?.response?.data || err.message);
      }
      return { requiresPayment: true, message: 'Payment service unavailable' };
    }

    btn.registrants = [...btn.registrants, data.userId];
    const updated = [...buttons];
    updated[btnIndex] = btn;
    post.eventButtons = updated;
    await this.postRepo.save(post);

    return { registered: true, requiresPayment: false };
  }

  async submitForm(postId: string, _formId: string, _data: any) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException();

    // Check user service (Phase 3.7)
    try {
      const userRes = await lastValueFrom(
        this.httpService.get(`${this.userServiceUrl}/users/${_data.userId}`)
      );
      this.logger.log(`Successfully communicated with user-service for user ${_data.userId}`);
    } catch (err: any) {
      this.logger.error(
        `Failed inter-service communication with user-service for ${_data.userId}: ${err.message}`
      );
    }

    return { success: true };
  }

  async delete(id: string) {
    await this.postRepo.delete(id);
    return { success: true };
  }
}
