/// <reference types="jest" />

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  NOTIFICATION_TYPE_MIN_CLIENT,
  PUSH_KEY_MIN_CLIENT,
  PUSH_ONLY_NOTIFICATION_TYPES,
} from '../push/notification-client-floor';
import { CAPPED_PUSH_TYPES, ENGAGEMENT_DAILY_PUSH_CAP, PUSH_BUDGET } from './engagement-push-cap';

/**
 * THE CAPPED TYPES AND THEIR CATEGORY (engagement WP-8, decisions 6 and 11 as amended 2026-11-10). The cap reads a
 * category before it counts, and chat-delivery files the push under a category at the send: two
 * services, one fact, and nothing compiles across the boundary - so this reads chat-delivery's map
 * and pins every capped type's category against it, through its content key.
 */
describe('CAPPED_PUSH_TYPES', () => {
  const categories = (() => {
    const source = readFileSync(
      resolve(__dirname, '../../../chat-delivery-service/src/services/push-category.ts'),
      'utf8'
    );
    const map = source.match(/CATEGORY_BY_CONTENT_KEY[^=]*=\s*\{([\s\S]*?)\n\};/);
    if (!map) throw new Error('CATEGORY_BY_CONTENT_KEY not found in push-category.ts');
    return new Map(
      [...map[1].matchAll(/^\s*([a-z_]+):\s*'([a-z_]+)'/gm)].map((m) => [m[1], m[2]] as const)
    );
  })();

  it('reads chat-delivery map at all', () => {
    expect(categories.get('social_comment')).toBe('comments');
  });

  it.each([...CAPPED_PUSH_TYPES])(
    '%s files under the category chat-delivery applies to each of its content keys',
    (_type, { contentKeys, category }) => {
      expect(contentKeys.length).toBeGreaterThan(0);
      for (const key of contentKeys) expect([key, categories.get(key)]).toEqual([key, category]);
    }
  );

  it('files a campus trend under its own switch, suggestions (owner, 2026-11-10)', () => {
    expect(CAPPED_PUSH_TYPES.get('campus_trend')?.category).toBe('suggestions');
  });

  it('counts the owner list of 2026-11-10, at 3 a day', () => {
    expect([...CAPPED_PUSH_TYPES.keys()].sort()).toEqual([
      'booking_open',
      'campus_trend',
      'comment',
      'event_open',
      'followed_post',
      'friend_comment',
      'friend_reaction',
      'member_repost',
      'reaction',
    ]);
    expect(ENGAGEMENT_DAILY_PUSH_CAP).toBe(3);
  });

  it.each([
    'birthday',
    'association_post',
    'association_repost',
    'mention',
    'reply',
    'live_mention',
    'follow_request',
    'follow_accepted',
    'booking_reminder',
    'booking_changed',
    'event_pending',
    'live_cut',
  ])('never counts %s (owner, 2026-11-10)', (type) => {
    expect(CAPPED_PUSH_TYPES.has(type)).toBe(false);
  });
});

/**
 * EVERY NOTIFICATION TYPE IS CLASSIFIED (owner, 2026-11-10): the `Record` type already refuses a
 * missing one at compile time; this says the same at run time, against the two lists of types -
 * the bell's (`NOTIFICATION_TYPE_MIN_CLIENT`) and the push-only ones - so neither can grow a type
 * the budget has not placed, and the budget cannot keep one they dropped.
 */
describe('PUSH_BUDGET', () => {
  it('classifies exactly every bell type and every push-only type', () => {
    const types = [
      ...Object.keys(NOTIFICATION_TYPE_MIN_CLIENT),
      ...PUSH_ONLY_NOTIFICATION_TYPES,
    ].sort();
    expect(Object.keys(PUSH_BUDGET).sort()).toEqual(types);
  });

  it('gives every counted type ONE floor, shared by all its keys, which the claim applies', () => {
    const split = [...CAPPED_PUSH_TYPES].filter(
      ([, { contentKeys, floor }]) =>
        !contentKeys.every((key) => (PUSH_KEY_MIN_CLIENT[key] ?? null) === floor)
    );
    expect(split).toEqual([]);
    expect(CAPPED_PUSH_TYPES.get('campus_trend')?.floor).toBe('1.6.10');
    expect(CAPPED_PUSH_TYPES.get('reaction')?.floor).toBeNull();
  });

  it('names at least one content key for every counted type', () => {
    const empty = Object.entries(PUSH_BUDGET).filter(
      ([, budget]) => budget.counted && budget.contentKeys.length === 0
    );
    expect(empty).toEqual([]);
  });
});
