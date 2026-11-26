import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  inboundReactionVerdict,
  isLiveDelivery,
  reactionCollapseId,
  reactionCollapseKey,
  reactionNotificationKey,
  reactionTriggerRefusal,
  type InboundReaction,
  type ReactionTriggerFacts,
} from './reactionNotification';
import { stableNotifId } from '$lib/utils/stableNotifId';

/**
 * THE FRAME TRIGGER OF A REACTION TO MY MESSAGE (owner, 2026-11-17).
 *
 * A reaction push is dropped whenever the app is in the foreground, on Android and on iOS, even when
 * its conversation is not on screen - and a reaction had no second trigger, so it notified nobody.
 * This file pins the second trigger's decision AND the property that makes it safe to add: when it
 * and the push both draw one reaction, the reaction's own identity makes the two posts ONE.
 */

const ME = 'me-user-id';
const PEER = 'peer-user-id';

const FRESH: InboundReaction = {
  conversationKey: 'grp-1',
  messageId: 'msg-1',
  reactorId: PEER,
  emoji: '❤️',
  at: 1_700_000_000_123,
  removed: false,
  changed: true,
  messageAuthorId: ME,
  authorLookupFailed: false,
  live: true,
};

describe('inboundReactionVerdict - the frame alone', () => {
  it('owes a notification for a fresh live reaction by someone else to my message', () => {
    expect(inboundReactionVerdict(FRESH, ME)).toEqual({ kind: 'owed' });
  });

  it('compares the ids canonically - the case of an id is not who it names', () => {
    expect(inboundReactionVerdict({ ...FRESH, messageAuthorId: ME.toUpperCase() }, ME)).toEqual({
      kind: 'owed',
    });
  });

  it.each([
    ['my own reaction from another device', { reactorId: ME }],
    ['a reaction to somebody else', { messageAuthorId: PEER }],
    [
      'a removal on a message this device holds no copy of',
      { messageAuthorId: null, removed: true },
    ],
    [
      'a replay on a message this device holds no copy of',
      { messageAuthorId: null, changed: false },
    ],
    [
      'a catch-up on a message this device holds no copy of',
      { messageAuthorId: null, live: false },
    ],
  ] as const)('is not about me: %s', (_, change) => {
    expect(inboundReactionVerdict({ ...FRESH, ...change }, ME).kind).toBe('not-mine');
  });

  it('NEVER CALLS "NOT MINE" WHAT IT CANNOT TELL - and tells the two unknowns apart', () => {
    // The store answered "no such row" and the frame names no author: a reactor predating
    // `target_author_id`, said once per session by the caller (a salon never drawn reads this way).
    expect(inboundReactionVerdict({ ...FRESH, messageAuthorId: null }, ME).kind).toBe(
      'unattributed'
    );
    // The store FAILED to answer: a real unknown, warned each time.
    expect(
      inboundReactionVerdict({ ...FRESH, messageAuthorId: null, authorLookupFailed: true }, ME)
    ).toEqual({
      kind: 'unresolved',
      why: 'the store could not give its row, and the frame names no author',
    });
  });

  it.each([
    ['a removal - taking a reaction back is never news', { removed: true }],
    ['a replay, or a state older than the one held', { changed: false }],
    // A catch-up on resume can carry a reaction the push already drew in the background.
    ['a frame that did not arrive live', { live: false }],
  ] as const)('is refused, and said: %s', (_, change) => {
    expect(inboundReactionVerdict({ ...FRESH, ...change }, ME).kind).toBe('refused');
  });
});

describe('isLiveDelivery', () => {
  it('is live only for a socket frame that neither overtook the mailbox nor answers a history ask', () => {
    expect(isLiveDelivery({ channel: 'live' })).toBe(true);
    expect(isLiveDelivery({ channel: 'pull' })).toBe(false);
    expect(isLiveDelivery(undefined)).toBe(false);
    expect(isLiveDelivery({ channel: 'live', aheadOfMailbox: true })).toBe(false);
    expect(isLiveDelivery({ channel: 'live', addressed: true })).toBe(false);
  });
});

describe('reactionTriggerRefusal - the screen', () => {
  const OPEN: ReactionTriggerFacts = {
    arrivalSeen: false,
    pushMayDraw: true,
    at: 1_700_000_000_123,
    reactionsAllowed: true,
    level: 'all',
  };

  it('raises it whenever the conversation is off screen', () => {
    expect(reactionTriggerRefusal(OPEN)).toBeNull();
    // A salon carries no level, exactly as the server applies none to a salon reaction.
    expect(reactionTriggerRefusal({ ...OPEN, level: undefined })).toBeNull();
  });

  it('NEVER ASKS WHETHER THE APP IS IN FRONT: no fact it reads can race the push gate', () => {
    // Round 2 of the review: a flag read now and a push gate read when the push lands disagreed,
    // and both deferred - nobody announced the reaction. The facts carry no foreground term at all;
    // the reaction's identity (`at`) makes the two posts one instead.
    expect(Object.keys(OPEN).sort()).toEqual(
      ['arrivalSeen', 'at', 'level', 'pushMayDraw', 'reactionsAllowed'].sort()
    );
  });

  it('leaves a frame WITHOUT its instant to the push on a phone - it could not be made one with it', () => {
    for (const at of [0, Number.NaN]) {
      expect(reactionTriggerRefusal({ ...OPEN, at })).toBe(
        'it carries no instant, so it cannot be told apart from its push - the push draws it'
      );
      // Web and desktop have no push: the frame is their only trigger.
      expect(reactionTriggerRefusal({ ...OPEN, at, pushMayDraw: false })).toBeNull();
    }
  });

  it('stays quiet when the conversation is on screen - the bubble carries it', () => {
    expect(reactionTriggerRefusal({ ...OPEN, arrivalSeen: true })).toMatch(/would be seen/);
  });

  it("obeys the account's reactions switch and the conversation's level, as the server does", () => {
    expect(reactionTriggerRefusal({ ...OPEN, reactionsAllowed: false })).toMatch(/reactions/);
    // A reaction is never a mention: `mentions` refuses it as `none` does (server: level !== 'all').
    expect(reactionTriggerRefusal({ ...OPEN, level: 'mentions' })).toMatch(/mentions/);
    expect(reactionTriggerRefusal({ ...OPEN, level: 'none' })).toMatch(/none/);
  });
});

/**
 * THE OTHER HALF OF THE PROOF: what the push does, read from the native sources, because nothing
 * else spans the languages - it drops a reaction in the foreground (where the frame is the only
 * trigger), and when both draw one, they post it as ONE notification.
 */
describe('the push half', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '../../../../src-tauri');
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
  const kotlin = read(
    'gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
  );
  const objc = read('gen/apple/Sources/canari/canari_push.mm');

  it('Android drops a reaction push in the foreground, before it reaches the reaction builder', () => {
    expect(kotlin).toMatch(/val isReaction = msgType == "social" && data\["reaction"\] == "true"/);
    // The `social` exemption does not cover a reaction (`ForegroundGuard`, the one list of what acts
    // in front)...
    const foregroundGuard = read(
      'gen/android/app/src/main/java/fr/emse/canari/push/ForegroundGuard.kt'
    );
    expect(foregroundGuard).toContain('(type == "social" && !isReaction)');
    // ...so the foreground guard returns before the reaction branch is reached.
    const guard = kotlin.indexOf(
      'if (MainActivity.isInForeground && !ForegroundGuard.actsInForeground(msgType, isReaction))'
    );
    const branch = kotlin.indexOf(
      'runWithWakeLock("fcm_reaction") { handleReactionNotification(data) }'
    );
    expect(guard).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(guard);
  });

  it('Android: the two triggers check-and-post one reaction under ONE lock', () => {
    // The push's FCM thread and the WebSocket lane may build the same reaction at once; interleaved,
    // both would find the shade empty and both alert.
    const composer = kotlin.slice(kotlin.indexOf('internal fun Context.showReactionNotification('));
    const body = composer.slice(0, composer.indexOf('\n        }\n'));
    expect(body).toMatch(/synchronized\(REACTION_POST_LOCK\) \{\s*showMessageNotification\(/);
    expect(kotlin).toContain('private val REACTION_POST_LOCK = Any()');
  });

  it('iOS: the page and the push name ONE reaction by ONE identifier', () => {
    // The plugin files the page's post under `"\(notification.id)"`; the server sends the push with
    // `apns-collapse-id` = the same decimal (chat-delivery-service `push-payload.spec.ts` asserts this
    // very vector), so the system replaces one by the other.
    expect(reactionCollapseKey('msg-1', 'Peer-User')).toBe('reaction:msg-1:peer-user');
    expect(reactionCollapseId('msg-1', 'Peer-User')).toBe('97988016');
    expect(reactionCollapseId('srv-row-9', 'peer')).toBe('71866787');
    expect(String(stableNotifId(reactionCollapseKey('msg-1', 'peer-user')))).toBe('97988016');
  });

  it("iOS: a reactor's second reaction to the same message REPLACES the first, as Android's line does", () => {
    // The slot carries no instant: two reactions by one reactor to one message are one entry in
    // Notification Center (iPhone 12, 1.7.0-alpha.11, 2026-11-18: two entries before).
    expect(reactionCollapseKey('msg-1', 'peer')).toBe('reaction:msg-1:peer');
    expect(reactionCollapseId('msg-1', 'peer')).toBe(reactionCollapseId('msg-1', 'PEER'));
    // ...while another reactor, or another message, keeps its own entry.
    expect(reactionCollapseId('msg-1', 'peer')).not.toBe(reactionCollapseId('msg-1', 'other'));
    expect(reactionCollapseId('msg-1', 'peer')).not.toBe(reactionCollapseId('msg-2', 'peer'));
  });

  it('iOS: the identifier hashes the reacted-to MESSAGE, never the conversation', () => {
    // It rides the content-free wake as an APNs header; a call ring names the group and the caller
    // in clear, so a hash over those and an instant could be confirmed by guessing (#3792 round 3).
    expect(reactionCollapseKey('msg-1', 'peer')).not.toContain('grp-1');
    expect(reactionCollapseId('msg-1', 'peer')).not.toBe(reactionCollapseId('grp-1', 'peer'));
  });

  it('Android: both triggers post the ONE composition, under the ONE key', () => {
    // So a frame and a push for one reaction land on one notification, never two.
    expect(kotlin).toContain(
      'internal fun reactionNotifKey(groupId: String): String = "reaction:$groupId"'
    );
    expect(reactionNotificationKey('grp-1')).toBe('reaction:grp-1');
    expect(kotlin).toMatch(
      /showReactionNotification\(groupId, actorId, data\["title"\] \?: getString\(R\.string\.app_name\), emoji, reactionAt\)/
    );
    expect(kotlin).toContain(
      'context.showReactionNotification(groupId, senderId, senderName, body, sentAt, suppressInForeground = false)'
    );
    // The composition files a reaction on its own channel, without the message actions.
    const composer = kotlin.slice(kotlin.indexOf('internal fun Context.showReactionNotification('));
    expect(composer.slice(0, composer.indexOf('\n        }\n'))).toMatch(
      /channel = CHANNEL_REACTIONS,\s*quickActions = false,\s*sentAt = reactionAt,\s*senderId = actorId,\s*suppressInForeground = suppressInForeground,/
    );
  });

  it("Android: both triggers stamp the line with the reaction's own instant, so the second adds none", () => {
    // `alreadyPosted` matches a line by its stamp and only when it is > 0: a reaction stamped 0 on
    // either path would add a second line and alert twice (review of #3792).
    expect(kotlin).toContain('val alreadyPosted = sentAt > 0 && style.messages.any {');
    expect(kotlin).toContain('it.timestamp == stamp && AlertedMessage.sameSender(');
    // The push: the `at` the server forwards from the reactor (`notify-reaction`).
    expect(kotlin).toContain('val reactionAt = data["at"]?.toLongOrNull() ?: 0L');
    // The frame: the `at` of its own `ReactionMsg`, handed down as `sentAt`.
    const native = readFileSync(resolve(here, '../nativeNotification.ts'), 'utf8');
    expect(native).toContain('sentAt: reaction.at,');
  });

  it('iOS drops a reaction push in the foreground, before it reaches the reaction branch', () => {
    expect(objc).toContain('([msgType isEqualToString:@"social"] && !isReaction)');
    const guard = objc.indexOf('if (canari_ios_is_in_foreground() && !showsWhileForeground) {');
    const branch = objc.indexOf('  if (isReaction) {');
    expect(guard).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(guard);
  });
});
