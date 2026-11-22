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

  // Re-review of #3951: NO destructive control by ABSENCE. A reconcile against "the conversations the
  // page lists" ended live banners (a first DM from a new correspondent is listed only after the
  // catch-up, a failed restore reads as restored, a salon is listed once its community answers), so
  // none exists: a banner goes on positive evidence of an ending only.
  it('has no reconcile by absence on either OS, and retires the pending-sync notice on activation', () => {
    expect(push).not.toContain('reconcileWithActive');
    expect(push).not.toContain('flatCleared');
    expect(rust).not.toContain('reconcile_conversation_notifications');
    expect(lib).not.toContain('reconcile_conversation_notifications');
    expect(activation).toContain('kPendingSyncNotifId');
    expect(activation).toContain('[n.request.identifier isEqualToString:pendingSyncId]');
  });

  it('a conversation id is never allocated from the fixed notification ids', () => {
    const table = push.match(/kFixedNotifIds\[\] = \{([^}]*)\}/)?.[1] ?? '';
    const fixed = [...push.matchAll(/static const int (k\w+NotifId) = \d+;/g)].map((x) => x[1]);
    expect(fixed.length).toBeGreaterThan(1);
    for (const name of fixed) expect(table, `${name} is in the table`).toContain(name);
    expect(bodyOf(push, 'static int CanariStableNotifId(NSString *groupId) {')).toContain(
      'while (CanariIsFixedNotifId(next))'
    );
  });

  it('the Tauri command reaches that class through the runtime and is registered', () => {
    expect(rust).toContain('pub(crate) fn cancel_conversation_notifications(');
    expect(rust).toContain('AnyClass::get(c"CanariConversationNotifications")');
    expect(rust).toContain('cancelForConversation: ns');
    expect(lib).toContain('cancel_conversation_notifications,');
  });
});
