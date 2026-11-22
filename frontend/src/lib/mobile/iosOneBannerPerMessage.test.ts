/**
 * ONE NOTIFICATION PER MESSAGE ON AN IPHONE, WHICHEVER PROCESS DRAWS IT - the native invariants.
 *
 * The extension, the app's `willPresentNotification` and the page share one ledger
 * (`announced_messages.json`, Rust `mobile::announced`, whose transitions its own tests drive). The
 * Swift and Objective-C halves cannot run here and are compiled only by CI, so their shape is pinned
 * from source: the extension claims what it draws and stamps the outcome; the app settles the claim
 * of a push it does not present; the three halves read one key builder and one stamp vocabulary.
 * Read on the iPhone 12, `1.7.3-alpha.6` (docs/wiki/frontend/ios-notification-ownership.md).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const NATIVE = resolve(__dirname, '../../../src-tauri');
const read = (path: string) => readFileSync(resolve(NATIVE, path), 'utf8');
const nse = read('gen/apple/canari_NSE/NotificationService.swift');
const nseFfi = read('gen/apple/canari_NSE/canari_mls_ffi.h');
const push = read('gen/apple/Sources/canari/canari_push.mm');
const bridge = read('gen/apple/Sources/canari/canari_rust_bridge.h');
const ffi = read('src/mobile/ios_ffi.rs');
const commands = read('src/commands/notifications.rs');
const lib = read('src/lib.rs');

function bodyOf(source: string, signature: string, end = '\n  }\n'): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} exists`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf(end, start));
}

describe('iOS: one notification per message, whichever process draws it', () => {
  it('the extension claims every message it draws, MLS and salon, keyed by the message instant', () => {
    const mls = bodyOf(nse, 'private func handleMlsMessage(');
    expect(mls).toContain(
      'claimAnnouncement(conversation: groupId, at: $0.sentAt, content: content)'
    );
    const salon = bodyOf(nse, 'private func handleChannelMessage(');
    expect(salon).toContain('Int64(Self.string(userInfo["createdAt"]) ?? "")');
    expect(salon).toContain('claimAnnouncement(\n      conversation: "channel_\\(channelId)"');
  });

  it('the extension stamps its outcome where willPresent reads it, in one vocabulary', () => {
    const claim = bodyOf(nse, 'private func claimAnnouncement(');
    expect(claim).toContain('canari_announce_key(conversation, at)');
    expect(claim).toContain('canari_announced_by_extension(dir.path, key)');
    for (const stamp of ['"first"', '"after-page"']) {
      expect(claim).toContain(`content.userInfo["canariAnnounced"] = ${stamp}`);
      expect(push).toContain(`isEqualToString:@${stamp}`);
    }
    expect(claim).toContain('content.userInfo["canariAnnounceKey"] = key');
    expect(push).toContain('userInfo[@"canariAnnounceKey"]');
  });

  it("after the page, the extension's banner replaces the page's, quietly", () => {
    const mls = bodyOf(nse, 'private func handleMlsMessage(');
    expect(mls).toContain('LevelDecision(mentionsMe: false, quiet: true)');
    const badge = bodyOf(nse, 'private func applyBadgeCount(');
    expect(badge).toContain('Self.pageBannerCovers(n.request.content.userInfo, key: replaces)');
    expect(badge).toContain('center.removeDeliveredNotifications(withIdentifiers: replaced)');
    // The page's `extra` lands under the plugin's `__EXTRA__`, as space-separated keys.
    expect(nse).toContain('userInfo["__EXTRA__"] as? [String: Any]');
    expect(nse).toContain('announces.split(separator: " ")');
  });

  it("an active app settles the extension's claim of the push it is handed, before presenting", () => {
    const delegate = bodyOf(
      push,
      '       willPresentNotification:(UNNotification *)notification',
      '\n}\n'
    );
    const settle = delegate.indexOf(
      'CanariSettleAnnouncedInFront(request.content.userInfo, &announced)'
    );
    expect(settle).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(delegate.indexOf('CanariPresentForegroundPush(center'));
    const fn = bodyOf(push, 'static BOOL CanariSettleAnnouncedInFront(', '\n}\n');
    expect(fn).toContain('canari_announced_settle_in_front(dir.UTF8String, key.UTF8String)');
    // A ledger failure leaves the claim standing, so the push is presented - never a silent loss.
    expect(fn).toMatch(/default:[\s\S]*?\*options = shown;/);
    expect(fn).toMatch(/case 0:[\s\S]*?\*options = UNNotificationPresentationOptionNone;/);
  });

  it('one key builder and one ledger implementation, declared to both native halves', () => {
    for (const symbol of ['canari_announce_key', 'canari_announced_by_extension']) {
      expect(ffi).toContain(`pub unsafe extern "C" fn ${symbol}(`);
      expect(nseFfi).toContain(`${symbol}(`);
    }
    expect(ffi).toContain('pub unsafe extern "C" fn canari_announced_settle_in_front(');
    expect(bridge).toContain(
      'canari_announced_settle_in_front(const char *data_dir, const char *key)'
    );
    expect(commands).toContain(
      'crate::mobile::announced::page_claim_in(&dir, &conversation_id, &instants)'
    );
    expect(lib).toContain('claim_message_announcement,');
  });

  it('the removal by conversation is keyed on the thread the page now files under', () => {
    expect(bodyOf(push, 'static void CanariCancelConversationNotification(', '\n}\n')).toContain(
      '[n.request.content.threadIdentifier isEqualToString:groupId]'
    );
  });
});
