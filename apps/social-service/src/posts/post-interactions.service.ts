import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { PostNotificationsService } from './post-notifications.service';

/** Handles reactions, comments, polls, and event registrations on posts. */
@Injectable()
export class PostInteractionsService {
  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly notifications: PostNotificationsService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {}

  private sanitizeReactions(raw: Record<string, string> | null | undefined): Record<string, string> {
    const out = Object.create(null) as Record<string, string>;
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(raw)) {
      if (['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__'].includes(key)) continue;
      out[key] = raw[key];
    }
    return out;
  }

  async addReaction(postId: string, userId: string, reactionType: string) {
    if (['__proto__', 'constructor', 'prototype'].includes(userId)) {
      throw new BadRequestException('Invalid userId');
    }
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const reactions = this.sanitizeReactions(post.reactions);
    reactions[userId] = reactionType;
    post.reactions = reactions;
    await this.postRepo.save(post);
    return { ok: true, reactions: post.reactions };
  }

  async removeReaction(postId: string, userId: string) {
    if (['__proto__', 'constructor', 'prototype'].includes(userId)) {
      throw new BadRequestException('Invalid userId');
    }
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const reactions = this.sanitizeReactions(post.reactions);
    delete reactions[userId];
    post.reactions = reactions;
    await this.postRepo.save(post);
    return { ok: true, reactions: post.reactions };
  }

  async addComment(postId: string, data: { userId: string; text: string; parentId?: string }) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');

    let displayName: string | null = null;
    let firstName: string | null = null;
    let lastName: string | null = null;
    try {
      const rows: any[] = await this.postRepo.manager.query(
        `SELECT "displayName", "firstName", "lastName" FROM users WHERE id = $1 LIMIT 1`,
        [data.userId]
      );
      if (rows[0]) {
        ({ displayName = null, firstName = null, lastName = null } = rows[0]);
      }
    } catch { /* non-fatal */ }

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

    // Fire-and-forget: notify post author and parent comment author
    void (async () => {
      try {
        const preview = data.text.length > 60 ? data.text.slice(0, 57) + '…' : data.text;
        if (post.authorId && !post.associationId) {
          await this.notifications.createNotification({
            recipientId: post.authorId, type: 'comment', postId, actorId: data.userId, text: preview,
          });
        }
        if (data.parentId) {
          const parent = (post.comments as any[]).find((c: any) => c.id === data.parentId);
          if (parent?.userId) {
            await this.notifications.createNotification({
              recipientId: parent.userId, type: 'reply', postId, actorId: data.userId, text: preview,
            });
          }
        }
      } catch { /* non-fatal */ }
    })();

    return { ok: true, comment };
  }

  async likeComment(postId: string, commentId: string, userId: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const comments: any[] = post.comments ?? [];
    const comment = comments.find((c: any) => c.id === commentId);
    if (!comment) throw new NotFoundException('Comment not found');
    const likes: string[] = comment.likes ?? [];
    comment.likes = likes.includes(userId)
      ? likes.filter((id) => id !== userId)
      : [...likes, userId];
    post.comments = comments;
    await this.postRepo.save(post);
    return { ok: true, comment };
  }

  async editComment(postId: string, commentId: string, userId: string, text: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const comments: any[] = post.comments ?? [];
    const comment = comments.find((c: any) => c.id === commentId);
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId) throw new UnauthorizedException('Not your comment');
    comment.text = text;
    post.comments = comments;
    await this.postRepo.save(post);
    return { ok: true, comment };
  }

  async deleteComment(postId: string, commentId: string, userId: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const comments: any[] = post.comments ?? [];
    const comment = comments.find((c: any) => c.id === commentId);
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId) throw new UnauthorizedException('Not your comment');
    post.comments = comments.filter((c: any) => c.id !== commentId && c.parentId !== commentId);
    await this.postRepo.save(post);
    return { ok: true };
  }

  async votePoll(postId: string, pollId: string, data: { userId: string; optionIds: string[] }) {
    const post = await this.postRepo.createQueryBuilder('post')
      .where('post.id = :postId', { postId })
      .getOne();
    if (!post) throw new NotFoundException('Poll not found');

    let updated = false;
    for (const poll of post.polls ?? []) {
      if (poll.id !== pollId) continue;
      const selectedIds = data.optionIds;
      for (const opt of poll.options) {
        opt.votes = (opt.votes ?? []).filter((v: string) => v !== data.userId);
      }
      for (const opt of poll.options) {
        if (selectedIds.includes(opt.id)) opt.votes.push(data.userId);
      }
      if (!poll.votesByUser) poll.votesByUser = {};
      poll.votesByUser[data.userId] = selectedIds;
      updated = true;
    }

    if (updated) {
      const saved = await this.postRepo.save(post);
      const entity = Array.isArray(saved) ? saved[0] : saved;
      return entity;
    }
    return post;
  }

  async registerEvent(postId: string, buttonId: string, data: { userId: string; email?: string }) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');

    const buttons: any[] = post.eventButtons ?? [];
    const btnIndex = buttons.findIndex((b: any) => b.id === buttonId);
    if (btnIndex === -1) throw new NotFoundException('Event button not found');

    const btn = { ...buttons[btnIndex] };
    if (!Array.isArray(btn.registrants)) btn.registrants = [];
    if (btn.capacity && btn.registrants.length >= btn.capacity) throw new BadRequestException('Event is full');
    if (btn.registrants.includes(data.userId)) return { alreadyRegistered: true, requiresPayment: false };

    if (btn.requiresPayment && btn.amountCents > 0) {
      const paymentBase = this.configService.get<string>('PAYMENT_SERVICE_URL') || 'http://core-service:3012';
      const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost';
      try {
        const res = await lastValueFrom(
          this.httpService.post(`${paymentBase.replace(/\/$/, '')}/api/payments/create-checkout-session`, {
            lineItems: [{ price_data: { currency: (btn.currency || 'eur').toLowerCase(), product_data: { name: btn.label }, unit_amount: btn.amountCents }, quantity: 1 }],
            successUrl: `${frontendUrl}/posts?registered=${buttonId}`,
            cancelUrl: `${frontendUrl}/posts`,
            metadata: { postId, buttonId, userId: data.userId },
          })
        );
        const checkoutUrl = (res.data as any)?.url;
        if (checkoutUrl) return { requiresPayment: true, checkoutUrl };
      } catch { /* payment service unavailable */ }
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
    return { ok: true, requiresPayment: false, message: 'Formulaire envoyé.' };
  }
}
