import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  inboundReactionVerdict,
  isLiveDelivery,
  reactionNotificationKey,
  reactionTriggerRefusal,
  type InboundReaction,
  type ReactionTriggerFacts,
} from './reactionNotification';

/**
 * THE FRAME TRIGGER OF A REACTION TO MY MESSAGE (owner, 2026-11-17).
 *
 * A reaction push is dropped whenever the app is in the foreground, on Android and on iOS, even when
 * its conversation is not on screen - and a reaction had no second trigger, so it notified nobody.
 * This file pins the second trigger's decision AND the property that makes it safe to add: it can
 * never draw a reaction the push draws, because the two read one foreground fact in opposite senses.
 */

const ME = 'me-user-id';
const PEER = 'peer-user-id';

const FRESH: InboundReaction = {
  conversationKey: 'grp-1',
  messageId: 'msg-1',
  reactorId: PEER,
  emoji: '❤️',
  removed: false,
  changed: true,
  messageAuthorId: ME,
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
    ['a reaction to a message this device holds no copy of', { messageAuthorId: null }],
  ] as const)('is not about me: %s', (_, change) => {
    expect(inboundReactionVerdict({ ...FRESH, ...change }, ME).kind).toBe('not-mine');
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
    appInForeground: true,
    conversationOnScreen: false,
    reactionsAllowed: true,
    level: 'all',
  };

  it('raises it while the app is in front with that conversation off screen', () => {
    expect(reactionTriggerRefusal(OPEN)).toBeNull();
    // A salon carries no level, exactly as the server applies none to a salon reaction.
    expect(reactionTriggerRefusal({ ...OPEN, level: undefined })).toBeNull();
  });

  it('NEVER RAISES IT WHILE THE APP IS NOT IN THE FOREGROUND - whatever else is true', () => {
    // The push draws a reaction exactly then; every cell of the rest of the matrix is walked so no
    // later term can reopen the overlap.
    for (const conversationOnScreen of [false, true]) {
      for (const reactionsAllowed of [false, true]) {
        for (const level of ['all', 'mentions', 'none', undefined] as const) {
          expect(
            reactionTriggerRefusal({
              appInForeground: false,
              conversationOnScreen,
              reactionsAllowed,
              level,
            })
          ).toBe('the app is not in the foreground - the push draws it');
        }
      }
    }
  });

  it('stays quiet when the conversation is on screen - the bubble carries it', () => {
    expect(reactionTriggerRefusal({ ...OPEN, conversationOnScreen: true })).toMatch(/on screen/);
  });

  it("obeys the account's reactions switch and the conversation's level, as the server does", () => {
    expect(reactionTriggerRefusal({ ...OPEN, reactionsAllowed: false })).toMatch(/reactions/);
    // A reaction is never a mention: `mentions` refuses it as `none` does (server: level !== 'all').
    expect(reactionTriggerRefusal({ ...OPEN, level: 'mentions' })).toMatch(/mentions/);
    expect(reactionTriggerRefusal({ ...OPEN, level: 'none' })).toMatch(/none/);
  });
});

/**
 * THE OTHER HALF OF THE PROOF: the push is drawn only while the app is NOT in the foreground. Read
 * from the native sources, because nothing else spans the two languages - if either push handler
 * ever drew a reaction in the foreground, this trigger would double it.
 */
describe('the push half is the exact complement', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '../../../../src-tauri');
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
  const kotlin = read(
    'gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
  );
  const mainActivity = read('gen/android/app/src/main/java/fr/emse/canari/MainActivity.kt');
  const objc = read('gen/apple/Sources/canari/canari_push.mm');

  it('Android drops a reaction push in the foreground, before it reaches the reaction builder', () => {
    expect(kotlin).toMatch(/val isReaction = msgType == "social" && data\["reaction"\] == "true"/);
    // The `social` exemption does not cover a reaction...
    expect(kotlin).toContain('(msgType == "social" && !isReaction)');
    // ...so the foreground guard returns before the reaction branch is reached.
    const guard = kotlin.indexOf('if (MainActivity.isInForeground && !showsWhileForeground)');
    const branch = kotlin.indexOf(
      'runWithWakeLock("fcm_reaction") { handleReactionNotification(data) }'
    );
    expect(guard).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(guard);
  });

  it('Android: the flag the WebView reads is the one that guard reads', () => {
    // `isAppInForeground` reads `window.__canariForeground`, which the activity writes from the same
    // `isInForeground` (`appForeground.contract.test.ts` holds the transitions).
    expect(mainActivity).toContain('isInForeground');
    expect(mainActivity).toContain('__canariForeground');
  });

  it('Android: both triggers post the ONE composition, under the ONE key', () => {
    // So a frame and a push for one reaction - should a transition fall between the two reads -
    // land on one notification, replaced by id, never two.
    expect(kotlin).toContain(
      'internal fun reactionNotifKey(groupId: String): String = "reaction:$groupId"'
    );
    expect(reactionNotificationKey('grp-1')).toBe('reaction:grp-1');
    expect(kotlin).toMatch(
      /showReactionNotification\(groupId, actorId, data\["title"\] \?: getString\(R\.string\.app_name\), emoji\)/
    );
    expect(kotlin).toContain(
      'context.showReactionNotification(groupId, senderId, senderName, body, suppressInForeground = false)'
    );
    // The composition files a reaction on its own channel, without the message actions.
    const composer = kotlin.slice(kotlin.indexOf('internal fun Context.showReactionNotification('));
    expect(composer.slice(0, composer.indexOf('\n        }\n'))).toMatch(
      /channel = CHANNEL_REACTIONS,\s*quickActions = false,\s*suppressInForeground = suppressInForeground,/
    );
  });

  it('iOS drops a reaction push in the foreground, before it reaches the reaction branch', () => {
    expect(objc).toContain('([msgType isEqualToString:@"social"] && !isReaction)');
    const guard = objc.indexOf('if (canari_ios_is_in_foreground() && !showsWhileForeground) {');
    const branch = objc.indexOf('  if (isReaction) {');
    expect(guard).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(guard);
  });
});
