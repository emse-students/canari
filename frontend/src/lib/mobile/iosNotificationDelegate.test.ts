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
  ACKNOWLEDGE_QUICK_REPLY_COMMAND,
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
    expect(
      take.indexOf('center.delegate = (id<UNUserNotificationCenterDelegate>)g_notifDelegate;')
    ).toBeGreaterThan(take.indexOf('g_forwardNotifDelegate = holder;'));
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
    // Any other local post is hidden while ACTIVE only: inactive (Notification Center down), it is
    // the only surface, as for a push (review of #2843, A5).
    expect(own).toContain(
      'return canari_ios_is_in_foreground() ? UNNotificationPresentationOptionNone : shown;'
    );
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
    expect(fact).toBeLessThan(q.indexOf('CanariSendQuickReplyNatively('));
    const branch = q.slice(fact, q.indexOf('\n  }\n', fact));
    expect(branch).toContain(
      'CanariHandQuickReplyToPage(recipientId, groupId, text, notifiedAt, completion);'
    );
    expect(branch.trimEnd().endsWith('return;')).toBe(true);
    expect(bridge).toContain('bool canari_ios_page_holds_mls(void);');
    expect(ffiRs).toContain('crate::concurrency::live_manager_in_process()');
  });

  it('holds the process before the line is written, appends it, then tells the page', () => {
    const h = body('static void CanariHandQuickReplyToPage(');
    const hold = h.indexOf('CanariHoldQuickReply(replyId, completion);');
    const append = h.indexOf('CanariAppendQuickReplyLine(sealed)');
    expect(hold).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(append);
    expect(append).toBeLessThan(h.indexOf(`CanariTellPage(@"${NATIVE_QUICK_REPLY_EVENT}"`));
    expect(body('static BOOL CanariAppendQuickReplyLine(')).toContain('O_APPEND');
  });

  it('names the same file and commands on every side', () => {
    expect(push).toContain('@"pending_quick_replies.ndjson"');
    expect(pushRs).toContain('"pending_quick_replies.ndjson"');
    for (const cmd of [
      TAKE_QUICK_REPLIES_COMMAND,
      RETURN_QUICK_REPLIES_COMMAND,
      ACKNOWLEDGE_QUICK_REPLY_COMMAND,
    ]) {
      expect(pushRs).toMatch(new RegExp(`pub\\(crate\\) (async )?fn ${cmd}\\(`));
      expect(libRs.match(new RegExp(`\\b${cmd}\\b`, 'g')), cmd).toHaveLength(2);
    }
  });
});

describe('a suspended page gets the time to own a reply (review of #2843, A1)', () => {
  it('passes the response on and never completes it in the reply branch', () => {
    const r = didReceive();
    const start = r.indexOf('isEqualToString:kCanariReplyActionId');
    const branch = r.slice(start, r.indexOf('isEqualToString:kCanariMarkReadActionId'));
    expect(branch).toContain('notifiedAt, completionHandler);');
    expect(branch).not.toContain('completionHandler();');
  });

  it('holds a background task whose expiry reads as pending and accuses, never a clock of ours', () => {
    const h = body('static void CanariHoldQuickReply(');
    expect(h).toContain('beginBackgroundTaskWithName:@"canari-quick-reply"');
    const expiry = h.slice(h.indexOf('expirationHandler:'));
    expect(expiry).toContain('ERROR quick reply');
    expect(expiry).toContain('CanariReleaseQuickReplyHold(replyId, CanariQuickReplyPending,');
    expect(h).not.toMatch(/dispatch_after|NSTimer|asyncAfter/);
    const release = body('static void CanariReleaseQuickReplyHold(');
    expect(release).toContain('CanariTellQuickReplyOutcome(outcome);');
    expect(release).toContain('hold.completion();');
    expect(release).toContain('CanariEndQuickReplyTask(hold);');
    expect(body('static void CanariEndQuickReplyTask(')).toContain('endBackgroundTask:task');
  });

  it('stores the task id before the expiry can run, and the expiry ends its own task (L1)', () => {
    const h = body('static void CanariHoldQuickReply(');
    // Begun, stored and published in ONE block on the main thread, where iOS runs the expiry.
    expect(h).toContain('dispatch_sync(dispatch_get_main_queue(), begin);');
    const begin = h.slice(
      h.indexOf('void (^begin)(void) = ^{'),
      h.indexOf('if ([NSThread isMainThread])')
    );
    const stored = begin.indexOf('hold.task = task;');
    expect(stored).toBeGreaterThan(begin.indexOf('beginBackgroundTaskWithName'));
    expect(begin.indexOf('g_quickReplyHolds[replyId] = hold;')).toBeGreaterThan(stored);
    // Whoever released first, the expiry ends its own task before it returns.
    expect(h.slice(h.indexOf('expirationHandler:'))).toContain('CanariEndQuickReplyTask(hold);');
    // And a task is ended once: whoever takes the id from the hold first.
    expect(body('static void CanariEndQuickReplyTask(')).toContain(
      'hold.task = UIBackgroundTaskInvalid;'
    );
  });

  it("is released by the page's SETTLEMENT, through a listener registered at setup (H1)", () => {
    expect(setup()).toContain(
      'canari_ios_set_quick_reply_ack_listener(CanariPageSettledQuickReply);'
    );
    expect(bridge).toContain('void canari_ios_set_quick_reply_ack_listener(');
    expect(bridge).toContain('int32_t outcome');
    expect(ffiRs).toContain('pub extern "C" fn canari_ios_set_quick_reply_ack_listener(');
    expect(pushRs).toContain('tell_quick_reply_settled(&reply_id, parsed);');
  });

  it('names the same five outcome codes on both sides', () => {
    for (const [name, code] of [
      ['Sent', 0],
      ['Failed', 1],
      ['Pending', 2],
      ['Returned', 3],
      ['Lost', 4],
    ] as const) {
      expect(push).toContain(`CanariQuickReply${name} = ${code},`);
      expect(pushRs).toContain(`    ${name} = ${code},`);
    }
  });

  it('a pending reply schedules the retry and the pending notice, as the native path does', () => {
    const tell = body('static void CanariTellQuickReplyOutcome(');
    const pending = tell.slice(tell.indexOf('case CanariQuickReplyPending:'));
    expect(pending.slice(0, pending.indexOf('return;'))).toContain(
      'CanariMaybeNotifyPendingSync(1);'
    );
    // Lost is told in front too: nothing else would say it.
    const lost = tell.slice(tell.indexOf('case CanariQuickReplyLost:'));
    expect(lost.slice(0, lost.indexOf('return;'))).not.toContain('canari_ios_is_in_foreground');
  });
});

describe('a reply is sent as the account its notification was addressed to (review of #2843, M3)', () => {
  const nse = readFileSync(
    resolve(SRC_TAURI, 'gen/apple/canari_NSE/NotificationService.swift'),
    'utf8'
  );

  it('both posters stamp the recipient under the same key', () => {
    expect(push).toContain('kCanariRecipientKey = @"recipientId";');
    expect(body('static void CanariShowLocalNotification(')).toContain(
      'userInfo[kCanariRecipientKey] = recipient;'
    );
    expect(nse).toContain('content.userInfo["recipientId"] = recipient');
  });

  it('the reply reads the recipient from the notification, never from the context at reply time', () => {
    const r = didReceive();
    const branch = r.slice(r.indexOf('isEqualToString:kCanariReplyActionId'));
    expect(branch).toContain('userInfo[kCanariRecipientKey]');
    const h = body('static void CanariHandQuickReplyToPage(');
    expect(h).toContain('CanariSealQuickReply(replyId, recipientId, groupId, text, notifiedAt)');
    expect(h).not.toContain('CanariLoadPushContext');
    expect(body('static NSString *CanariSealQuickReply(')).not.toContain('CanariLoadPushContext');
  });

  it('refuses VISIBLY a reply naming no recipient, or another account than the context', () => {
    const q = body('static void CanariHandleQuickReplyAction(');
    const none = q.slice(q.indexOf('if (recipientId.length == 0) {'));
    expect(none.slice(0, none.indexOf('return;'))).toContain('CanariShowQuickReplyNotSent();');
    const other = q.slice(q.indexOf('![ctx.userId isEqualToString:recipientId]'));
    expect(other.slice(0, other.indexOf('return;'))).toContain('CanariShowQuickReplyNotSent();');
  });

  it('a sign-out removes every delivered notification', () => {
    expect(body('+ (BOOL)endForSignOut {')).toContain('removeAllDeliveredNotifications');
  });

  it('the "not sent" notice is presented in front, on its own thread', () => {
    expect(body('static void CanariShowQuickReplyNotSent(void) {')).toContain(
      'kCanariThreadQuickReply'
    );
    expect(body('static UNNotificationPresentationOptions CanariOwnLocalPresentation(')).toContain(
      'kCanariThreadQuickReply'
    );
  });
});

describe('a reply is sealed and names its account (review of #2843, A2)', () => {
  it('stamps the account and seals the line before it touches the disk', () => {
    const s = body('static NSString *CanariSealQuickReply(');
    expect(s).toContain('@"accountId" : accountId');
    expect(s).toContain('canari_native_seal_quick_reply_line(');
    expect(ffiRs).toContain('crate::native_cache::Purpose::QuickReply');
    // The hand-over writes only what the seal returned.
    const h = body('static void CanariHandQuickReplyToPage(');
    expect(h).toContain('CanariSealQuickReply(replyId, recipientId, groupId, text, notifiedAt)');
    expect(h).not.toContain('NSJSONSerialization');
  });
});

describe('the add recorder is installed once (review of #2843, A4)', () => {
  it('guards the install with dispatch_once, its only caller', () => {
    const r = body('static void CanariRecordNotificationsPostedThisProcess(void) {');
    expect(r).toContain('dispatch_once(&once');
    expect(push.match(/CanariInstallNotificationRecorder\(\);/g)).toHaveLength(1);
  });
});
