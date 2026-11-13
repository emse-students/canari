/// <reference types="jest" />

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Logger } from '@nestjs/common';
import {
  BELL_ROW_GATE,
  NOTIFICATION_TYPE_CATEGORY,
  OPT_IN_CATEGORIES,
  inAppCategoryOffSql,
  pushCategoryOffSql,
  suggestionsOn,
} from './notification-category';
import { NOTIFICATION_TYPE_MIN_CLIENT } from './notification-client-floor';
import { CAPPED_PUSH_TYPES } from '../posts/engagement-push-cap';

/**
 * The switches exist twice - chat-delivery decides the push, social-service the bell row and every
 * suggestion surface - and nothing compiles across that boundary. This reads chat-delivery's file.
 */
const SOURCE = readFileSync(
  resolve(__dirname, '../../../chat-delivery-service/src/services/push-category.ts'),
  'utf8'
);
const CHAT_CATEGORY_OF_KEY = (() => {
  const map = SOURCE.match(/CATEGORY_BY_CONTENT_KEY[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!map) throw new Error('CATEGORY_BY_CONTENT_KEY not found in push-category.ts');
  return new Map(
    [...map[1].matchAll(/^\s*([a-z_]+):\s*'([a-z_]+)'/gm)].map((m) => [m[1], m[2]] as const)
  );
})();
const CHAT_CATEGORIES = (() => {
  const block = /NOTIFICATION_CATEGORIES = \[([\s\S]*?)\] as const/.exec(SOURCE)?.[1] ?? '';
  return new Set([...block.matchAll(/^\s*'([a-z_]+)',/gm)].map((m) => m[1]));
})();

describe('notification categories, as social-service reads them', () => {
  it("names chat-delivery's opt-in categories - the push of Suggestions, off until turned on", () => {
    const block = /OPT_IN_CATEGORIES: readonly NotificationCategory\[\] = \[([^\]]*)\]/.exec(
      SOURCE
    )?.[1];
    expect(block).toBeDefined();
    expect([...OPT_IN_CATEGORIES]).toEqual(
      [...(block ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    );
  });

  it('places every bell type, and files each under a category chat-delivery knows', () => {
    expect(Object.keys(NOTIFICATION_TYPE_CATEGORY).sort()).toEqual(
      Object.keys(NOTIFICATION_TYPE_MIN_CLIENT).sort()
    );
    const filed = Object.values(NOTIFICATION_TYPE_CATEGORY).filter((c) => c !== null);
    expect(filed.filter((c) => !CHAT_CATEGORIES.has(c))).toEqual([]);
  });

  it.each(Object.entries(NOTIFICATION_TYPE_CATEGORY))(
    '%s files its bell row where chat-delivery files its push',
    (type, category) => {
      const key = [`social_${type}`, type].find((k) => CHAT_CATEGORY_OF_KEY.has(k));
      // The legacy form reminder is filed by its `type` field (`categoryOfDataPush`), not a key.
      const filed = type === 'form_reminder' ? 'forms' : key ? CHAT_CATEGORY_OF_KEY.get(key) : null;
      expect([type, category]).toEqual([type, filed]);
    }
  );

  it('agrees with the daily cap on every counted type', () => {
    for (const [type, { category }] of CAPPED_PUSH_TYPES) {
      expect([
        type,
        NOTIFICATION_TYPE_CATEGORY[type as keyof typeof NOTIFICATION_TYPE_CATEGORY],
      ]).toEqual([type, category]);
    }
  });

  it('reads the app switch from the disabled set, and the push of an opt-in one from both sets', () => {
    const inApp = inAppCategoryOffSql('u', `'suggestions'`);
    expect(inApp).toContain('"disabledCategories" ?');
    expect(inApp).not.toContain('"enabledCategories"');
    const push = pushCategoryOffSql('u', `'suggestions'`);
    expect(push).toContain(`IN ('suggestions')`);
    expect(push).toContain('"enabledCategories" ?');
    expect(push).toContain('"disabledCategories" ?');
  });

  it('classifies EVERY bell type for the bell gate - a new type fails here until it is placed', () => {
    expect(Object.keys(BELL_ROW_GATE).sort()).toEqual(
      Object.keys(NOTIFICATION_TYPE_MIN_CLIENT).sort()
    );
  });

  it('withholds in the bell ONLY suggestion and engagement content (review of #3329, P2)', () => {
    const gated = Object.entries(BELL_ROW_GATE)
      .filter(([, category]) => category !== null)
      .map(([type]) => type)
      .sort();
    expect(gated).toEqual(['birthday', 'campus_trend', 'friend_comment', 'friend_reaction']);
    // Each gated type is gated by the very category its push files under.
    for (const type of gated) {
      expect([type, BELL_ROW_GATE[type as keyof typeof BELL_ROW_GATE]]).toEqual([
        type,
        NOTIFICATION_TYPE_CATEGORY[type as keyof typeof NOTIFICATION_TYPE_CATEGORY],
      ]);
    }
  });

  it.each([
    'form_paid_over_capacity',
    'lydia_payments_paused',
    'delegation_receiver_not_ready',
    'repost_personal_requested',
    'repost_proposed',
    'event_pending',
    'event_validated',
    'event_rejected',
    'repost_personal_accepted',
    'repost_personal_refused',
  ] as const)(
    'always writes %s: it asks the reader to act, or answers their own request',
    (type) => {
      expect(BELL_ROW_GATE[type]).toBeNull();
    }
  );

  it('a failed read of the switch serves no suggestion, and says so', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const manager = { query: jest.fn().mockRejectedValue(new Error('down')) };
    expect(await suggestionsOn(manager, 'u'.repeat(64))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no suggestion served'));
    warn.mockRestore();
  });
});
