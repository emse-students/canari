import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostNotification } from './entities/post-notification.entity';
import { Post } from './entities/post.entity';
import { PushService } from '../push/push.service';
import { AccountBellsService, bellTargetOf } from '../follows/account-bells.service';
import {
  CAMPUS_TREND_NOTIFICATION,
  CAPPED_PUSH_TYPES,
  FRIEND_COMMENT_NOTIFICATION,
  FRIEND_REACTION_NOTIFICATION,
  claimEngagementPushes,
} from './engagement-push-cap';
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
  eventPendingCoorganiserContent,
  associationPostContent,
  followedPostContent,
  associationRepostContent,
  memberRepostContent,
  friendReactionContent,
  friendCommentContent,
  campusTrendContent,
  repostProposedContent,
  repostPersonalRequestedContent,
  coorganiseProposedContent,
  liveStartedContent,
  liveMentionContent,
  followRequestContent,
  followAcceptedContent,
  birthdayContent,
  liveCutContent,
  liveSuspendedContent,
  liveWithdrawnContent,
  bookingAddedContent,
  bookingCancelledContent,
  bookingReminderContent,
  bookingOpenContent,
  eventOpenContent,
  bookingChangedContent,
  bookingRemovedContent,
  bookingWithdrawnContent,
  publicMediaIconId,
  MENTION_TOKEN_RE,
  previewOf,
  type PushContent,
  type PushIcon,
  type TrendMedia,
} from '../push/push-content';
import {
  notificationTypesRenderableBy,
  type NotificationType,
  type PushOnlyNotificationType,
} from '../push/notification-client-floor';
import { forEachBounded, PUSH_FAN_OUT_LIMIT } from '../push/fan-out';
import { formatUserDisplayNameFromRaw } from '../utils/user-display-name';
import {
  commentsWithheldFromViewerSql,
  postVisibleToViewerSql,
  sameSideOfReviewCohortSql,
  postPublicAdmitsViewerSql,
} from '../spaces/reader-spaces';
import { isBlockedBetween } from '../common/user-blocks';
import { readPostOpenVerdict, type OpenablePost } from './post-openable';
import { birthdayDateVisibleToSql } from '../birthdays/birthday-sql';
import { BIRTHDAY_NOTIFICATION } from '../birthdays/birthday-notification';

/** The bell's page when the caller names none: what the bell dropdown asks. */
export const BELL_PAGE_DEFAULT = 30;
/** The largest bell page served: what `/notifications` asks, and what `bellPageQuery`'s plan is sized for. */
export const BELL_PAGE_MAX = 50;
/** The typed code of a `limit` that is not a whole number. */
export const BELL_LIMIT_INVALID = 'NOTIFICATIONS_LIMIT_INVALID';

/**
 * The bell page size from the raw `?limit=` (review of #2965): absent is
 * {@link BELL_PAGE_DEFAULT}, a whole number is held to 1..{@link BELL_PAGE_MAX}, and anything else
 * - text, a fraction, an exponent - is a 400 typed {@link BELL_LIMIT_INVALID}. It used to be
 * `Number(limit)` passed straight through, so `?limit=100000` read a reader's whole history and
 * `?limit=abc` reached TypeORM as NaN.
 */
export function bellPageLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return BELL_PAGE_DEFAULT;
  if (!/^-?\d{1,9}$/.test(raw)) {
    throw new BadRequestException({
      code: BELL_LIMIT_INVALID,
      message: 'limit must be a whole number',
    });
  }
  return Math.min(BELL_PAGE_MAX, Math.max(1, Number(raw)));
}

/**
 * The notification type of a member repost reaching a reader for the first time (WP-F6). Declared
 * here, where the bell is read, because the read gates it (`getNotifications`).
 */
export const MEMBER_REPOST_NOTIFICATION = 'member_repost';

/**
 * THE BELL TYPES WHOSE `postId` IS A POST'S ID, and whose row shows that post's preview: each is
 * shown only while its recipient still SEES the post (`bellRowShownSql`). An ALLOWLIST of what this
 * module knows to name a post - a type whose `postId` carries something else (a proposal's
 * association id, a live, an event) must never be listed, or its row would vanish for good. A new
 * post-bound type is added here when it is written.
 *
 * Extended from `member_repost` alone to every post-bound type on 2026-11-02 (review of #2965): an
 * `association_repost` told to an institution's staff member outlived the author's withdrawal, and
 * kept the text of a post its reader no longer saw.
 */
export const POST_BOUND_NOTIFICATION_TYPES: readonly string[] = [
  MEMBER_REPOST_NOTIFICATION,
  'association_repost',
  'association_post',
  'followed_post',
  'mention',
  'comment',
  'reply',
  'reaction',
  'repost_personal_requested',
  'repost_personal_accepted',
  'repost_personal_refused',
  // Engagement WP-9: friends' activity names a post its recipient saw at the write; the row is shown
  // only while they still do.
  FRIEND_REACTION_NOTIFICATION,
  FRIEND_COMMENT_NOTIFICATION,
  // Engagement WP-10: a campus trend names a post its space saw.
  CAMPUS_TREND_NOTIFICATION,
];

/**
 * The bell types whose row ALWAYS carries a comment's text. A `'mention'` may be a post's or a
 * comment's: `commentBorneNotificationSql` tells them apart.
 */
export const COMMENT_BORNE_NOTIFICATION_TYPES: readonly string[] = ['comment', 'reply'];

/**
 * Bell row `n` (about post `post`) carries a COMMENT's text and writer - withheld, like the comments
 * themselves, from a named reader whose only door to the post is a read grant with "voit les
 * commentaires" off (owner, 2026-11-04). New rows of that kind are not written to such a reader
 * (`mentionRecipientsOf` with `'COMMENT'`); this hides the ones written before, and any row whose
 * reader's switch was turned off since.
 *
 * A `comment` or `reply` row always is. A `mention` row is when a comment wrote it: classified at
 * the write since migration 132 (`commentId`), and for a row written before, by what the row already
 * holds - a post's own mention (`notifyPostMentions`) names the post's author as its actor, or the
 * anonymous actor on an anonymous post, so a mention naming ANYBODY ELSE came from a comment. Two
 * old comment mentions look like a post's and stay shown: one written by the post's author in a
 * comment of their own post, and an anonymous or association comment's on an anonymous post.
 */
export function commentBorneNotificationSql(n: string, post: string): string {
  const types = COMMENT_BORNE_NOTIFICATION_TYPES.map((t) => `'${t}'`).join(', ');
  return `(${n}.type IN (${types}) OR (${n}.type = 'mention' AND (${n}."commentId" IS NOT NULL
    OR (${n}."actorId" IS DISTINCT FROM ${post}."authorId"
      AND NOT (${n}."actorId" = '${ANONYMOUS_NOTIFICATION_ACTOR_ID}' AND ${post}.anonymous)))))`;
}

/**
 * Bell row `n` is not a birthday notice, or it is one whose recipient may STILL read the member's date
 * (`birthdayDateVisibleToSql`, docs/wiki/birthdays.md): the row says whose birthday it was, so a
 * member who hides the date, removes it, removes the follower or blocks them takes it out of that
 * follower's bell too - the date never outlives its visibility. A push already delivered cannot be
 * recalled.
 */
export function birthdayRowShownSql(n: string): string {
  return `${n}.type <> '${BIRTHDAY_NOTIFICATION}' OR EXISTS (SELECT 1 FROM profile_birthdays notif_bday
    WHERE notif_bday."userId" = ${n}."actorId"
      AND ${birthdayDateVisibleToSql('notif_bday', `${n}."recipientId"`)})`;
}

/**
 * Bell row `n` may be shown: a row of a type that names no post, or a row of a post-bound type
 * (`POST_BOUND_NOTIFICATION_TYPES`) whose post exists, is not hidden by moderation, and its
 * recipient still sees (`getNotifications` says why) - with its comments, for a comment-borne row
 * (`commentBorneNotificationSql`). The types are constants of this module.
 *
 * `postId` is a `varchar` that other types fill with ids of their own, so it is cast to `uuid`
 * inside a CASE - evaluated for a post-bound row only, and only when it has a uuid's shape, so a
 * malformed row is not shown rather than failing every reader's bell - and the lookup keeps the
 * posts primary key.
 */
export function bellRowShownSql(n: string): string {
  const types = POST_BOUND_NOTIFICATION_TYPES.map((t) => `'${t}'`).join(', ');
  return `(${birthdayRowShownSql(n)}) AND (${n}.type NOT IN (${types}) OR EXISTS (SELECT 1 FROM posts notif_post
    WHERE notif_post.id = (CASE WHEN ${n}.type IN (${types})
        AND ${n}."postId" ~* '${UUID_SHAPE}'
      THEN ${n}."postId"::uuid END)
      AND NOT notif_post."hiddenByModeration"
      AND ${postVisibleToViewerSql('notif_post', `${n}."recipientId"`)}
      AND NOT (${commentBorneNotificationSql(n, 'notif_post')}
        AND ${commentsWithheldFromViewerSql('notif_post', `${n}."recipientId"`)})))`;
}

/**
 * What a campus trend's post shows when it has no text, as its bell row stores it (`meta.media`,
 * written by `announceCampusTrend`); `null` for a row that says nothing - a post with neither, or a
 * row written before the media was recorded.
 */
export function trendMediaOfMeta(meta: Record<string, unknown> | null | undefined): TrendMedia {
  const media = meta?.media;
  return media === 'photo' || media === 'video' ? media : null;
}

/** The shape of a uuid, which a varchar column must have before it is cast to one. */
const UUID_SHAPE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * `column` (a VARCHAR) as a uuid, or NULL when it does not have the shape of one. Never for a column
 * that already is a `uuid` (`associationId` is, since migration 061): `uuid ~* text` has no operator
 * and fails the whole bell with a 500 (#3019 on dev).
 */
function asUuidSql(column: string): string {
  return `(CASE WHEN ${column} ~* '${UUID_SHAPE}' THEN ${column}::uuid END)`;
}

/**
 * A `repost_proposed` bell row whose TEXT its recipient may no longer read. Such a row is not
 * post-bound - its `postId` names the receiving association's queue - so {@link bellRowShownSql}
 * never re-asks the predicate, and a row written while the "Entre étudiants" switch was OFF would
 * keep its preview once it is turned on. The row stays (the proposal is still theirs to decide);
 * only its text is withheld at the read, as the queue's `describe` withholds it.
 *
 * The row does not name its post, so the post is found through the proposal the row announced: a
 * `repost` proposal from the row's association (`associationId`, a `uuid` column compared as it
 * is) to its queue (`postId`, a varchar cast through {@link asUuidSql}), by its
 * actor, whatever its status (a decided proposal's row is still in the bell). FAIL CLOSED (review
 * of #3019): the text is shown only while such a proposal still leads to a post that exists, is not
 * hidden by moderation, and admits the recipient (`postPublicAdmitsViewerSql`), and NO such
 * proposal leads to one that refuses them. So a proposal gone with its post (deleted, hidden - which
 * drops its proposals - or its sending association deleted) takes the text with it, and one proposer
 * who sent the same queue several posts is judged on the strictest.
 */
export function repostProposalTextWithheldSql(n: string): string {
  const matches = (prop: string) => `${prop}.kind = 'repost'
      AND ${prop}."toAssociationId" = ${asUuidSql(`${n}."postId"`)}
      AND ${prop}."fromAssociationId" = ${n}."associationId"
      AND ${prop}."proposedBy" = ${n}."actorId"`;
  const admitted = (post: string) => postPublicAdmitsViewerSql(post, `${n}."recipientId"`);
  return `(${n}.type = 'repost_proposed' AND (
    NOT EXISTS (SELECT 1 FROM proposals rpw_ok JOIN posts rpw_ok_post ON rpw_ok_post.id = rpw_ok."subjectId"
      WHERE ${matches('rpw_ok')} AND NOT rpw_ok_post."hiddenByModeration" AND ${admitted('rpw_ok_post')})
    OR EXISTS (SELECT 1 FROM proposals rpw_no JOIN posts rpw_no_post ON rpw_no_post.id = rpw_no."subjectId"
      WHERE ${matches('rpw_no')} AND NOT ${admitted('rpw_no_post')})))`;
}

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

/**
 * The rows of a notice are SAVED and only its push failed (the bell lookup is fail-closed).
 * Typed so a caller that must know whether somebody HAS the in-app row - to avoid telling the same
 * person twice - can tell this apart from a failure that wrote nothing, without reading a message.
 */
export class NotificationPushFailedError extends Error {
  constructor(
    /** Who has the saved in-app row. */
    readonly recipientIds: string[],
    readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'NotificationPushFailedError';
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}

/** Manages in-app notifications triggered by post interactions (comments, reactions, mentions). */
@Injectable()
export class PostNotificationsService {
  private readonly logger = new Logger(PostNotificationsService.name);

  constructor(
    @InjectRepository(PostNotification) private readonly notifRepo: Repository<PostNotification>,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly push: PushService,
    private readonly bells: AccountBellsService
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
    icon?: PushIcon,
    meta?: Record<string, unknown> | null
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
      // WP-F6: a person the recipient follows reposted a post. `actorName` is the REPOSTER.
      case 'member_repost':
        return memberRepostContent(actorName, text, icon);
      // Engagement WP-9: an account the recipient follows reacted to or commented on a post the
      // recipient sees. `actorName` is that account; `text` is the opening of the POST.
      case FRIEND_REACTION_NOTIFICATION:
        return friendReactionContent(actorName, text, icon);
      case FRIEND_COMMENT_NOTIFICATION:
        return friendCommentContent(actorName, text, icon);
      // Engagement WP-10: a post of the recipient's space took off, told as a suggestion. Nobody
      // acted; `text` is the opening of the post, and `meta.media` what it shows when it has none.
      case CAMPUS_TREND_NOTIFICATION:
        return campusTrendContent(text, trendMediaOfMeta(meta));
      // D38b: an association asks the AUTHOR to let it republish their personal post. `actorName`
      // is the ASSOCIATION. Its answers (`repost_personal_accepted` / `_refused`) are in-app only.
      case 'repost_personal_requested':
        return repostPersonalRequestedContent(actorName, text, icon);
      // Co-organisation (D39). `actorName` is the ORGANISING association, `text` the event title.
      case 'coorganise_proposed':
        return coorganiseProposedContent(actorName, text, icon);
      // A live started (WP-L7). `actorName` is the broadcaster, a person or an association; `text`
      // is the live's title, empty when it has none (owner, 2026-11-07).
      case 'live_started':
        return liveStartedContent(actorName, text, icon);
      // Someone mentioned the recipient in a live's chat (owner, 2026-11-09). `actorName` is the writer,
      // `text` the live's title (empty when it has none).
      case 'live_mention':
        return liveMentionContent(actorName, text, icon);
      // Follow requests (WP-F2). `actorName` is the ASKER for the first and the person who said
      // yes for the second; neither has text to quote.
      case 'follow_request':
        return followRequestContent(actorName, icon);
      case 'follow_accepted':
        return followAcceptedContent(actorName, icon);
      // A followed person's birthday (docs/wiki/birthdays.md). `actorName` is that person; no text.
      case 'birthday':
        return birthdayContent(actorName, icon);
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
      // An edit (owner, 2026-11-02): `text` is the place, as for the three above.
      case 'booking_changed':
        return withIcon(bookingChangedContent(actorName, text), icon);
      case 'booking_removed':
        return withIcon(bookingRemovedContent(actorName, text), icon);
      // The openings told to an association's followers (engagement WP-4). `actorName` is the
      // ASSOCIATION, `text` the space's name (empty for a link-only one) or the event's title. No
      // picture: the caller is the scheduler, whose actor is the platform.
      case 'booking_open':
        return bookingOpenContent(actorName, text);
      case 'event_open':
        return eventOpenContent(actorName, text);
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
      case 'event_pending_coorganiser':
        return eventPendingCoorganiserContent(actorName, text);
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
   * WHO OF `candidates` A MENTION ON `post` MAY REACH: those who may OPEN the post - the read's own
   * gate (`readPostOpenVerdict`: the audience, a block with a personal post's author, hidden,
   * scheduled later, an expired reel) - and with no block either way with `mentionerId`, whoever
   * wrote the mentioning text (the post's author, or a comment's writer; anonymous or not, since
   * dropping a mention tells its target nothing). A mention notifies, and pushes the text to, its
   * target: one the read refuses would be handed what the post's own route would 404.
   *
   * Asked per candidate (at most 20, `resolveMentionedUserIds`), at notification time and never at
   * the write - a post's mentions are asked at its first publication (`notifyPostMentions`). A
   * comment's are asked when it is written, so a comment on a post not yet published (only its
   * author may write one) tells nobody, then or later: dropped, not deferred.
   * The dropped ones are counted at debug, never named: who was mentioned is the writer's text.
   *
   * @param intent what the text that notifies IS: `'READ_OR_REACT'` for the post's own text,
   *   `'COMMENT'` for a comment's (a mention in it, or a reply to the recipient's comment) - which a
   *   named reader with comments withheld (owner, 2026-11-04) must not be pushed either.
   */
  async mentionRecipientsOf(
    post: OpenablePost,
    mentionerId: string,
    candidates: string[],
    intent: 'READ_OR_REACT' | 'COMMENT'
  ): Promise<string[]> {
    const manager = this.postRepo.manager;
    const kept: string[] = [];
    for (const candidate of candidates) {
      const verdict = await readPostOpenVerdict(manager, post, { viewerId: candidate }, intent);
      if (verdict.refusal === null && !(await isBlockedBetween(manager, mentionerId, candidate))) {
        kept.push(candidate);
      }
    }
    if (kept.length < candidates.length) {
      this.logger.debug(
        `[MENTION] post ${post.id.slice(0, 8)}: ${candidates.length - kept.length} of ${candidates.length} mention(s) dropped by the read's gate`
      );
    }
    return kept;
  }

  /**
   * Notifies the people a post mentions (`post.mentions`, stored at the write and already narrowed
   * to the author's side of the review cohort), through `mentionRecipientsOf`. Called by ONE
   * caller, `PostAnnounceScheduler`, under its one-shot `feedNotifiedAt` claim when it first
   * publishes the post - within a sweep for a post published at once, at its date for a scheduled
   * one. One teller is what makes "told once" a fact rather than a reconciliation.
   *
   * An anonymous post stays anonymous to the people it mentions: the row carries no author.
   * Each recipient is isolated: one failed row does not silence the others.
   *
   * @returns how many were notified.
   */
  async notifyPostMentions(post: Post): Promise<number> {
    const candidates = (post.mentions ?? []).filter((id) => id && id !== post.authorId);
    if (candidates.length === 0) return 0;
    const recipients = await this.mentionRecipientsOf(
      post,
      post.authorId,
      candidates,
      'READ_OR_REACT'
    );
    if (recipients.length === 0) return 0;
    const actorId = post.anonymous ? ANONYMOUS_NOTIFICATION_ACTOR_ID : post.authorId;
    const actorName = post.anonymous
      ? ANONYMOUS_NOTIFICATION_ACTOR_NAME
      : await this.resolveActorName(post.authorId);
    let sent = 0;
    for (const recipientId of recipients) {
      try {
        // createNotification also sends the push (type 'social').
        await this.createNotification({
          recipientId,
          type: 'mention',
          postId: post.id,
          actorId,
          text: previewOf(post.markdown ?? ''),
          actorName,
        });
        sent++;
      } catch (e) {
        this.logger.warn(
          `[MENTION] post ${post.id.slice(0, 8)}: notification to ${recipientId.slice(0, 8)} failed`,
          e
        );
      }
    }
    this.logger.debug(`[MENTION] post ${post.id.slice(0, 8)}: ${sent} mention(s) notified`);
    return sent;
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
    type: NotificationType;
    postId: string;
    actorId: string;
    text: string;
    actorName?: string;
    /** The association whose logo the bell row draws instead of the actor's face (row only, never the push). */
    associationId?: string;
    associationLogoUrl?: string | null;
    /** The comment the row is about, for every row a comment writes (`PostNotification.commentId`). */
    commentId?: string;
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
   * Returns how many rows were written, so a caller can log a delivery that reached nobody. When the
   * rows are saved and only the push fails it throws {@link NotificationPushFailedError}, which
   * carries who has the row.
   */
  async createNotifications(data: {
    recipientIds: string[];
    type: NotificationType;
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

    try {
      await this.fanOutPush({ ...data, actorName }, recipients);
    } catch (err) {
      throw new NotificationPushFailedError(recipients, err);
    }
    return recipients.length;
  }

  /**
   * A push for a notice whose `post_notifications` row this method does NOT write - one per
   * recipient, through the same mapping, icon rule, bell and bounded fan-out as
   * {@link createNotifications}.
   *
   * For a notice about something that does not outlive its moment: a live (WP-L7) is deleted when it
   * ends (L3), so a bell row naming it would point at a 404 for ever after. The LIVE card at the top
   * of the feed is its in-app surface (L5). And for a notice whose rows the caller wrote ITSELF, in
   * a transaction of its own: the birthday notice commits its rows with its daily claim
   * (`BirthdayNotifier`), and pushes once that has committed. Returns how many recipients were
   * addressed, before the bell (which only the push consults, exactly as for a post).
   */
  async pushNotice(data: {
    recipientIds: string[];
    type: NotificationType | PushOnlyNotificationType;
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
   * The push half of a notice: the picture, the content, the bell, then the bounded fan-out. Shared
   * by {@link createNotifications} and {@link pushNotice} so neither can drift from the other's
   * mapping or bell. Throws only when the bell lookup fails (fail closed, see below).
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
      meta?: Record<string, unknown> | null;
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
      icon,
      data.meta
    );
    if (!content) {
      this.logger.warn(
        `[NOTIFY] no push content for type=${data.type} - ${recipients.length} recipient(s) ` +
          'got no system notification (any in-app row was written). Add the type to pushContent.'
      );
      return;
    }
    // THE BELL, applied HERE and server-side (engagement WP-3): any in-app row is already written (a
    // bell reduces the PUSH, never the bell list or the feed), and only a type a bell can reduce is
    // eligible (`BELL_PUSH_KINDS`) - mentions, replies, managers' operational pushes never are. The
    // account is the association when the push carries one, the person acting otherwise.
    let pushRecipients = recipients;
    const bell = bellTargetOf(data);
    if (bell) {
      // FAIL CLOSED, LOUDLY: if the lookup fails the push is NOT sent to everyone (that would
      // override a stated choice) and not silently dropped either - the error is logged here and
      // rethrown, so the caller's own warning names the post (or live) that was not pushed. A
      // post's in-app rows are already written, so the bell list still carries it.
      const withheld = await this.bells.withheldAmong(bell, recipients).catch((e: unknown) => {
        this.logger.error(
          `[NOTIFY] bell lookup failed for ${bell.kind}=${bell.id.slice(0, 8)} - ` +
            `push NOT sent to ${recipients.length} recipient(s): ${String(e)}`
        );
        throw e;
      });
      if (withheld.size > 0) {
        pushRecipients = recipients.filter((id) => !withheld.has(id));
        this.logger.log(
          `[NOTIFY] type=${data.type} ${bell.kind}=${bell.id.slice(0, 8)} ` +
            `push withheld by the bell from ${withheld.size} of ${recipients.length}`
        );
      }
    }
    // THE DAILY CAP (engagement WP-8, decisions 6 and 11), after the bell so a reader the bell
    // already silenced never spends a unit: only a type of `CAPPED_PUSH_TYPES` (an allowlist of the
    // kinds about an account the reader does not follow - a campus trend) is counted, every other push goes out exactly as before. Beyond the cap the
    // reader keeps the in-app row and gets no push. FAIL CLOSED, LOUDLY, as the bell: a failed claim
    // pushes nobody (pushing everyone would ignore the cap) and the error reaches the caller.
    const capped = CAPPED_PUSH_TYPES.get(data.type);
    if (capped && pushRecipients.length > 0) {
      const allowed = await claimEngagementPushes(
        this.notifRepo.manager,
        pushRecipients,
        capped.category
      ).catch((e: unknown) => {
        this.logger.error(
          `[NOTIFY] engagement cap claim failed for type=${data.type} - ` +
            `push NOT sent to ${pushRecipients.length} recipient(s): ${String(e)}`
        );
        throw e;
      });
      const kept = pushRecipients.length - allowed.size;
      if (kept > 0) {
        this.logger.log(
          `[NOTIFY] type=${data.type} capped: ${kept} of ${pushRecipients.length} kept in the bell ` +
            `(daily cap reached or category ${capped.category} off)`
        );
      }
      pushRecipients = pushRecipients.filter((id) => allowed.has(id));
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

  /**
   * Returns the most recent notifications for a user, newest first - never one whose actor stands
   * across the review cohort's boundary (`review-cohort.ts`): a row written before the rule is left
   * out, so nobody has to delete it.
   *
   * A row about a POST (`POST_BOUND_NOTIFICATION_TYPES`) is shown only while its recipient still
   * sees the post: the row carries a text preview, and access ends on paths no write here can hook
   * - the reader unfollows or leaves an institution, the author withdraws a republication or
   * removes a reposter, a carrier is archived, consent is withdrawn, the post is hidden. Gating at
   * the read is the one answer every one of those paths shares (Opus review of #2859, 2026-11-01,
   * for member reposts; every post-bound type since the review of #2965, 2026-11-02); the row
   * itself is left to the 90-day sweep. A PUSH already delivered to a device cannot be recalled.
   *
   * ONLY THE TYPES THE READER'S BUILD CAN DRAW are served (`notification-client-floor.ts`):
   * `clientVersion` is what the read's `X-Canari-Client-Version` names, `undefined` when it names
   * none (a build up to `1.6.9`). A row withheld that way is not lost: the same read from a newer
   * build serves it.
   */
  async getNotifications(userId: string, limit = 30, clientVersion?: string) {
    const rows = await this.bellPageQuery(userId, limit, clientVersion).getMany();
    const proposed = rows.filter((r) => r.type === 'repost_proposed' && r.text);
    if (proposed.length === 0) return rows;
    // A repost proposal's preview is re-asked here, at the read (`repostProposalTextWithheldSql`).
    const withheld: { id: string }[] = await this.notifRepo.manager.query(
      `SELECT n.id FROM post_notifications n
        WHERE n.id = ANY($1::uuid[]) AND ${repostProposalTextWithheldSql('n')}`,
      [proposed.map((r) => r.id)]
    );
    if (withheld.length === 0) return rows;
    const ids = new Set(withheld.map((r) => r.id));
    this.logger.debug(
      `[STUDENTS_ONLY] bell of ${userId.slice(0, 8)}: ${ids.size} repost proposal text(s) withheld`
    );
    for (const row of rows) if (ids.has(row.id)) row.text = '';
    return rows;
  }

  /**
   * The bell's page as ONE statement, shaped so its per-row visibility re-check (`bellRowShownSql`,
   * a correlated subquery) runs on about one page of rows and not on the reader's whole history:
   * the reader's rows, newest first, with the predicate and the LIMIT in the same SELECT and no join
   * (so TypeORM's `take` is a plain LIMIT), which migration 126's ("recipientId", "createdAt" DESC)
   * index walks in order and stops once the page is full - no sort. The plan is asserted on a seeded
   * PostgreSQL (`bell-page.integration.spec.ts`); the production volumes it was sized for are in
   * that migration and in the posts module's wiki page.
   */
  bellPageQuery(userId: string, limit: number, clientVersion?: string) {
    const types = notificationTypesRenderableBy(clientVersion);
    this.logger.debug(
      `[NOTIF] bell of ${userId.slice(0, 8)} for build ${clientVersion ?? 'undeclared'}: ` +
        `${types.length} renderable type(s)`
    );
    return (
      this.notifRepo
        .createQueryBuilder('n')
        .where('n."recipientId" = :userId', { userId })
        // An ALLOWLIST of what the reader's build draws: a type with no declared floor is served to nobody.
        .andWhere('n.type IN (:...renderableTypes)', { renderableTypes: types })
        .andWhere(sameSideOfReviewCohortSql('n."actorId"', 'n."recipientId"'))
        .andWhere(bellRowShownSql('n'))
        .orderBy('n.createdAt', 'DESC')
        .limit(limit)
    );
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
