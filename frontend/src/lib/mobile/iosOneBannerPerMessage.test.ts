/**
 * ONE NOTIFICATION PER MESSAGE ON AN IPHONE, WHICHEVER PROCESS DRAWS IT - the native invariants.
 *
 * The extension, the app's `willPresentNotification` and the page share one ledger
 * (`announced_messages.json`, sealed, Rust `mobile::announced`, whose transitions its own tests
 * drive). The Swift and Objective-C halves cannot run here and are compiled only by CI, so their
 * shape is pinned from source: the extension claims what it draws in the step that hands its
 * content over, and stamps the outcome; the app settles the claim of a push it does not present;
 * the three halves read one key builder and one stamp vocabulary. Read on the iPhone 12,
 * `1.7.3-alpha.6` (docs/wiki/frontend/ios-notification-ownership.md).
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
const announcedRs = read('src/mobile/announced.rs');
const commands = read('src/commands/notifications.rs');
const lib = read('src/lib.rs');

function bodyOf(source: string, signature: string, end = '\n  }\n'): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} exists`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf(end, start));
}

describe('iOS: one notification per message, whichever process draws it', () => {
  it('the extension notes every message it draws, MLS and salon, keyed by sender and instant', () => {
    const mls = bodyOf(nse, 'private func handleMlsMessage(');
    expect(mls).toContain(
      'noteAnnouncement(conversation: groupId, senderId: senderId, at: msg.sentAt)'
    );
    const salon = bodyOf(nse, 'private func handleChannelMessage(');
    expect(salon).toContain('Int64(Self.string(userInfo["createdAt"]) ?? "")');
    expect(salon).toContain(
      'noteAnnouncement(conversation: "channel_\\(channelId)", senderId: senderId, at: createdAt)'
    );
    expect(bodyOf(nse, 'private func noteAnnouncement(')).toContain(
      'canari_announce_key(conversation, senderId, at)'
    );
  });

  it('the claim is made ONLY in finish, under deliveryLock, once the handler is taken', () => {
    // Review of #3968, B1: a claim made during the decrypt could be followed by the expiry's
    // UNSTAMPED delivery - the ledger saying "the extension's", the app reading no stamp, the page
    // standing down, an active app answering None: the message seen nowhere.
    const calls = nse.match(/[^\n]*claimAnnouncement\(key:/g) ?? [];
    expect(calls).toHaveLength(1);
    const finish = bodyOf(nse, 'private func finish() {');
    const lock = finish.indexOf('deliveryLock.lock()');
    const taken = finish.indexOf('contentHandler = nil');
    const guarded = finish.indexOf('if handler != nil, let content = bestAttemptContent {');
    const claim = finish.indexOf('claimAnnouncement(key: key, dir: dir, cacheKey: cacheKey');
    const unlock = finish.indexOf('deliveryLock.unlock()');
    const handoff = finish.indexOf('handler(content)');
    expect(lock).toBeGreaterThan(-1);
    expect(taken).toBeGreaterThan(lock);
    expect(guarded).toBeGreaterThan(taken);
    expect(claim).toBeGreaterThan(guarded);
    expect(unlock).toBeGreaterThan(claim);
    expect(handoff).toBeGreaterThan(unlock);
    // Nothing slow inside the lock but the claim: the Keychain and the container are read before.
    expect(finish.indexOf('Self.retrieveNativeCacheKey()')).toBeLessThan(lock);
    expect(finish.indexOf('Self.appGroupDir()')).toBeLessThan(lock);
    // And the expiry never claims: it delivers what it has, unstamped.
    expect(bodyOf(nse, 'override func serviceExtensionTimeWillExpire()')).not.toContain(
      'claimAnnouncement'
    );
  });

  it('the extension stamps its outcome where willPresent reads it, in one vocabulary', () => {
    const claim = bodyOf(nse, 'private func claimAnnouncement(');
    expect(claim).toContain('canari_announced_by_extension(dir.path, cacheKey, key)');
    for (const stamp of ['"first"', '"after-page"']) {
      expect(claim).toContain(`content.userInfo["canariAnnounced"] = ${stamp}`);
      expect(push).toContain(`isEqualToString:@${stamp}`);
    }
    expect(claim).toContain('content.userInfo["canariAnnounceKey"] = key');
    expect(push).toContain('userInfo[@"canariAnnounceKey"]');
  });

  it("after the page, the extension's banner is quiet and replaces only a page banner of that one message", () => {
    const claim = bodyOf(nse, 'private func claimAnnouncement(');
    expect(claim).toMatch(/case 0:[\s\S]*?content\.sound = nil[\s\S]*?\.passive/);
    const badge = bodyOf(nse, 'private func applyBadgeCount(');
    expect(badge).toContain(
      'Self.pageBannerStandsOnlyFor(n.request.content.userInfo, key: announced)'
    );
    // Review of #3968, S1: a page banner standing for several messages is never removed - the
    // others would leave Notification Center with it. At worst a double, never a loss.
    const exact = bodyOf(nse, 'static func pageBannerStandsOnlyFor(');
    expect(exact).toContain('userInfo["__EXTRA__"] as? [String: Any]');
    expect(exact).toContain('announces.split(separator: " ").map(String.init) == [key]');
    // Removed AFTER the handoff, so nothing slow sits between the claim and the delivery.
    const finish = bodyOf(nse, 'private func finish() {');
    expect(
      finish.indexOf('removeDeliveredNotifications(withIdentifiers: pageTwinIds)')
    ).toBeGreaterThan(finish.indexOf('handler(content)'));
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
    expect(fn).toContain('CanariRetrieveNativeCacheKey().UTF8String');
    // A ledger failure leaves the claim standing, so the push is presented - never a silent loss.
    expect(fn).toMatch(/default:[\s\S]*?\*options = shown;/);
    // A key the bound dropped (review of #3968, S3) is presented, never answered None.
    expect(fn).toMatch(/case 3:[\s\S]*?\*options = shown;/);
    expect(fn).toMatch(/case 0:[\s\S]*?\*options = UNNotificationPresentationOptionNone;/);
  });

  it('the ledger is sealed, and every locked edit holds background time', () => {
    const writer = bodyOf(announcedRs, 'pub fn with_ledger<R>(', '\n}\n');
    // Review of #3968, B2: an app suspended holding a shared-container lock is killed (0xdead10cc).
    expect(writer).toContain(
      'let _background = crate::app_group::BackgroundTime::begin(c"canari-announced-ledger");'
    );
    expect(writer.indexOf('BackgroundTime::begin')).toBeLessThan(writer.indexOf('lock_exclusive'));
    // Review of #3968, S4: sealed through native_cache, and re-excluded after its atomic write.
    expect(writer).toContain('seal_file(key, Purpose::AnnouncedLedger, &plain)');
    expect(writer).toMatch(
      /fs::rename\(&tmp, &path\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*exclude_from_backup\(&path\);/
    );
    expect(announcedRs).not.toMatch(/serde_json::from_slice\(&bytes\)/);
  });

  it('one key builder and one ledger implementation, declared to the halves that call them', () => {
    for (const symbol of ['canari_announce_key', 'canari_announced_by_extension']) {
      expect(ffi).toContain(`pub unsafe extern "C" fn ${symbol}(`);
      expect(nseFfi).toContain(`${symbol}(`);
    }
    expect(nseFfi).toContain(
      'char *canari_announce_key(const char *conversation, const char *sender, long long at);'
    );
    expect(ffi).toContain('pub unsafe extern "C" fn canari_announced_settle_in_front(');
    expect(bridge).toContain('int32_t canari_announced_settle_in_front(const char *data_dir,');
    // The app's Objective-C builds no key (review of #3968, S5): nothing declared it does not call.
    expect(bridge).not.toContain('canari_announce_key');
    expect(commands).toContain(
      'crate::mobile::announced::page_claim_in(&dir, &key, &conversation_id, &messages)'
    );
    expect(commands).toContain('crate::native_cache::app_cache_key(&app)?');
    expect(lib).toContain('claim_message_announcement,');
  });

  it('the removal by conversation is keyed on the thread the page now files under', () => {
    expect(bodyOf(push, 'static void CanariCancelConversationNotification(', '\n}\n')).toContain(
      '[n.request.content.threadIdentifier isEqualToString:groupId]'
    );
  });
});
