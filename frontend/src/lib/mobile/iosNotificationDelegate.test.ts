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
import {
  NATIVE_QUICK_REPLY_EVENT,
  RETURN_QUICK_REPLIES_COMMAND,
  TAKE_QUICK_REPLIES_COMMAND,
} from './quickReplyDrain';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(here, '../../../src-tauri');
const push = readFileSync(resolve(SRC_TAURI, 'gen/apple/Sources/canari/canari_push.mm'), 'utf8');
const bridge = readFileSync(
  resolve(SRC_TAURI, 'gen/apple/Sources/canari/canari_rust_bridge.h'),
  'utf8'
);
const pushRs = readFileSync(resolve(SRC_TAURI, 'src/commands/push.rs'), 'utf8');
const ffiRs = readFileSync(resolve(SRC_TAURI, 'src/mobile/ios_ffi.rs'), 'utf8');
const libRs = readFileSync(resolve(SRC_TAURI, 'src/lib.rs'), 'utf8');
const hooks = readFileSync(resolve(here, '../../hooks.client.ts'), 'utf8');
const layout = readFileSync(resolve(here, '../../routes/+layout.svelte'), 'utf8');

/** The body of a C function or ObjC method starting at `signature`, up to its closing brace. */
function body(signature: string): string {
  const start = push.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  return push.slice(start, push.indexOf('\n}\n', start));
}

const setup = () => body('void CanariPushSetup(void) {');
const didReceive = () => body('didReceiveNotificationResponse:(UNNotificationResponse *)response');
const willPresent = () => body('willPresentNotification:(UNNotification *)notification');

describe('the delegate slot is taken back with public API', () => {
  it('replaces no setter: the only method replaced is the add recorder', () => {
    expect(push).not.toContain('@selector(setDelegate:)');
    const replaced = push.match(/class_replaceMethod\(\s*cls,\s*sel,\s*\(IMP\)(\w+)/g) ?? [];
    expect(replaced).toEqual([
      'class_replaceMethod(cls, sel, (IMP)CanariRecordingAddNotificationRequest',
    ]);
  });

  it('takes the slot back at DidFinishLaunching, after every plugin registered', () => {
    const s = setup();
    const observer = s.indexOf('UIApplicationDidFinishLaunchingNotification');
    expect(s.indexOf('CanariTakeNotificationDelegate();')).toBeGreaterThan(observer);
    const take = body('static void CanariTakeNotificationDelegate(void) {');
    // The holder is kept as the forward target BEFORE Canari's delegate replaces it.
    expect(take.indexOf('g_forwardNotifDelegate = holder;')).toBeGreaterThan(-1);
    expect(take.indexOf('center.delegate = g_notifDelegate;')).toBeGreaterThan(
      take.indexOf('g_forwardNotifDelegate = holder;')
    );
  });

  it('accuses a later writer at activation only, never by a timer', () => {
    expect(setup()).toContain('CanariCheckNotificationDelegate(@"activation");');
    expect(push.match(/CanariCheckNotificationDelegate\(@"/g)).toHaveLength(1);
    expect(body('static void CanariCheckNotificationDelegate(NSString *moment) {')).toContain(
      'ERROR'
    );
  });
});

describe('who posted a notification decides who answers it', () => {
  const poster = () => body('static CanariNotificationPoster CanariNotificationPosterOf(');

  it('classifies a remote push first, then the share banner, then the plugin', () => {
    const p = poster();
    const pushAt = p.indexOf('UNPushNotificationTrigger');
    const shareAt = p.indexOf('CanariIsShareNotification');
    const pluginAt = p.indexOf('CanariIsPluginNotificationIdentifier');
    expect(pushAt).toBeGreaterThan(-1);
    expect(shareAt).toBeGreaterThan(pushAt);
    expect(pluginAt).toBeGreaterThan(shareAt);
  });

  it("hands the plugin only what THIS process posted - no clock, the plugin's own membership", () => {
    const p = poster();
    expect(p).toContain('CanariPluginPostedThisProcess(request.identifier)');
    expect(push).not.toMatch(/notification\.date compare/);
    expect(push).not.toContain('g_processStartedAt');
    // Every add of this process is recorded before it goes through, unchanged.
    const rec = body('static void CanariRecordingAddNotificationRequest(');
    expect(rec.indexOf('addObject:identifier')).toBeLessThan(
      rec.indexOf('CanariOrigAddNotificationRequest(self, _cmd, request, completion);')
    );
    // Installed in main(), before the delegate exists and before any plugin can post.
    const s = setup();
    expect(s.indexOf('CanariRecordNotificationsPostedThisProcess();')).toBeGreaterThan(-1);
    expect(s.indexOf('CanariRecordNotificationsPostedThisProcess();')).toBeLessThan(
      s.indexOf('g_notifDelegate = [[CanariNotificationDelegate alloc] init];')
    );
  });

  it("never gives a Canari-posted local notification the plugin's decimal identifier", () => {
    expect(push).toContain('@"^-?[0-9]{1,10}$"');
    expect(push).toContain('[NSString stringWithFormat:@"canari-%d", notifId]');
    const re = /^-?[0-9]{1,10}$/;
    expect(re.test('123456')).toBe(true);
    expect(re.test('-42')).toBe(true);
    for (const own of ['canari-12', '3F2B8C1E-9A4D-4E7F-B6C2-0D1E2F3A4B5C', 'canari.share.ready']) {
      expect(re.test(own), own).toBe(false);
    }
  });

  it("forwards the plugin's own notifications to the plugin, both callbacks", () => {
    for (const m of [willPresent(), didReceive()]) {
      expect(m).toContain('CanariNotificationPosterPlugin');
      expect(m).toContain('g_forwardNotifDelegate');
      expect(m).toContain('respondsToSelector:_cmd');
    }
  });
});

describe('willPresent: only a remote push is an arrival (no re-post loop)', () => {
  it('reaches CanariHandleFcmData for a push alone - every other poster returns first', () => {
    const w = willPresent();
    const call = 'CanariPushProcessRemoteNotificationUserInfo(';
    expect(w.split(call)).toHaveLength(2);
    const at = w.indexOf(call);
    for (const kase of [
      'case CanariNotificationPosterPlugin:',
      'case CanariNotificationPosterShare:',
      'case CanariNotificationPosterCanari:',
    ]) {
      const start = w.indexOf(kase);
      expect(start, kase).toBeGreaterThan(-1);
      const next = w.indexOf('case ', start + kase.length);
      const branch = w.slice(start, next);
      expect(branch, kase).toMatch(/return;\s*(\}\s*)?$/);
      expect(at, kase).toBeGreaterThan(start);
    }
    // Canari's own local notification is ANSWERED, never handled.
    expect(w).toContain('completionHandler(CanariOwnLocalPresentation(request));');
    // And the push is handled only while active, where it is not presented itself.
    const active = w.indexOf('if (canari_ios_is_in_foreground()) {');
    expect(at).toBeGreaterThan(active);
    expect(w.slice(at, w.indexOf('} else {', at))).toContain(
      'completionHandler(UNNotificationPresentationOptionNone);'
    );
  });

  it('presents in front exactly the local posts that show while foreground (social, forms)', () => {
    const own = body('static UNNotificationPresentationOptions CanariOwnLocalPresentation(');
    expect(own).toContain('kCanariThreadSocial');
    expect(own).toContain('kCanariThreadForms');
    expect(own).toContain('UNNotificationPresentationOptionBanner');
    expect(own).toContain('return UNNotificationPresentationOptionNone;');
    // The poster writes the same two names.
    expect(push).toContain(
      '[msgType isEqualToString:@"form_reminder"] ? kCanariThreadForms : kCanariThreadSocial'
    );
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
  });

  it('writes the file before it tells the page, and tells it on the main queue', () => {
    const q = body('static void CanariQueueNotificationTap(NSString *deepLink) {');
    expect(q.indexOf('writeToFile:path')).toBeGreaterThan(-1);
    expect(q.indexOf('CanariTellPageOfNotificationTap();')).toBeGreaterThan(
      q.indexOf('writeToFile:path')
    );
    const tell = body('static void CanariTellPage(NSString *event, NSString *what) {');
    expect(tell.indexOf('dispatch_async(dispatch_get_main_queue()')).toBeLessThan(
      tell.indexOf('CanariFindWebView()')
    );
  });

  it('names the same file, event and command on every side', () => {
    expect(push).toContain('@"pending_notification_tap.json"');
    expect(pushRs).toContain('"pending_notification_tap.json"');
    expect(push).toContain(`@"${NATIVE_NOTIFICATION_TAP_EVENT}"`);
    expect(pushRs).toContain(`pub(crate) fn ${TAKE_NOTIFICATION_TAP_COMMAND}(`);
    expect(libRs.match(new RegExp(`\\b${TAKE_NOTIFICATION_TAP_COMMAND}\\b`, 'g'))).toHaveLength(2);
  });

  it('is taken outside the deep-link plugin chain, once the router is mounted', () => {
    const listen = hooks.indexOf('listenForNativeNotificationTaps((link) => processUrls([link]))');
    expect(listen).toBeGreaterThan(-1);
    // Registered before the plugin import, so a failed import cannot take it down.
    expect(listen).toBeLessThan(hooks.indexOf("import('@tauri-apps/plugin-deep-link')"));
    expect(layout).toContain('markRouterReady();');
  });
});

describe('a quick reply over a page holding the MLS state is handed to the page', () => {
  it('decides on the fact before any encrypt, with no native second path', () => {
    const q = body('static void CanariHandleQuickReplyAction(');
    const fact = q.indexOf('if (canari_ios_page_holds_mls()) {');
    expect(fact).toBeGreaterThan(-1);
    expect(fact).toBeLessThan(q.indexOf('canari_native_build_text_message_proto'));
    const branch = q.slice(fact, q.indexOf('\n  }\n', fact));
    expect(branch).toContain('CanariHandQuickReplyToPage(groupId, text, notifiedAt)');
    expect(branch.trimEnd().endsWith('return;')).toBe(true);
    expect(bridge).toContain('bool canari_ios_page_holds_mls(void);');
    expect(ffiRs).toContain('crate::concurrency::live_manager_in_process()');
  });

  it('appends the reply, then tells the page', () => {
    const h = body('static BOOL CanariHandQuickReplyToPage(');
    expect(h).toContain('O_APPEND');
    expect(h.indexOf('write(fd')).toBeLessThan(
      h.indexOf(`CanariTellPage(@"${NATIVE_QUICK_REPLY_EVENT}"`)
    );
  });

  it('names the same file and commands on every side', () => {
    expect(push).toContain('@"pending_quick_replies.ndjson"');
    expect(pushRs).toContain('"pending_quick_replies.ndjson"');
    for (const cmd of [TAKE_QUICK_REPLIES_COMMAND, RETURN_QUICK_REPLIES_COMMAND]) {
      expect(pushRs).toContain(`pub(crate) fn ${cmd}(`);
      expect(libRs.match(new RegExp(`\\b${cmd}\\b`, 'g')), cmd).toHaveLength(2);
    }
  });
});
