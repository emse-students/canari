/**
 * ONE notification-center delegate on iOS, and a tap that reaches the page from a killed app.
 *
 * `tauri-plugin-notification`'s `NotificationManager.init()` sets itself as the
 * `UNUserNotificationCenter` delegate when Tauri registers the plugin - after `CanariPushSetup` -
 * and its `didReceive` drops every remote push. A tap from a backgrounded app resumed the previous
 * page, from a killed one opened the feed (iPhone 12, 1.5.4-alpha.1). Objective-C++ compiles only on
 * the macOS runner, so the contract is pinned on the source (as `iosTapTarget.test.ts` does).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_NOTIFICATION_TAP_EVENT,
  TAKE_NOTIFICATION_TAP_COMMAND,
} from './notificationTapDrain';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(here, '../../../src-tauri');
const push = readFileSync(resolve(SRC_TAURI, 'gen/apple/Sources/canari/canari_push.mm'), 'utf8');
const pushRs = readFileSync(resolve(SRC_TAURI, 'src/commands/push.rs'), 'utf8');
const libRs = readFileSync(resolve(SRC_TAURI, 'src/lib.rs'), 'utf8');
const hooks = readFileSync(resolve(here, '../../hooks.client.ts'), 'utf8');

/** The body of a C function or ObjC method starting at `signature`, up to its closing brace. */
function body(signature: string): string {
  const start = push.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  return push.slice(start, push.indexOf('\n}\n', start));
}

const setup = () => body('void CanariPushSetup(void) {');
const didReceive = () => body('didReceiveNotificationResponse:(UNNotificationResponse *)response');
const willPresent = () => body('willPresentNotification:(UNNotification *)notification');

describe('the delegate slot is guarded, not won by order', () => {
  it('installs the guard before Canari sets its delegate, and sets it once', () => {
    const s = setup();
    const guard = s.indexOf('CanariGuardNotificationCenterDelegate();');
    const set = s.indexOf(
      '[UNUserNotificationCenter currentNotificationCenter].delegate = g_notifDelegate;'
    );
    expect(guard).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(guard);
    expect(push.match(/currentNotificationCenter\]\.delegate = /g)).toHaveLength(1);
  });

  it("replaces -[UNUserNotificationCenter setDelegate:] and passes Canari's delegate alone", () => {
    const g = body('static BOOL CanariGuardNotificationCenterDelegate(void) {');
    expect(g).toContain('[UNUserNotificationCenter class]');
    expect(g).toContain('@selector(setDelegate:)');
    expect(g).toContain('class_replaceMethod(cls, sel, (IMP)CanariGuardedSetNotifCenterDelegate');
    const setter = body(
      'static void CanariGuardedSetNotifCenterDelegate(id self, SEL _cmd, id delegate) {'
    );
    expect(setter).toContain('delegate == (id)g_notifDelegate');
    // The original setter is reached exactly once, on Canari's own delegate.
    expect(setter.match(/CanariOrigSetNotifCenterDelegate\(/g)).toHaveLength(1);
    expect(setter).toContain('g_refusedNotifDelegate = delegate;');
  });

  it('accuses a slot Canari does not hold at launch and at every activation, never by a timer', () => {
    const s = setup();
    expect(s).toContain('CanariCheckNotificationDelegate(@"launch");');
    expect(s).toContain('CanariCheckNotificationDelegate(@"activation");');
    expect(body('static void CanariCheckNotificationDelegate(NSString *moment) {')).toContain(
      'ERROR'
    );
    // Called from those two observers and nowhere else - no poll.
    expect(push.match(/CanariCheckNotificationDelegate\(@"/g)).toHaveLength(2);
  });
});

describe('who posted a notification decides who answers it', () => {
  const poster = () => body('static CanariNotificationPoster CanariNotificationPosterOf(');

  it('classifies a remote push first, then the share banner, then the plugin by its identifier', () => {
    const p = poster();
    const pushAt = p.indexOf('UNPushNotificationTrigger');
    const shareAt = p.indexOf('CanariIsShareNotification');
    const pluginAt = p.indexOf('CanariIsPluginNotificationIdentifier');
    expect(pushAt).toBeGreaterThan(-1);
    expect(shareAt).toBeGreaterThan(pushAt);
    expect(pluginAt).toBeGreaterThan(shareAt);
  });

  it("never gives a Canari-posted local notification the plugin's decimal identifier", () => {
    // The plugin writes `"\(notification.id)"`; Canari writes `canari-<n>` or a UUID.
    expect(push).toContain('@"^-?[0-9]{1,10}$"');
    expect(push).toContain('[NSString stringWithFormat:@"canari-%d", notifId]');
    const re = /^-?[0-9]{1,10}$/;
    expect(re.test('123456')).toBe(true);
    expect(re.test('-42')).toBe(true);
    for (const own of ['canari-12', '3F2B8C1E-9A4D-4E7F-B6C2-0D1E2F3A4B5C', 'canari.share.ready']) {
      expect(re.test(own), own).toBe(false);
    }
  });

  it("forwards the plugin's own notifications to the refused plugin delegate, both callbacks", () => {
    for (const m of [willPresent(), didReceive()]) {
      expect(m).toContain('== CanariNotificationPosterPlugin');
      expect(m).toContain('g_refusedNotifDelegate');
      expect(m).toContain('respondsToSelector:_cmd');
    }
  });

  it("never hands the plugin a tap on an earlier process's notification, which it would force-unwrap", () => {
    const r = didReceive();
    const guard = r.indexOf('[response.notification.date compare:g_processStartedAt]');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(r.indexOf('didReceiveNotificationResponse:response'));
    // Taken first thing in setup, from main(), before any plugin can post.
    expect(setup().indexOf('g_processStartedAt = [NSDate date];')).toBeLessThan(
      setup().indexOf('CanariGuardNotificationCenterDelegate();')
    );
    expect(setup().indexOf('g_processStartedAt = [NSDate date];')).toBeGreaterThan(-1);
  });
});

describe('a tap reaches the page through durable state', () => {
  it('queues the link for the page and opens no URL', () => {
    const r = didReceive();
    expect(r).toContain('CanariQueueNotificationTap(deepLink);');
    expect(r).not.toContain('openURL:');
  });

  it('does not re-handle the payload as an arrival', () => {
    expect(didReceive()).not.toContain('CanariPushProcessRemoteNotificationUserInfo(');
    // The foreground arrival still is handled.
    expect(willPresent()).toContain('CanariPushProcessRemoteNotificationUserInfo(');
  });

  it('writes the file before it tells the page', () => {
    const q = body('static void CanariQueueNotificationTap(NSString *deepLink) {');
    expect(q.indexOf('writeToFile:path')).toBeGreaterThan(-1);
    expect(q.indexOf('CanariTellPageOfNotificationTap();')).toBeGreaterThan(
      q.indexOf('writeToFile:path')
    );
  });

  it('names the same file, event and command on every side', () => {
    expect(push).toContain('@"pending_notification_tap.json"');
    expect(pushRs).toContain('"pending_notification_tap.json"');
    expect(push).toContain(`new CustomEvent('${NATIVE_NOTIFICATION_TAP_EVENT}')`);
    expect(pushRs).toContain(`pub(crate) fn ${TAKE_NOTIFICATION_TAP_COMMAND}(`);
    // Registered with the invoke handler, not only imported.
    expect(libRs.match(new RegExp(`\\b${TAKE_NOTIFICATION_TAP_COMMAND}\\b`, 'g'))).toHaveLength(2);
  });

  it('is taken by the page on iOS and routed like any link', () => {
    expect(hooks).toContain('listenForNativeNotificationTaps((link) => processUrls([link]))');
  });
});
