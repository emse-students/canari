/// <reference types="jest" />

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Logger } from '@nestjs/common';
import {
  NOTIFICATION_TYPE_CATEGORY,
  OPT_IN_CATEGORIES,
  categoryOffSql,
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
  it("names chat-delivery's opt-in categories - Suggestions, off until turned on", () => {
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

  it('reads an opt-in category from the enabled set, every other from the disabled one', () => {
    const sql = categoryOffSql('u', `'suggestions'`);
    expect(sql).toContain(`IN ('suggestions')`);
    expect(sql).toContain('"enabledCategories" ?');
    expect(sql).toContain('"disabledCategories" ?');
  });

  it('a failed read of the switch serves no suggestion, and says so', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const manager = { query: jest.fn().mockRejectedValue(new Error('down')) };
    expect(await suggestionsOn(manager, 'u'.repeat(64))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no suggestion served'));
    warn.mockRestore();
  });
});
