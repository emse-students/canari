/**
 * THE SECOND TRIGGER OF A REACTION NOTIFICATION - the WebSocket frame, decided here.
 *
 * A reaction to one of MY messages had ONE trigger: `POST /api/mls/notify-reaction` pushes
 * `type=social, reaction=true` to the message's author, and the push handler draws it - unless the
 * app is in the foreground, where Android (`MainActivity.isInForeground`) and iOS (`willPresent`,
 * `canari_push.mm`) both drop it, because "the bubble on screen already carries the reaction". That
 * reason holds only while THAT conversation is on screen; the predicate was the whole app. So a
 * reaction landing while the app was open on the feed, in another conversation or in a salon was
 * lost, and the web and desktop, which have no push, never notified one at all (owner, 2026-11-17;
 * [backlog](../../../../../docs/wiki/backlog.d/p2-a-reaction-to-my-message-notifies-nobody-while-the-app-is-open.md)).
 *
 * A message has a second trigger for exactly that case - the frame, decided by `canSeeArrival` - and
 * this gives a reaction the same one:
 *
 * | | the push | the frame (this file) |
 * | --- | --- | --- |
 * | drawn when | the app is NOT in the foreground | the app IS in the foreground, the conversation off screen |
 * | on Android | `handleReactionNotification` | `notifier_message_natif` with `reaction = true` |
 * | on iOS | the extension / `canari_push.mm` | the plain plugin |
 * | on web and desktop | never (no push) | the Notification API / the plugin |
 *
 * DISJOINT BY CONSTRUCTION: the two predicates are one fact read twice - the foreground flag the
 * Android activity and the iOS shell write into the page (`appForeground.ts`) is the same state
 * their push handlers read - and on Android both post under the ONE key `reaction:<groupId>`, so a
 * transition between the two reads replaces rather than doubles. `reactionNotification.test.ts`
 * holds both halves.
 *
 * PURE ON PURPOSE: every fact is passed in, so the whole matrix is asserted without a runtime.
 */
import {
  conversationLevelRefusal,
  type ConversationNotificationLevel,
} from '$lib/notifications/conversationLevel';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import type { IncomingDeliveryMeta } from '$lib/mls-client/incomingDelivery';

/** What applying one inbound reaction frame established, handed to the trigger. */
export interface InboundReaction {
  /** The conversation the frame belongs to - a DM / group key, or `channel_<id>` for a salon. */
  conversationKey: string;
  /** The reacted-to message. */
  messageId: string;
  /** Who reacted - the frame's proven sender. */
  reactorId: string;
  emoji: string;
  /** True when the frame TAKES a reaction back. */
  removed: boolean;
  /**
   * Whether the frame changed what this device holds. False is a replay, or a state older than the
   * one held (`applyReaction` returned null) - neither is news.
   */
  changed: boolean;
  /** The reacted-to message's author as this device holds it, or null when it holds no copy. */
  messageAuthorId: string | null;
  /**
   * Whether the frame came over the live socket the moment it was sent (`deliveryMeta.channel ===
   * 'live'`, and not ahead of the mailbox listing). A pulled row, a page of history or a catch-up
   * drain may be hours old: the push already announced it in the background, so announcing it again
   * on resume would be the double this file must never produce.
   */
  live: boolean;
}

/**
 * Whether an MLS frame's delivery makes it LIVE in the sense {@link InboundReaction.live} needs: the
 * socket handed it over the moment it was sent (`channel === 'live'`), it did not overtake a mailbox
 * this link had not listed yet (`aheadOfMailbox` - rows queued while away may still be behind it),
 * and it is not a history answer addressed to this device alone (`addressed`, a replay of old
 * frames). Anything else may be hours old, and its reaction already announced by the push.
 */
export function isLiveDelivery(meta: IncomingDeliveryMeta | undefined): boolean {
  return meta?.channel === 'live' && meta.aheadOfMailbox !== true && meta.addressed !== true;
}

/**
 * What one applied reaction frame means for this account's notifications.
 *
 * - `not-mine`: no reaction to a message of mine by someone else - the ordinary frame, said nowhere.
 * - `refused`: a reaction to my message that is nevertheless not news - said, because it IS one.
 * - `owed`: a fresh reaction by someone else to my message; the screen decides the rest
 *   ({@link reactionTriggerRefusal}).
 */
export type InboundReactionVerdict =
  | { kind: 'not-mine'; why: string }
  | { kind: 'refused'; why: string }
  | { kind: 'owed' };

/** The facts of the frame alone - nothing about the screen. */
export function inboundReactionVerdict(
  reaction: InboundReaction,
  myUserId: string
): InboundReactionVerdict {
  const me = canonicalUserId(myUserId);
  if (canonicalUserId(reaction.reactorId) === me) {
    return { kind: 'not-mine', why: 'my own reaction, from another device' };
  }
  if (reaction.messageAuthorId === null) {
    return { kind: 'not-mine', why: 'its message is not on this device' };
  }
  if (canonicalUserId(reaction.messageAuthorId) !== me) {
    return { kind: 'not-mine', why: 'not a reaction to my message' };
  }
  if (reaction.removed) return { kind: 'refused', why: 'a removal, which is never news' };
  if (!reaction.changed) {
    return { kind: 'refused', why: 'a replay or an older state than the one held' };
  }
  if (!reaction.live) {
    return { kind: 'refused', why: 'not a live frame (a catch-up never announces a reaction)' };
  }
  return { kind: 'owed' };
}

/** The runtime facts the trigger is decided on, gathered by the caller. */
export interface ReactionTriggerFacts {
  /**
   * The foreground flag the shell writes (`isAppInForeground`): the SAME fact the push handlers read
   * to drop a reaction push. Always true on web and desktop, which have no push to defer to.
   */
  appInForeground: boolean;
  /** Whether the reader can see the conversation (`canSeeArrival`): the bubble then carries it. */
  conversationOnScreen: boolean;
  /** Whether the account's `reactions` category may be pushed (`notificationPreferences.pushAllowed`). */
  reactionsAllowed: boolean;
  /**
   * The private conversation's level, or `undefined` for a salon. The server applies a level to a
   * private conversation's reaction only (`sendPushToUser`: a `channel_<id>` names no group row), so
   * this trigger does the same - one rule for both builders, never one decided by the route.
   */
  level: ConversationNotificationLevel | undefined;
}

/**
 * Why the frame trigger does NOT raise this reaction, or null when it does.
 *
 * The foreground term comes FIRST and is what makes this trigger disjoint from the push: a reaction
 * that lands while the app is not in front is the push's to draw, whatever else is true.
 */
export function reactionTriggerRefusal(facts: ReactionTriggerFacts): string | null {
  if (!facts.appInForeground) return 'the app is not in the foreground - the push draws it';
  if (facts.conversationOnScreen) return 'its conversation is on screen - the bubble shows it';
  if (!facts.reactionsAllowed) return 'the "reactions" category is switched off for this account';
  // A reaction is never a mention, so `mentions` refuses it exactly as `none` does - the server's
  // `level !== 'all'`.
  if (facts.level !== undefined) return conversationLevelRefusal(facts.level, false);
  return null;
}

/**
 * The notification id key of a conversation's REACTION notification - `reaction:<groupId>`, the
 * Kotlin `reactionNotifKey` spelled the same: a reaction never overwrites the conversation's unread
 * message notification, and a second reaction updates the first rather than stacking.
 */
export function reactionNotificationKey(conversationKey: string): string {
  return `reaction:${conversationKey}`;
}
