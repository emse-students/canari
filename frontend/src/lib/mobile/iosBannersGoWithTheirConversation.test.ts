/**
 * OPENING THE APP CLEARS NO CONVERSATION BANNER ON iOS EITHER (owner, 2026-11-21: "N'effacer que les
 * lues"). The native file cannot run here, so its shape is pinned from source: activation retires
 * only a call's ring alert and recomputes the badge, and a conversation's banners are taken down by
 * the class the page's hand-over reaches (`cancel_conversation_notifications`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const NATIVE = resolve(__dirname, '../../../src-tauri');
const push = readFileSync(resolve(NATIVE, 'gen/apple/Sources/canari/canari_push.mm'), 'utf8');
const rust = readFileSync(resolve(NATIVE, 'src/commands/notifications.rs'), 'utf8');
const lib = readFileSync(resolve(NATIVE, 'src/lib.rs'), 'utf8');

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} exists`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n}\n', start));
}

describe('iOS: a banner goes with its conversation, never with the app coming up', () => {
  const activation = bodyOf(push, 'void CanariPushCancelMessageNotifications(void) {');

  it('activation removes only a call ring alert, never a chat banner', () => {
    expect(activation).toContain('userInfo[@"canariCallId"] != nil');
    for (const chat of ['threadIdentifier', 'deepLink', 'canari_messages', 'hasPrefix']) {
      expect(activation).not.toContain(chat);
    }
    expect(activation).not.toContain('removeAllDeliveredNotifications');
  });

  it('activation recomputes the badge from what remains, never zeroing it', () => {
    expect(activation).toContain(
      'CanariSetBadgeCount(CanariCountUnreadConversations(notifications, [NSSet setWithArray:ids]))'
    );
    expect(activation).not.toContain('CanariSetBadgeCount(0)');
  });

  it('the class the page reaches takes the conversation down by thread', () => {
    const cls = bodyOf(push, '@implementation CanariConversationNotifications');
    expect(cls).toContain('CanariCancelConversationNotification(groupId, nil)');
    expect(push).toContain('+ (BOOL)cancelForConversation:(NSString *)groupId;');
  });

  it('the Tauri command reaches that class through the runtime and is registered', () => {
    expect(rust).toContain('pub(crate) fn cancel_conversation_notifications(');
    expect(rust).toContain('AnyClass::get(c"CanariConversationNotifications")');
    expect(rust).toContain('cancelForConversation: ns');
    expect(lib).toContain('cancel_conversation_notifications,');
  });
});
