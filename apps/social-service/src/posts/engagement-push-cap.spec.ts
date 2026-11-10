/// <reference types="jest" />

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CAPPED_PUSH_TYPES, ENGAGEMENT_DAILY_PUSH_CAP } from './engagement-push-cap';

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
    '%s files under the category chat-delivery applies to its content key',
    (_type, { contentKey, category }) => {
      expect(categories.get(contentKey)).toBe(category);
    }
  );

  it('caps ONLY accounts the reader does not follow (decision 11, amended 2026-11-10), at 5 a day', () => {
    expect([...CAPPED_PUSH_TYPES.keys()]).toEqual(['campus_trend']);
    expect(ENGAGEMENT_DAILY_PUSH_CAP).toBe(5);
  });
});
