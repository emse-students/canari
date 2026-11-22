/**
 * The one message-notification builder on Android, asked for from the WebView.
 *
 * **WHY THIS EXISTS.** Android had TWO builders for the same event, and they shared nothing but
 * the channel they filed on:
 *
 * | | the plain one | the rich one |
 * | --- | --- | --- |
 * | built by | this WebView, `tauri-plugin-notification` | `CanariFirebaseMessagingService` |
 * | triggered by | a WebSocket frame | an FCM data push |
 * | shows | a line of text | the sender's face, the thread, reply and mark-as-read |
 * | suppressed when | the reader can SEE the message land (`canSeeArrival`) | the app is in the foreground |
 * | a tap | opens the app onto nothing | opens the conversation |
 *
 * The two suppression predicates are DISJOINT - a backgrounded app satisfies neither - and the two
 * id namespaces cannot collide, so a message that arrived over the socket AND was pushed (the
 * server pushes a frame the client has not ACKed after 10 s) produced TWO notifications side by
 * side for one message. The user reported it on 2026-09-18 with a capture of the pair, and settled
 * the design in the same breath: *"pourquoi a-t-on encore des plain-notifications alors que les
 * rich notifications sont super"*.
 *
 * So the WebSocket frame stopped being a second BUILDER and became a second TRIGGER for the same
 * one. Both paths post under `getStableNotifId(groupId)`, which is what makes the second arrival an
 * UPDATE of the first rather than a second notification - Android replaces by id, whoever posted.
 *
 * **THE PLAIN PATH IS NOT DELETED, IT IS NOW WEB-ONLY** (and desktop, a different implementation
 * this session has not measured). It is the only builder those engines have.
 */

import { isAndroidTauriRuntime, isIosTauriRuntime } from '$lib/utils/appVersion';

/**
 * What the native builder needs in order to render the same notification for both triggers.
 *
 * Deliberately the shape of the PUSH PAYLOAD rather than of a banner: `groupName` is EMPTY for a
 * direct message, exactly as `push-payload.ts` defines it, so neither trigger has to be told which
 * of the two it is.
 */
export type NativeMessageNotification = {
  /** The conversation - the notification id, and the deep link a tap follows, both come from it. */
  conversationId: string;
  /** Whose avatar to draw. Empty falls back to the initials disc. */
  senderId: string;
  /** The name on the message line inside the conversation. */
  senderName: string;
  /** The conversation title, EMPTY for a direct message. */
  groupName: string;
  /** The preview text, already rendered (mentions resolved, media described). */
  body: string;
  /** Whether this message names the reader - it picks the channel, hence the reader's own switches. */
  mentionsMe: boolean;
  /**
   * The SENDER's instant in ms, 0 when unknown.
   *
   * Load-bearing, and not for display: it is what lets the native builder recognise that the push
   * and the WebSocket frame are the SAME message and refresh the shade without adding a second
   * line or alerting twice. Without it the notification is still single (the id is shared) but its
   * thread can show one message twice.
   */
  sentAt: number;
  /**
   * The SERVER's acceptance of the same message in ms, 0 when the frame carried none. Handed to the
   * shade's "mark as read" and quick reply, so the read mark they send lands on the clock the
   * conversation is ordered by (readState.ts, owner 2026-10-31).
   */
  serverAt: number;
  /**
   * HOW MANY INBOUND MESSAGES THIS ONE BANNER STANDS FOR: 1 for a live frame, N for a catch-up
   * flush, which raises a single banner for the last of N messages.
   *
   * Load-bearing for the pairing of a refused push's generic line with this banner
   * (`GenericBannerLedger`): the server may push each of the N messages, so one real post must
   * answer up to N pushes, not one (Mi 9T, 2026-10-06: `messages=5`, three pushes, one answered).
   */
  covers: number;
  /**
   * WHETHER THE OPEN PROVED THE AUTHOR - a salon row under a Graine v2 session
   * (`openChannelMessageProving`); false for anything else, and the native builder reads it for a
   * salon only. The push trigger decides a salon banner's speaker from the same fact (its native
   * open's `authorProven`), so both triggers of one message name the same speaker, or nobody,
   * whichever arrives first (`ChannelBannerAuthor`, 2026-11-01).
   */
  authorProven: boolean;
  /**
   * WHETHER THE CONVERSATION IS A GROUP OR A SALON, from its type - the fact the push carries as
   * `isGroup`. The name cannot answer it: a third of groups have none, and a group may be named
   * like one of its members. The native builder draws a group's notification as a group and a
   * direct message as one conversation with its sender (`ConversationShape`, 2026-11-11). `null`
   * when the row carries no type, which the builder reads as "not said" (`notificationIsGroup`).
   */
  isGroup: boolean | null;
};

/**
 * Asks the native builder to post (or update) this conversation's notification.
 *
 * @returns whether the native side ACCEPTED the work. It cannot promise more: building the
 *   notification fetches the sender's avatar over HTTP, so Kotlin queues it on its own lane and
 *   answers at once. `false` means the request reached no builder at all, which on Android leaves
 *   the reader with nothing - so the caller says so rather than quietly raising something else.
 *   Always `false` off Android, where there is no native builder to ask.
 */
export async function postNativeMessageNotification(
  notification: NativeMessageNotification
): Promise<boolean> {
  if (!isAndroidTauriRuntime()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('notify_native_message', {
      groupId: notification.conversationId,
      senderId: notification.senderId,
      senderName: notification.senderName,
      groupName: notification.groupName,
      body: notification.body,
      mentionsMe: notification.mentionsMe,
      sentAt: notification.sentAt,
      serverAt: notification.serverAt,
      covers: notification.covers,
      authorProven: notification.authorProven,
      isGroup: notification.isGroup,
      reaction: false,
    });
  } catch (e) {
    // NOT a fallback to the plain builder: reaching here means the one path failed, and the fix
    // belongs there. Logged at a level that accuses, because the reader got nothing.
    console.error(
      `[NOTIF] The native builder threw for ${notification.conversationId}: ${String(e)}`
    );
    return false;
  }
}

/**
 * What the native builder needs for a REACTION to one of this account's messages - the frame
 * trigger of `reactionNotification.ts`. The push's own fields, no more: the push carries an id, an
 * emoji and who reacted, never the message, and the builder composes the sentence itself from the
 * string the push uses (`notif_reaction_body`), so both triggers read the same words.
 */
export type NativeReactionNotification = {
  /** The conversation - the notification is filed under `reaction:<conversationId>`. */
  conversationId: string;
  /**
   * The reacted-to message: with the actor, the notification slot of this reaction
   * (`reactionCollapseKey`), which the push names too - so the two are one notification, and the
   * actor's next reaction to the same message replaces it.
   */
  messageId: string;
  /** Who reacted: whose face to draw, and whose nickname in this conversation to look up. */
  actorId: string;
  /** The actor's name as this device resolved it - the fallback behind their nickname. */
  actorName: string;
  emoji: string;
  /**
   * The reaction's own instant (`ReactionMsg.at`), the stamp of its line: the push carries the same
   * one (`at`), so whichever trigger arrives second is recognised and adds no line (`alreadyPosted`).
   */
  at: number;
};

/**
 * Asks the Android builder to post (or update) a conversation's REACTION notification, through the
 * same command a message takes with its `reaction` flag set - `body` then carries the emoji.
 *
 * @returns whether the native side ACCEPTED the work, exactly as {@link postNativeMessageNotification};
 *   always `false` off Android.
 */
export async function postNativeReactionNotification(
  reaction: NativeReactionNotification
): Promise<boolean> {
  if (!isAndroidTauriRuntime()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('notify_native_message', {
      groupId: reaction.conversationId,
      senderId: reaction.actorId,
      senderName: reaction.actorName,
      // A reaction is drawn as the push draws it: no conversation title, no group shape.
      groupName: '',
      body: reaction.emoji,
      mentionsMe: false,
      sentAt: reaction.at,
      serverAt: 0,
      covers: 1,
      authorProven: false,
      isGroup: null,
      reaction: true,
    });
  } catch (e) {
    // NOT a fallback: in the foreground this is the only path to the reaction's notification.
    console.error(
      `[NOTIF] The native builder threw for the reaction in ${reaction.conversationId}: ${String(e)}`
    );
    return false;
  }
}

/**
 * Which event told this device that its account read a conversation: an own MLS `read_watermark`
 * from another device, an own salon `channel.read`, or `read_here` - THIS device's reader opening
 * it, which no push and no socket echo ever reports back (`openedConversationDismissal.ts`).
 */
export type ReadElsewhereEvent = 'read_watermark' | 'channel.read' | 'read_here';

/**
 * Why a conversation's notifications were taken down on iOS: a read, or its ENDING. An ending is
 * not a read and never travels the read path - Android has its own command, and records no mark.
 */
export type NotificationTakedownReason = ReadElsewhereEvent | 'conversation_ended';

/**
 * Tells the Android builder that this account read a conversation on another device, as this
 * WebView learned it over its socket, so it REMOVES the conversation's notification once the read
 * covers every line of it.
 *
 * **THE SECOND TRIGGER OF THE CANCEL**, as {@link postNativeMessageNotification} is the second
 * trigger of the post (owner's report, 2026-11-20). The cancel had one trigger, the push - a silent
 * self frame, or `channel_read` - and the server pushes only a frame the device did not ACK. A read
 * receipt this WebView received and ACKed (app in front, or backgrounded and not yet frozen) was
 * therefore never pushed, and the banner this WebView had posted for the conversation stayed in the
 * shade for good. Same key as the post (the conversation id), so the two triggers of each meet.
 *
 * **THE NATIVE SIDE DECIDES, NOT THIS ROW.** The post of a message is asynchronous before it reaches
 * Kotlin, so a read covering it may land first and find nothing to remove: Kotlin records `at` and
 * refuses any later post at or below it (`ReadElsewhereMarks`), so the order of arrival decides
 * nothing. And it removes the banner only when `at` covers every line the shade holds: this row can
 * lag behind the shade (a frozen WebView drains a read from before a message the push already
 * announced, and counts nothing unread), so whether anything is unread is not this side's to say.
 * Handed over on EVERY own read, moved or not. `clock` says which clock `at` is on (readState.ts):
 * `server` for a mark on the server's `createdAt`, `stamped` otherwise.
 *
 * Off Android there is no native banner: `false`, and nothing is invoked.
 *
 * @returns whether the native side queued the work.
 */
export async function recordNativeReadElsewhere(
  conversationId: string,
  event: ReadElsewhereEvent,
  at: number,
  clock: 'server' | 'stamped'
): Promise<boolean> {
  if (!isAndroidTauriRuntime()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const queued = await invoke<boolean>('record_read_elsewhere', {
      groupId: conversationId,
      at: Number.isFinite(at) ? Math.trunc(at) : 0,
      serverClock: clock === 'server',
      reason: event,
    });
    if (!queued) {
      console.error(
        `[NOTIF] The native side refused the read of ${conversationId} elsewhere (${event}) - a banner for it may stay.`
      );
    }
    return queued;
  } catch (e) {
    // Said at a level that accuses: the banner of a conversation already read may stay in the shade.
    console.error(
      `[NOTIF] Handing over the read of ${conversationId} elsewhere (${event}) threw - a banner for it may stay: ${String(e)}`
    );
    return false;
  }
}

/**
 * Takes down a conversation's delivered notifications on iOS - the page's reader opened it
 * (`read_here`) or it ended (`conversation_ended`; see {@link endNativeConversationNotifications}). iOS posts under the conversation's thread, so
 * the native side removes by thread and recomputes the badge; it keeps no read mark, because a
 * message newer than the reading cannot be on a banner of a conversation that is on screen.
 *
 * One call per conversation EVENT, never a sweep: opening the app clears nothing (owner,
 * 2026-11-21). Off iOS: `false`, nothing invoked.
 *
 * @returns whether the native side queued the removal.
 */
export async function cancelNativeConversationNotifications(
  conversationId: string,
  event: NotificationTakedownReason
): Promise<boolean> {
  if (!isIosTauriRuntime()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const queued = await invoke<boolean>('cancel_conversation_notifications', {
      groupId: conversationId,
      reason: event,
    });
    if (!queued) {
      console.error(
        `[NOTIF] The native side refused to take down the notifications of ${conversationId} (${event}) - a banner for it may stay.`
      );
    }
    return queued;
  } catch (e) {
    console.error(
      `[NOTIF] Taking down the notifications of ${conversationId} (${event}) threw - a banner for it may stay: ${String(e)}`
    );
    return false;
  }
}

/**
 * The page's hand-over of a READ of a conversation to the native notification shade, whichever OS:
 * Android decides against a mark (`record_read_elsewhere`), iOS removes by thread. A runtime with no
 * native shade (web, desktop) answers `true`: there is nothing to hand over, and nothing failed.
 *
 * @param at the mark Android weighs lines against; `clock` says which clock it is on.
 * @returns whether the work was queued where there is a native shade.
 */
export async function handOverConversationEvent(
  conversationId: string,
  event: ReadElsewhereEvent,
  at: number,
  clock: 'server' | 'stamped'
): Promise<boolean> {
  if (isAndroidTauriRuntime()) return recordNativeReadElsewhere(conversationId, event, at, clock);
  if (isIosTauriRuntime()) return cancelNativeConversationNotifications(conversationId, event);
  return true;
}

/**
 * Takes down EVERYTHING a conversation that ENDED (deleted, left, excluded, its salon or community
 * gone) left in the shade: its message banner - a pending reply and a held banner included - its
 * reaction notification and its share of the summary.
 *
 * **AN ENDING IS NOT A READ.** Android has its own command, which records NO read mark: a mark is a
 * process-lifetime suppressor, and one written for an ending would silence the conversation if the
 * account came back to it (a rejoin, a sign-in after a sign-out). iOS removes by thread, as for a
 * read. Off a native shade: `true`, nothing invoked.
 *
 * @returns whether the work was queued where there is a native shade.
 */
export async function endNativeConversationNotifications(conversationId: string): Promise<boolean> {
  if (isIosTauriRuntime())
    return cancelNativeConversationNotifications(conversationId, 'conversation_ended');
  if (!isAndroidTauriRuntime()) return true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const queued = await invoke<boolean>('end_conversation_notifications', {
      groupId: conversationId,
      reason: 'conversation_ended',
    });
    if (!queued) {
      console.error(
        `[NOTIF] The native side refused to end the notifications of ${conversationId} - a banner for it may stay.`
      );
    }
    return queued;
  } catch (e) {
    console.error(
      `[NOTIF] Ending the notifications of ${conversationId} threw - a banner for it may stay: ${String(e)}`
    );
    return false;
  }
}

/**
 * The conversation title a notification should carry, from the row the client already holds.
 *
 * EMPTY for a direct message, which is the server's own contract for `groupName` in a push - see
 * `push-payload.ts`. A CHANNEL is titled with the salon's name alone, where the push titles it
 * `<Communaute> - #<salon>` (`buildChannelPushTitle`): the salon row carries no community name. The
 * two converge on one notification whichever arrives second, its line and speaker one answer
 * (`ChannelBannerAuthor`), so the difference is the title's wording, not a duplicate.
 *
 * `contactName` and `name` do NOT carry the same thing for every type: for a plain group they
 * agree, but every channel row builder (`useChannelWorkspaces.svelte.ts`) deliberately keeps
 * `contactName` as the raw `channel_<uuid>` id - the key seed routing reads - and puts the
 * community's actual channel name in `name`. Preferring `contactName` there titled every channel
 * notification with its own conversation id.
 *
 * `groupTitle` is a GROUP's title as the list draws it (`resolveConversationListPresentation`),
 * and wins when given: an unnamed group's row holds no name, or only its id, and the list names it
 * by its members' first names (owner, 2026-11-17) - a notification titled otherwise would name the
 * same conversation differently from the row it opens.
 */
export function notificationGroupName(
  conversationType: 'direct' | 'group' | 'channel' | undefined,
  contactName: string,
  name: string,
  groupTitle?: string | null
): string {
  if (conversationType === 'direct') return '';
  if (conversationType === 'channel') return name || contactName;
  return groupTitle || contactName || name;
}

/**
 * The title and body of a message notification raised by the PLAIN plugin or the web API - iOS (a
 * frame that arrives while the app is alive in the background), desktop and the browser, which have
 * no native builder and no subtitle line.
 *
 * A group is titled by ITS name and the speaker leads the body ("Alice: [Media]"), exactly the
 * hierarchy the iOS extension draws (group title, sender subtitle) and the Android builder draws
 * from the same `groupName`. Handing the plugin the sender alone as the title lost the group, so a
 * group message read "Alice / [Media]" on the lock screen whenever this path, not the extension,
 * raised it (iPhone 12 sitting, 2026-11-16). A direct message, or a group with no name to show,
 * keeps the sender as the title and the body untouched.
 */
export function composePlainNotificationText(
  senderName: string,
  body: string,
  native?: Pick<NativeMessageNotification, 'groupName' | 'isGroup'>
): { title: string; body: string } {
  const groupName = native?.groupName.trim() ?? '';
  if (native?.isGroup === false || groupName === '') return { title: senderName, body };
  return { title: groupName, body: senderName ? `${senderName}: ${body}` : body };
}

/**
 * Whether the conversation is a group, for the native builder - the push payload's `isGroup`, read
 * from the row's type. A salon is a group. `null` when the row carries no type (a row written before
 * the field existed): unknown, exactly as the push's absent `isGroup`, and the builder then falls back
 * to the name rule rather than inventing an answer.
 */
export function notificationIsGroup(
  conversationType: 'direct' | 'group' | 'channel' | undefined
): boolean | null {
  if (conversationType === undefined) return null;
  return conversationType !== 'direct';
}
