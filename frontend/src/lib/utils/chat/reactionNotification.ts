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
 * [backlog](../../../../../docs/wiki/frontend/mobile.md#the-frame-trigger-of-a-reaction-2026-11-17)).
 *
 * A message has a second trigger for exactly that case - the frame, decided by `canSeeArrival` - and
 * this gives a reaction the same one:
 *
 * | | the push | the frame (this file) |
 * | --- | --- | --- |
 * | drawn when | the app is NOT in the foreground | the conversation is off screen, the frame live |
 * | on Android | `handleReactionNotification` | `notify_native_message` with `reaction = true` |
 * | on iOS | the extension / `canari_push.mm` | the plain plugin |
 * | on web and desktop | never (no push) | the Notification API / the plugin |
 *
 * NOT DISJOINT, DEDUPLICATED - BY IDENTITY, NEVER BY A FLAG READ AT TWO MOMENTS. The two triggers
 * decide at different instants (the frame now, the push when it lands), so any "who draws it" flag
 * races: a page that deferred to the push while the app was inactive, then a push landing after the
 * user came back, was dropped too - nobody announced it (review of #3792, round 2). So the frame
 * trigger ignores the app's state and BOTH may post, as ONE notification identified by the reaction
 * itself: on Android both stamp the line with the reaction's own instant `at`, which the builder's
 * `alreadyPosted` and its alerted ledger recognise (under one lock, `showReactionNotification`); on
 * iOS both carry the identifier {@link reactionCollapseId} - the plugin's request id, the push's
 * `apns-collapse-id`, one per reactor and message - and the system replaces one by the other, as it
 * replaces that reactor's older reaction to the same message. A frame WITHOUT `at` (a reactor
 * predating it, whose push carries none either) cannot be told apart from its push, so on a phone it
 * is left to the push as before #3792; web and desktop have no push and raise it.
 *
 * PURE ON PURPOSE: every fact is passed in, so the whole matrix is asserted without a runtime.
 */
import {
  conversationLevelRefusal,
  type ConversationNotificationLevel,
} from '$lib/notifications/conversationLevel';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import type { IncomingDeliveryMeta } from '$lib/mls-client/incomingDelivery';
import { stableNotifId } from '$lib/utils/stableNotifId';

/** What applying one inbound reaction frame established, handed to the trigger. */
export interface InboundReaction {
  /** The conversation the frame belongs to - a DM / group key, or `channel_<id>` for a salon. */
  conversationKey: string;
  /** The reacted-to message. */
  messageId: string;
  /** Who reacted - the frame's proven sender. */
  reactorId: string;
  emoji: string;
  /** The reaction's own instant (`ReactionMsg.at`, the reactor's clock) - the stamp of its line. */
  at: number;
  /** True when the frame TAKES a reaction back. */
  removed: boolean;
  /**
   * Whether the frame changed what this device holds. False is a replay, or a state older than the
   * one held (`applyReaction` returned null) - neither is news.
   */
  changed: boolean;
  /**
   * The reacted-to message's author: the row this device holds (screen, then store), else the author
   * the frame STATES (`ReactionMsg.target_author_id`, the reactor's own claim, the one its push to the
   * author already rests on). Null only when neither answers.
   */
  messageAuthorId: string | null;
  /**
   * Whether the store was asked for the row and could NOT answer (a read that threw, a row sealed
   * under a key this device cannot open). Only then is a null author a real unknown.
   */
  authorLookupFailed: boolean;
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
 * - `unattributed`: news on a message held nowhere, from a reactor predating `target_author_id` - it
 *   names no author, so whose it is cannot be told. Said ONCE per session by the caller: every heart
 *   in a salon never drawn reads this way until its reactor updates.
 * - `unresolved`: news whose author the STORE failed to give - a real unknown, warned each time.
 * - `refused`: a reaction to my message that is nevertheless not news - said, because it IS one.
 * - `owed`: a fresh reaction by someone else to my message; the screen decides the rest
 *   ({@link reactionTriggerRefusal}).
 */
export type InboundReactionVerdict =
  | { kind: 'not-mine'; why: string }
  | { kind: 'unattributed'; why: string }
  | { kind: 'unresolved'; why: string }
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
    // Whose message it is cannot be told - but a frame that would be no news even on MY message
    // loses nothing, and a salon of two hundred would otherwise print a line per heart taken back.
    if (reaction.removed || !reaction.changed || !reaction.live) {
      return {
        kind: 'not-mine',
        why: 'its message is not on this device, and the frame is no news',
      };
    }
    if (reaction.authorLookupFailed) {
      return {
        kind: 'unresolved',
        why: 'the store could not give its row, and the frame names no author',
      };
    }
    return {
      kind: 'unattributed',
      why: 'its message is held nowhere here and the frame names no author (a reactor predating target_author_id)',
    };
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
   * Whether a MESSAGE landing in this conversation would be seen where it lands (`canSeeArrival`, the
   * message path's own predicate): the conversation open, or its row in a list on screen. A message
   * there gets a tone at most and never an OS notification, so neither does a reaction - A REACTION
   * NEVER ANNOUNCES LOUDER THAN A MESSAGE WOULD IN THE SAME PLACE (coordinator, 2026-11-23,
   * principle 3; docs/wiki/frontend/mobile.md#the-frame-trigger-of-a-reaction-2026-11-17).
   */
  arrivalSeen: boolean;
  /**
   * Whether this runtime has a reaction PUSH that may draw the same reaction (a phone). Web and
   * desktop have none: the frame is their only trigger.
   */
  pushMayDraw: boolean;
  /** The reaction's own instant (`ReactionMsg.at`): what makes the two triggers' posts ONE. */
  at: number;
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
 * Why the frame trigger does NOT raise this reaction, or null when it does. The app's foreground
 * state is deliberately NOT a term: both triggers may post, and the reaction's identity makes them
 * one (see the file header).
 */
export function reactionTriggerRefusal(facts: ReactionTriggerFacts): string | null {
  if (facts.arrivalSeen) {
    return 'a message landing there would be seen, so it would raise no notification - nor does a reaction';
  }
  if (facts.pushMayDraw && !(facts.at > 0)) {
    return 'it carries no instant, so it cannot be told apart from its push - the push draws it';
  }
  if (!facts.reactionsAllowed) return 'the "reactions" category is switched off for this account';
  // A reaction is never a mention, so `mentions` refuses it exactly as `none` does - the server's
  // `level !== 'all'`.
  if (facts.level !== undefined) return conversationLevelRefusal(facts.level, false);
  return null;
}

/**
 * The Android shade key of a conversation's REACTION notification - `reaction:<groupId>`, the Kotlin
 * `reactionNotifKey` spelled the same: a reaction never overwrites the conversation's unread message
 * notification, and a second reaction joins the first as a line.
 */
export function reactionNotificationKey(conversationKey: string): string {
  return `reaction:${conversationKey}`;
}

/**
 * The notification slot of ONE REACTOR ON ONE MESSAGE - `reaction:<messageId>:<reactor>` - from which
 * the plain builders derive the notification's id ({@link reactionCollapseId}). The reactor is folded
 * to lower case as the server's `canonicalUserId` folds it (ids are ASCII), so both sides spell it
 * alike.
 *
 * NO INSTANT IN IT (2026-11-18): with `at` in the key, a reactor who changed one emoji for another
 * left TWO entries in the iPhone's Notification Center, where the Android shade replaces the line.
 * The slot is what a notification REPLACES, and a reactor's newer reaction to the same message
 * replaces their older one
 * ([read on the iPhone](../../../../../docs/wiki/device-verification.md#the-iphone-12-readings-of-2026-11-26-evening-182-build-100800209-five-iphone-entries-and-a-read-withheld-until-the-first-touch)).
 * The page's post and the push of the same reaction still share it, so they are still one.
 *
 * THE REACTED-TO MESSAGE, NEVER THE CONVERSATION: the server sends this hash to Apple on the
 * content-free wake, and a hash over the conversation and the reactor could be checked against what a
 * call ring names in clear (review of #3792, round 3). No wake and no ring names the message.
 */
export function reactionCollapseKey(messageId: string, reactorId: string): string {
  return `reaction:${messageId}:${reactorId.toLowerCase()}`;
}

/**
 * The iOS identifier of one reactor's notification on one message, in decimal: the plugin's request
 * id for the page's post (`stableNotifId` of {@link reactionCollapseKey}) and the `apns-collapse-id`
 * the server sends with the push (chat-delivery-service `reactionCollapseId`, pinned to this by a
 * shared vector).
 */
export function reactionCollapseId(messageId: string, reactorId: string): string {
  return String(stableNotifId(reactionCollapseKey(messageId, reactorId)));
}
