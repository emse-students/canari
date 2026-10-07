import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_CATEGORIES,
  categoryOfConversation,
  isNotificationCategory,
} from './categories';

/**
 * The category ids exist twice - the server decides before it sends, the client draws the switches
 * and gates its own local notifications - and nothing compiles across that boundary. This reads the
 * server file, so adding a category on one side only fails here instead of drawing a switch the
 * server ignores (or a server category the user can never turn off).
 */
const SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/chat-delivery-service/src/services/push-category.ts'
);

function serverIds(): string[] {
  const src = readFileSync(SERVER, 'utf8');
  const block = /NOTIFICATION_CATEGORIES = \[([\s\S]*?)\] as const/.exec(src)?.[1] ?? '';
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('notification categories', () => {
  it('lists exactly the ids the server filters on', () => {
    expect([...NOTIFICATION_CATEGORIES].sort()).toEqual(serverIds().sort());
  });

  it('knows only its own ids', () => {
    expect(isNotificationCategory('posts')).toBe(true);
    expect(isNotificationCategory('calls')).toBe(false);
  });

  it('files a salon under channels and every other conversation under messages', () => {
    expect(categoryOfConversation('channel_3f2a')).toBe('channels');
    expect(categoryOfConversation('2c9e-group-id')).toBe('messages');
  });
});
