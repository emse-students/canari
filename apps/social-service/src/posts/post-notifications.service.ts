import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostNotification } from './entities/post-notification.entity';
import { Post } from './entities/post.entity';
import { PushService } from '../push/push.service';
import {
  AssociationPushMutesService,
  MUTABLE_PUSH_TYPES,
} from '../follows/association-push-mutes.service';
import {
  mentionContent,
  replyContent,
  reactionContent,
  reactionTypeToEmoji,
  commentContent,
  eventProposedContent,
  eventValidatedContent,
  eventRejectedContent,
  eventUpdatedContent,
  eventDeletedContent,
  eventPendingContent,
  associationPostContent,
  followedPostContent,
  associationRepostContent,
  repostProposedContent,
  repostPersonalRequestedContent,
  coorganiseProposedContent,
  liveStartedContent,
  followRequestContent,
  followAcceptedContent,
  liveCutContent,
  liveSuspendedContent,
  liveWithdrawnContent,
  bookingAddedContent,
  bookingCancelledContent,
  bookingReminderContent,
  bookingWithdrawnContent,
  publicMediaIconId,
  MENTION_TOKEN_RE,
  type PushContent,
  type PushIcon,
} from '../push/push-content';
import { forEachBounded, PUSH_FAN_OUT_LIMIT } from '../push/fan-out';
import { formatUserDisplayNameFromRaw } from '../utils/user-display-name';

/**
 * What a notification ABOUT an anonymous post carries instead of the real author - the identity
 * `mustHideAnonymousAuthor` already withholds from a post's own reader, withheld here too. A
 * notification has no per-viewer read-time shaping the way a post does (`actorName` is
 * denormalized onto the row at write time, per `PostNotification`'s own docblock), so the two
 * call sites that notify ABOUT an anonymous post - a mention, and `PostAnnounceScheduler`'s
 * "someone you follow published" - must mask before they call `createNotification(s)`, not after.
 * An empty `actorId` is what `Avatar.svelte` already reads as "no user to look up" (the same
 * shape a post with no author, or a parrainage entry with no `sub`, already uses) - the client
 * needs no change to draw initials from `actorName` rather than a 404.
 */
export const ANONYMOUS_NOTIFICATION_ACTOR_ID = '';
export const ANONYMOUS_NOTIFICATION_ACTOR_NAME = 'Anonyme';

/**
 * The name a notification gives as its actor when no PERSON acted on the reader - the platform
 * itself: an admin answering a profile correction for it, a form reminder, a payment provider's
 * answer. One constant, so every such row names the platform the same way.
 */
export const SYSTEM_ACTOR_NAME = 'Canari';

/** The `actorId` of a notice no person acted on - the platform, which has no face to show. */
export const SYSTEM_ACTOR_ID = 'system';

/**
 * `content` with `icon`, when there is one: the bookings' builders take no picture of their own.
 * The platform's "face" is no picture at all: a notice that names nobody (a link-only space's
 * organiser, Q-R5) must not show the face of whoever acted either.
 */
const withIcon = (content: PushContent, icon?: PushIcon): PushContent =>
  icon && !(icon.kind === 'user' && icon.userId === SYSTEM_ACTOR_ID)
    ? { ...content, icon }
    : content;

/** Manages in-app notifications triggered by post interactions (comments, reactions, mentions). */
@Injectable()
export class PostNotificationsService {
  private readonly logger = new Logger(PostNotificationsService.name);

  constructor(
    @InjectRepository(PostNotification) private readonly notifRepo: Repository<PostNotification>,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly push: PushService,
    private readonly pushMutes: AssociationPushMutesService
  ) {}

  /**
   * Maps a notification type to WHAT its push says - and, since 2026-09-17, what it SHOWS.
   * Callers with more context (reaction emoji, comment preview) send their own and pass
   * `skipPush: true` to `createNotification` instead of relying on this.
   *
   * An unknown type gets NO push rather than an invented sentence. It used to fall through to a
   * hardcoded "Nouvelle notification", which is a sentence no table can translate and no reader
   * learns anything from - and it hid the fact that a type had been added without a push.
   */
  private pushContent(
    type: string,
    actorName: string,
    text: string,
    icon?: PushIcon
  ): PushContent | null {
    switch (type) {
      case 'mention':
        return mentionContent(actorName, text, icon);
      case 'reply':
        return replyContent(actorName, text, icon);
      case 'reaction':
        return reactionContent(actorName, reactionTypeToEmoji(text), icon);
      case 'comment':
        return commentContent(actorName, text, icon);
      // The two publication notices. `actorName` is the ASSOCIATION for the first and the author
      // for the second; `text` is the opening of the post either way, never a composed sentence.
      case 'association_post':
        return associationPostContent(actorName, text, icon);
      case 'followed_post':
        return followedPostContent(actorName, text, icon);
      // Republication (D38). `actorName` is the republishing, then the proposing, ASSOCIATION.
      case 'association_repost':
        return associationRepostContent(actorName, text, icon);
      case 'repost_proposed':
        return repostProposedContent(actorName, text, icon);
      // D38b: an association asks the AUTHOR to let it republish their personal post. `actorName`
      // is the ASSOCIATION. Its answers (`repost_personal_accepted` / `_refused`) are in-app only.
      case 'repost_personal_requested':
        return repostPersonalRequestedContent(actorName, text, icon);
      // Co-organisation (D39). `actorName` is the ORGANISING association, `text` the event title.
      case 'coorganise_proposed':
        return coorganiseProposedContent(actorName, text, icon);
      // A live started (WP-L7). `actorName` is the broadcaster, a person or an association; there
      // is no text to quote.
      case 'live_started':
        return liveStartedContent(actorName, icon);
      // Follow requests (WP-F2). `actorName` is the ASKER for the first and the person who said
      // yes for the second; neither has text to quote.
      case 'follow_request':
        return followRequestContent(actorName, icon);
      case 'follow_accepted':
        return followAcceptedContent(actorName, icon);
      // The strike ladder's three notices to a broadcaster (WP-L8b): fixed sentences, no actor and
      // no icon - which moderator acted is not theirs to read, and the reason stays on the row.
      case 'live_cut':
        return liveCutContent();
      case 'live_suspended':
        return liveSuspendedContent();
      case 'live_withdrawn':
        return liveWithdrawnContent();
      // The bookings' four (WP-N). `text` is the PLACE - or the organiser's word for a cancellation
      // (Q-R3), the place and the time for a reminder - and empty for a link-only space (Q-R5).
      case 'booking_cancelled':
        return withIcon(bookingCancelledContent(actorName, text), icon);
      case 'booking_withdrawn':
        return withIcon(bookingWithdrawnContent(actorName, text), icon);
      case 'booking_added':
        return withIcon(bookingAddedContent(actorName, text), icon);
      case 'booking_reminder':
        return bookingReminderContent(text);
      // The agenda's six. `text` is the event's TITLE for all of them - never a composed sentence,
      // which is what the server used to send here and could not translate.
      case 'event_proposed':
        return eventProposedContent(actorName, text);
      case 'event_validated':
        return eventValidatedContent(actorName, text);
      case 'event_rejected':
        return eventRejectedContent(actorName, text);
      case 'event_updated':
        return eventUpdatedContent(actorName, text);
      case 'event_deleted':
        return eventDeletedContent(actorName, text);
      case 'event_pending':
        return eventPendingContent(actorName, text);
      default:
        return null;
    }
  }

  /** Extracts `@[id]` mention targets from text. Returns deduplicated IDs (max 20). */
  resolveMentionedUserIds(text: string): string[] {
    const ids = new Set<string>();
    for (const match of text.matchAll(MENTION_TOKEN_RE)) {
      ids.add(match[1].toLowerCase());
    }
    return [...ids].slice(0, 20);
  }

  /**
   * Looks up a user's display name from the shared users table.
   *
   * The precedence itself is NOT decided here - it is `formatUserDisplayName`'s, the one every
   * surface of this app and of the client now shares. This method built it inline and preferred
   * `displayName`, so a post notification could name somebody differently from the post it opened.
   *
   * Falls back to the actor id, which is not a name but is addressable: a notification with no
   * actor at all reads as a fault, and the client resolves an id it recognises. A caller for which
   * an id is NOT acceptable as a title asks {@link resolveDisplayName} instead.
   */
  async resolveActorName(actorId: string): Promise<string> {
    try {
      return (await this.resolveDisplayName(actorId)) ?? actorId;
    } catch (e) {
      this.logger.warn(
        `[NOTIF] display name of ${actorId.slice(0, 8)} unreadable, the id stands in: ${e instanceof Error ? e.message : String(e)}`
      );
      return actorId;
    }
  }

  /**
   * A user's display name, or `null` when there is GENUINELY none: no `users` row, or a row with no
   * name. A failed lookup is not that answer and THROWS - the caller tells "nobody to name" from
   * "could not ask" by the type of the outcome, never by reading a message.
   */
  async resolveDisplayName(actorId: string): Promise<string | null> {
    const rows: unknown = await this.postRepo.manager.query(
      `SELECT "displayName", "firstName", "lastName" FROM users WHERE id = $1`,
      [actorId]
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const u: unknown = rows[0];
    if (typeof u !== 'object' || u === null) return null;
    return formatUserDisplayNameFromRaw(u as Record<string, unknown>) || null;
  }

  /**
   * A preview with its mention tokens replaced by names, for a PUSH.
   *
   * The app resolves `@[id]` itself when it draws the in-app list, so the stored text keeps them.
   * A phone's push handler has no name directory and shows a social push's text as it arrives, so a
   * mention reached the lock screen as `@[` and 64 hex characters (2026-09-28). The server knows
   * every name, so it renders them here. A member it cannot name is dropped from the line rather
   * than shown as their id.
   */
  async renderMentionsForPush(text: string): Promise<string> {
    const ids = [...new Set([...text.matchAll(MENTION_TOKEN_RE)].map((m) => m[1].toLowerCase()))];
    if (ids.length === 0) return text;
    const names = new Map<string, string>();
    for (const id of ids) {
      const name = await this.resolveActorName(id);
      if (name && name.toLowerCase() !== id) names.set(id, name);
      else
        this.logger.warn(
          `[NOTIFY] no display name for mentioned ${id.slice(0, 8)} - dropped from the push`
        );
    }
    return text
      .replace(MENTION_TOKEN_RE, (_token, id: string) => {
        const name = names.get(id.toLowerCase());
        return name ? `@${name}` : '';
      })
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * Creates a notification unless actor and recipient are the same person.
   * Pass `actorName` to skip the DB lookup (e.g. system-generated notifications).
   * Pass `skipPush: true` when the caller already sends its own push (e.g. with a richer
   * message than `pushContent` can build) - otherwise the recipient gets duplicate pushes.
   * `pushData` adds fields to the push payload over `{ type, postId }` - a typed `target` such as
   * `NOTIFICATIONS_TARGET`, for a notice whose `postId` names no post.
   */
  async createNotification(data: {
    recipientId: string;
    type: string;
    postId: string;
    actorId: string;
    text: string;
    actorName?: string;
    skipPush?: boolean;
    pushData?: Record<string, string>;
  }) {
    if (data.recipientId === data.actorId) return;
    const { skipPush, pushData, ...notifData } = data;
    const actorName = data.actorName ?? (await this.resolveActorName(data.actorId));
    await this.notifRepo.save(this.notifRepo.create({ ...notifData, actorName }));

    if (skipPush) return;

    // FCM push so every visible notification also triggers a system notification, even with the app closed. Fire-and-forget.
    // THE PICTURE IS THE ACTOR'S, because every type reaching this method is one person acting on
    // something of yours. The batch method below is the one that also has an association to show.
    const content = this.pushContent(
      data.type,
      actorName,
      await this.renderMentionsForPush(data.text),
      { kind: 'user', userId: data.actorId }
    );
    if (!content) {
      this.logger.warn(
        `[NOTIFY] no push content for type=${data.type} - the in-app notification was written, ` +
          'the system one was not. Add the type to pushContent or send your own push.'
      );
      return;
    }
    void this.push.notifyContent(data.recipientId, content, {
      type: 'social',
      postId: data.postId,
      ...pushData,
    });
  }

  /**
   * `createNotification` for a SET of recipients: one actor lookup, one insert, one push each.
   *
   * The agenda notifies whole groups - every proposer in an association, every calendar manager -
   * and doing that through the singular method would be one name lookup and one round trip per
   * member. The association service used to batch it itself by writing to the repository directly,
   * which is precisely how its push escaped `pushContent` and stayed English for as long as it did.
   * Batching belongs here so that the mapping cannot be bypassed to get it.
   *
   * Returns how many rows were written, so a caller can log a delivery that reached nobody.
   */
  async createNotifications(data: {
    recipientIds: string[];
    type: string;
    postId: string;
    actorId: string;
    text: string;
    actorName?: string;
    /** Set for `type === 'association_post'`: the association itself, not `actorId` (the member
     *  who published) - see `PostNotification`'s own docblock for why they must differ. */
    associationId?: string;
    associationLogoUrl?: string | null;
    /** The logo's media id, which is what a push icon may carry - NOT derived from the URL above. */
    associationLogoMediaId?: string | null;
    /** Extra fields for the push payload, e.g. the association the event belongs to. */
    pushData?: Record<string, string>;
    /** Structured facts stored on each row (never in the push), see `PostNotification.meta`. */
    meta?: Record<string, unknown>;
    /**
     * In-app rows only, no push - a type that is deliberately never pushed (the answer to a
     * republication request, D38b) rather than one `pushContent` forgot.
     */
    skipPush?: boolean;
  }): Promise<number> {
    const recipients = [...new Set(data.recipientIds)].filter((id) => id !== data.actorId);
    if (recipients.length === 0) return 0;

    const actorName = data.actorName ?? (await this.resolveActorName(data.actorId));
    await this.notifRepo.save(
      recipients.map((recipientId) =>
        this.notifRepo.create({
          recipientId,
          type: data.type,
          postId: data.postId,
          actorId: data.actorId,
          associationId: data.associationId ?? null,
          associationLogoUrl: data.associationLogoUrl ?? null,
          text: data.text,
          meta: data.meta ?? null,
          actorName,
        })
      )
    );
    if (data.skipPush) return recipients.length;

    await this.fanOutPush({ ...data, actorName }, recipients);
    return recipients.length;
  }

  /**
   * A push for a notice the bell does NOT keep - one per recipient, through the same mapping, icon
   * rule, mute and bounded fan-out as {@link createNotifications}, and no `post_notifications` row.
   *
   * For a notice about something that does not outlive its moment: a live (WP-L7) is deleted when it
   * ends (L3), so a bell row naming it would point at a 404 for ever after. The LIVE card at the top
   * of the feed is its in-app surface (L5). Returns how many recipients were addressed, before the
   * mute (which only the push consults, exactly as for a post).
   */
  async pushNotice(data: {
    recipientIds: string[];
    type: string;
    actorId: string;
    actorName: string;
    text: string;
    associationId?: string;
    associationLogoMediaId?: string | null;
    pushData?: Record<string, string>;
  }): Promise<number> {
    const recipients = [...new Set(data.recipientIds)].filter((id) => id !== data.actorId);
    if (recipients.length === 0) return 0;
    await this.fanOutPush(data, recipients);
    return recipients.length;
  }

  /**
   * The push half of a notice: the picture, the content, the mute, then the bounded fan-out. Shared
   * by {@link createNotifications} and {@link pushNotice} so neither can drift from the other's
   * mapping or mute. Throws only when the mute lookup fails (fail closed, see below).
   */
  private async fanOutPush(
    data: {
      type: string;
      actorId: string;
      actorName: string;
      text: string;
      associationId?: string;
      associationLogoMediaId?: string | null;
      pushData?: Record<string, string>;
    },
    recipients: string[]
  ): Promise<void> {
    const actorName = data.actorName;
    // THE LOGO WHEN THE PUBLISHER IS AN ASSOCIATION, THE PERSON OTHERWISE - the same split the
    // notifications page makes, and for the same reason: `actorId` on an `association_post` row is
    // the member who pressed publish, so keying the picture off it shows a face where the reader
    // expects a logo. An association with no logo, or one whose `logoUrl` is not a public-media
    // path, falls back to the actor rather than to nothing.
    const logoId = publicMediaIconId(data.associationLogoMediaId);
    const icon: PushIcon = logoId
      ? { kind: 'publicMedia', mediaId: logoId }
      : { kind: 'user', userId: data.actorId };
    // A FALLBACK IS A SIGNAL. Showing the member's face for an association's post is wrong on its
    // face and was wrong for 40 of 91 associations for as long as the icon was parsed out of
    // `logoUrl` - and nothing said so, which is why it took a reader to find it. The only case
    // left that is NOT a defect is an association with no logo at all (one row on production), and
    // the line separates them: an id that is present and refused is a broken column, an absent one
    // is a logo nobody uploaded.
    if (data.associationId && !logoId) {
      this.logger.warn(
        `[NOTIFY] association ${data.associationId} pushes the actor's face, not its logo - ` +
          `logoMediaId=${data.associationLogoMediaId ? 'present but refused' : 'absent'}`
      );
    }
    const content = this.pushContent(
      data.type,
      actorName,
      await this.renderMentionsForPush(data.text),
      icon
    );
    if (!content) {
      this.logger.warn(
        `[NOTIFY] no push content for type=${data.type} - ${recipients.length} recipient(s) ` +
          'got no system notification (any in-app row was written). Add the type to pushContent.'
      );
      return;
    }
    // THE MUTE, applied HERE and server-side: any in-app row is already written (a mute silences
    // the PUSH, never the bell or the feed), and only a type that reaches a READER of the
    // association is eligible - managers' operational pushes are never muted (`MUTABLE_PUSH_TYPES`).
    let pushRecipients = recipients;
    if (data.associationId && MUTABLE_PUSH_TYPES.has(data.type)) {
      // FAIL CLOSED, LOUDLY: if the lookup fails the push is NOT sent to everyone (that would
      // override a stated privacy choice) and not silently dropped either - the error is logged
      // here and rethrown, so the caller's own warning names the post (or live) that was not
      // pushed. A post's in-app rows are already written, so the bell still carries it.
      const muted = await this.pushMutes
        .mutedAmong(data.associationId, recipients)
        .catch((e: unknown) => {
          this.logger.error(
            `[NOTIFY] mute lookup failed for association=${data.associationId?.slice(0, 8)} - ` +
              `push NOT sent to ${recipients.length} recipient(s): ${String(e)}`
          );
          throw e;
        });
      if (muted.size > 0) {
        pushRecipients = recipients.filter((id) => !muted.has(id));
        this.logger.log(
          `[NOTIFY] type=${data.type} association=${data.associationId.slice(0, 8)} ` +
            `push withheld from ${muted.size} muted of ${recipients.length}`
        );
      }
    }
    // Fire-and-forget, BOUNDED, and logged PER RECIPIENT. Bounded because `recipients` is as wide
    // as the audience and not as wide as the caller: announcing a post to the whole feed is 356
    // recipients on today's population, and `Promise.all` would open 356 sockets to the delivery
    // service from a single cron tick. Per recipient because a batch that reports once loses
    // every failure after the first, and in a best-effort path the log is all a loss leaves.
    void forEachBounded(pushRecipients, PUSH_FAN_OUT_LIMIT, (recipientId) =>
      this.push.notifyContent(recipientId, content, { type: 'social', ...data.pushData })
    ).then((failures) => {
      for (const { item, error } of failures) {
        this.logger.warn(`[NOTIFY] push failed for ${item}: ${String(error)}`);
      }
    });
  }

  /** Returns the most recent notifications for a user, newest first. */
  async getNotifications(userId: string, limit = 30) {
    return this.notifRepo.find({
      where: { recipientId: userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /** Marks every notification for a user as read (called when the bell dropdown is opened). */
  async markAllRead(userId: string) {
    await this.notifRepo.update({ recipientId: userId }, { read: true });
    return { ok: true };
  }

  /** Marks every notification about one post as read for a user. */
  async markPostRead(userId: string, postId: string) {
    await this.notifRepo.update({ recipientId: userId, postId }, { read: true });
    return { ok: true };
  }
}
