/* eslint-disable */
import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import * as cheerio from 'cheerio';
import { URL } from 'url';

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);
  private readonly userServiceUrl: string;

  private static readonly LIST_CACHE_TTL = 30; // seconds

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly redis: RedisService
  ) {
    this.userServiceUrl = configService.get<string>('USER_SERVICE_URL', 'http://core-service:3012');
  }

  private listCacheKey(limit: number, offset: number) {
    return `posts:list:${limit}:${offset}`;
  }

  private async invalidateListCache() {
    // Bust the most common pages; a full scan is overkill for 30s TTL.
    await this.redis.del(
      this.listCacheKey(20, 0),
      this.listCacheKey(30, 0),
      this.listCacheKey(50, 0)
    );
  }

  async createPost(data: any) {
    if (Array.isArray(data.eventButtons)) {
      data.eventButtons = data.eventButtons.map((btn: any) => ({
        ...btn,
        id: btn.id || crypto.randomUUID(),
        registrants: btn.registrants ?? [],
      }));
    }
    if (Array.isArray(data.polls)) {
      data.polls = data.polls.map((poll: any) => ({
        ...poll,
        id: poll.id || crypto.randomUUID(),
        multipleChoice: poll.multipleChoice ?? false,
        votesByUser: poll.votesByUser ?? {},
        options: (poll.options || []).map((opt: any) => ({
          ...opt,
          id: opt.id || crypto.randomUUID(),
          votes: opt.votes ?? 0,
        })),
      }));
    }
    const post = this.postRepo.create(data);
    const saved = await this.postRepo.save(post);
    await this.invalidateListCache();
    return saved;
  }

  async listPosts(limit: number = 20, offset: number = 0) {
    const cacheKey = this.listCacheKey(Number(limit), Number(offset));
    try {
      const cached = await Promise.race([this.redis.get(cacheKey), new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 100))]);
      if (cached) return JSON.parse(cached as string);
    } catch {
      // Redis miss or error — fall through to DB
    }

    // Raw SQL avoids deserializing the full comments JSONB through the ORM layer.
    // For posts with many comments this column can be hundreds of KB per row;
    // fetching all 50 posts × full comments caused the 20+ second response time.
    // Instead we compute the last 3 comments and a count directly in PostgreSQL.
    const rawPosts: any[] = await this.postRepo.manager.query(
      `SELECT
         id, "authorId", markdown, "createdAt", "updatedAt",
         mentions, links, "attachedFormId", "associationId", "paymentAssociationId",
         images, polls, "eventButtons", forms, reactions,
         jsonb_array_length(COALESCE(comments, '[]'::jsonb)) AS "commentCount",
         (
           SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
           FROM (
             SELECT elem, ord
             FROM jsonb_array_elements(COALESCE(comments, '[]'::jsonb))
               WITH ORDINALITY AS t(elem, ord)
             ORDER BY ord DESC LIMIT 3
           ) sub
         ) AS comments
       FROM posts
       ORDER BY "createdAt" DESC
       LIMIT $1 OFFSET $2`,
      [Number(limit), Number(offset)]
    );

    for (const post of rawPosts) {
      // TypeORM simple-array stores as comma-separated text; parse it back to array.
      if (typeof post.mentions === 'string') {
        post.mentions = post.mentions ? post.mentions.split(',').filter(Boolean) : [];
      } else {
        post.mentions = post.mentions ?? [];
      }
      post.commentCount = Number(post.commentCount) || 0;
      if (Array.isArray(post.eventButtons)) {
        for (const btn of post.eventButtons) {
          if (!Array.isArray(btn.registrants)) btn.registrants = [];
        }
      }
    }

    // Enrich with author display names (users table is in the same DB).
    const authorIds = [...new Set(rawPosts.map((p: any) => p.authorId).filter(Boolean))] as string[];
    let nameMap: Record<string, { displayName: string | null; firstName: string | null; lastName: string | null }> = {};
    if (authorIds.length > 0) {
      const rows: { id: string; displayName: string | null; firstName: string | null; lastName: string | null }[] =
        await this.postRepo.manager.query(
          `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = ANY($1)`,
          [authorIds]
        );
      nameMap = Object.fromEntries(
        rows.map((r) => [r.id, { displayName: r.displayName, firstName: r.firstName, lastName: r.lastName }])
      );
    }

    const result = rawPosts.map((p: any) => {
      const authorInfo = nameMap[p.authorId] ?? { displayName: null, firstName: null, lastName: null };
      return {
        ...p,
        authorDisplayName: authorInfo.displayName,
        authorFirstName: authorInfo.firstName,
        authorLastName: authorInfo.lastName,
      };
    });

    try {
      await this.redis.setex(cacheKey, PostsService.LIST_CACHE_TTL, JSON.stringify(result));
    } catch {
      // Non-fatal
    }

    return result;
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
    const images = (data.images || []).map((img: any) => ({
      ...img,
      mediaId: img.mediaId || crypto.randomUUID(),
    }));
    post.images = [...(post.images || []), ...images];
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
            id: crypto.randomUUID(),
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
      registrants: [],
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
    await this.invalidateListCache();
    return { success: true };
  }

  async addReaction(postId: string, userId: string, reactionType: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    // Guard against remote property injection: reject keys that could pollute Object.prototype.
    if (userId === '__proto__' || userId === 'constructor' || userId === 'prototype') {
      throw new BadRequestException('Invalid userId');
    }
    const reactions: Record<string, string> = post.reactions ?? {};
    reactions[userId] = reactionType;
    post.reactions = reactions;
    await this.postRepo.save(post);
    return { ok: true, reactions: post.reactions };
  }

  async removeReaction(postId: string, userId: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    // Guard against remote property injection: reject keys that could pollute Object.prototype.
    if (userId === '__proto__' || userId === 'constructor' || userId === 'prototype') {
      throw new BadRequestException('Invalid userId');
    }
    const reactions: Record<string, string> = post.reactions ?? {};
    delete reactions[userId];
    post.reactions = reactions;
    await this.postRepo.save(post);
    return { ok: true, reactions: post.reactions };
  }

  async addComment(postId: string, data: { userId: string; text: string; parentId?: string }) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');

    // Resolve display name, firstName, lastName
    let displayName: string | null = null;
    let firstName: string | null = null;
    let lastName: string | null = null;
    try {
      const rows: {
        displayName: string | null;
        firstName: string | null;
        lastName: string | null;
      }[] = await this.postRepo.manager.query(
        `SELECT "displayName", "firstName", "lastName" FROM users WHERE id = $1 LIMIT 1`,
        [data.userId]
      );
      if (rows[0]) {
        displayName = rows[0].displayName ?? null;
        firstName = rows[0].firstName ?? null;
        lastName = rows[0].lastName ?? null;
      }
    } catch {
      // ignore
    }

    const comment = {
      id: crypto.randomUUID(),
      userId: data.userId,
      displayName,
      firstName,
      lastName,
      text: data.text,
      parentId: data.parentId ?? null,
      likes: [] as string[],
      createdAt: new Date().toISOString(),
    };
    post.comments = [...(post.comments ?? []), comment];
    await this.postRepo.save(post);
    return { ok: true, comment };
  }

  async likeComment(postId: string, commentId: string, userId: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const comments: any[] = post.comments ?? [];
    const comment = comments.find((c: any) => c.id === commentId);
    if (!comment) throw new NotFoundException('Comment not found');
    const likes: string[] = comment.likes ?? [];
    if (likes.includes(userId)) {
      comment.likes = likes.filter((id: string) => id !== userId);
    } else {
      comment.likes = [...likes, userId];
    }
    post.comments = comments;
    await this.postRepo.save(post);
    return { ok: true, comment };
  }
}
