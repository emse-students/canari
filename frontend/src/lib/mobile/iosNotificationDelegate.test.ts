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
    // And the push is handled only while active, where it is presented only to keep a delivered
    // twin of the same identifier (`CanariPresentForegroundPush`: List, else None).
    const active = w.indexOf('if (canari_ios_is_in_foreground()) {');
    expect(at).toBeGreaterThan(active);
    expect(w.slice(at, w.indexOf('} else {', at))).toContain(
      'CanariPresentForegroundPush(center, request.identifier, completionHandler);'
    );
  });

  it('NEVER A LOSS: a push while active keeps a list entry when the page posted its twin', () => {
    // The page files its post of a reaction under the push's `apns-collapse-id` (#3792). Should iOS
    // REPLACE that delivered request by the arriving push, answering None would erase the record;
    // so the answer is read from what is delivered, never from a guess: the same identifier
    // delivered -> List (worst case a double), none -> None (the reaction is on screen).
    const w = willPresent();
    const at = w.indexOf('CanariPushProcessRemoteNotificationUserInfo(');
    const branch = w.slice(at, w.indexOf('} else {', at));
    // EVERY active push, chosen by IDENTIFIER, never by its data: a wake whose fetch failed or came
    // back `gone` keeps `type=wake` in its userInfo yet carries the reaction's collapse id (round 4).
    expect(branch).toMatch(
      /CanariPushProcessRemoteNotificationUserInfo\(request\.content\.userInfo\);\s*(\/\/[^\n]*\n\s*)*CanariPresentForegroundPush\(center, request\.identifier, completionHandler\);\s*$/
    );
    expect(branch).not.toContain('CanariIsReactionData');
    expect(branch).not.toContain('UNNotificationPresentationOptionNone');
    const present = body('static void CanariPresentForegroundPush(');
    expect(present).toContain('[center getDeliveredNotificationsWithCompletionHandler:');
    expect(present).toContain('[n.request.identifier isEqualToString:identifier]');
    expect(present).toContain(
      'completionHandler(pagePosted ? UNNotificationPresentationOptionList\n                                   : UNNotificationPresentationOptionNone);'
    );
    // The delivered list answers on a queue of the center's choosing: the handler runs ON MAIN only.
    const handled = present.indexOf('completionHandler(pagePosted');
    expect(
      present.lastIndexOf('dispatch_async(dispatch_get_main_queue(), ^{', handled)
    ).toBeGreaterThan(present.indexOf('getDeliveredNotificationsWithCompletionHandler:'));
    expect(present.match(/\bcompletionHandler\(/g)).toHaveLength(1);
    // ONE discriminator for a reaction, read by the arrival handler and by the presentation.
    expect(push.split('static BOOL CanariIsReactionData(')).toHaveLength(2);
    expect(body('static void CanariHandleFcmData(')).toContain(
      'BOOL isReaction = CanariIsReactionData(data);'
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
    expect(branch).toContain('notifiedAt, finish);');
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
    expect(release).not.toContain('hold.completion');
    expect(release).toContain('CanariEndQuickReplyTask(hold);');
    expect(body('static void CanariEndQuickReplyTaskOnMain(')).toContain('endBackgroundTask:task');
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
    // Whoever released first, the expiry ends its own task, synchronously, before it returns.
    expect(h.slice(h.indexOf('expirationHandler:'))).toContain(
      'CanariEndQuickReplyTaskOnMain(hold);'
    );
    // The id is taken from the hold ON MAIN only (round 4): off main, a block is queued that takes
    // it there - never an id taken off main and ended later, behind a handler that saw it gone.
    const end = body('static void CanariEndQuickReplyTask(CanariQuickReplyHold *hold) {');
    expect(end).not.toContain('hold.task');
    expect(end).toContain('dispatch_async(dispatch_get_main_queue(), ^{');
    expect(end).toContain('CanariEndQuickReplyTaskOnMain(hold);');
    expect(body('static void CanariEndQuickReplyTaskOnMain(')).toContain(
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
    expect(pushRs).toContain('Ok(tell_quick_reply_settled(&reply_id, parsed))');
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
    expect(body('static void CanariPostLocalNotification(')).toContain(
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

/**
 * The block literal (`^{ ... }` or `^(args) { ... }`) whose caret is at `caret` in `src`, braces
 * matched. Enough for this file: no brace in these methods sits inside a string or a comment.
 */
function blockAt(src: string, caret: number): string {
  const open = src.indexOf('{', caret);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(caret, i + 1);
  }
  throw new Error(`unbalanced block at ${caret}`);
}

/** Every block literal in `src` that is NOT the argument of a main-queue dispatch. */
function offMainBlocks(src: string): string[] {
  const blocks: string[] = [];
  for (const m of src.matchAll(/\^\s*(\([^)]*\)\s*)?\{/g)) {
    const before = src.slice(Math.max(0, m.index - 60), m.index);
    if (/dispatch_async\(dispatch_get_main_queue\(\),\s*$/.test(before)) continue;
    blocks.push(blockAt(src, m.index));
  }
  return blocks;
}

describe('a notification response is completed on the main thread (iPhone 12, 1.6.12-alpha.2)', () => {
  // "Marquer comme lu" from a killed app did its work, then aborted the app: `completionHandler()`
  // ran on the global queue the action worked on, and iOS asserts the main thread inside it.
  const methods = () => [didReceive(), willPresent()];

  it('never lets the raw handler into a block that can run off main', () => {
    for (const m of methods()) {
      for (const block of offMainBlocks(m)) {
        expect(block, block.slice(0, 120)).not.toMatch(/\bcompletionHandler\b/);
      }
    }
  });

  it('calls the raw handler only synchronously, in the delegate callback iOS runs on main', () => {
    for (const m of methods()) {
      for (const use of m.matchAll(/\bcompletionHandler\b/g)) {
        const line = m.slice(m.lastIndexOf('\n', use.index) + 1, m.indexOf('\n', use.index));
        expect(line.trim(), line).toMatch(
          /^(completionHandler\(|withCompletionHandler:completionHandler\]|void \(\^finish\)\(void\) = CanariFinishOnMain\(completionHandler,|\(void \(\^\)\(UNNotificationPresentationOptions options\)\)completionHandler \{|withCompletionHandler:\(void \(\^\)\(void\)\)completionHandler \{|CanariPresentForegroundPush\(center, request\.identifier, completionHandler\);)/
        );
      }
    }
  });

  it('gives every registered action a branch that finishes through the main-queue wrapper', () => {
    const categories = body('void CanariRefreshNotificationCategories(void) {');
    const actions = [...categories.matchAll(/actionWithIdentifier:(\w+)/g)].map((m) => m[1]);
    expect(actions).toEqual(['kCanariReplyActionId', 'kCanariMarkReadActionId']);
    const r = didReceive();
    for (const id of actions) {
      const start = r.indexOf(`isEqualToString:${id}]`);
      expect(start, id).toBeGreaterThan(-1);
      const branch = blockAt(r, r.indexOf('{', start));
      expect(branch, id).toContain('CanariFinishOnMain(completionHandler, @"');
      expect(branch, id).toContain('dispatch_get_global_queue');
      expect(branch, id).toMatch(/\bfinish[();]/);
    }
  });

  it('completes a held reply on main, BEFORE its task ends, in the step the expiry runs too', () => {
    // A settlement off main used to call the completion there and queue only the end: an expiry
    // running first ended the task with the response outstanding (review of #3583).
    const onMain = body('static void CanariEndQuickReplyTaskOnMain(');
    const taken = onMain.indexOf('hold.completion = nil;');
    expect(taken).toBeGreaterThan(-1);
    expect(onMain.indexOf('completion();')).toBeGreaterThan(taken);
    expect(onMain.indexOf('endBackgroundTask:task')).toBeGreaterThan(
      onMain.indexOf('completion();')
    );
  });

  it('completes mark read only after the notification removal, on main', () => {
    const action = body('static void CanariHandleMarkReadAction(');
    expect(action).toContain('dispatch_group_leave(removal);');
    expect(action).not.toContain('CanariCancelConversationNotification(groupId, nil)');
    expect(action).toContain('dispatch_group_notify(removal, dispatch_get_main_queue(), done);');
  });

  it('hops to the main queue in the wrapper, with no timer', () => {
    const w = body('static void (^CanariFinishOnMain(');
    expect(w).toContain('if ([NSThread isMainThread]) {');
    expect(w).toContain('dispatch_async(dispatch_get_main_queue(), ^{');
    expect(w).not.toMatch(/dispatch_after|NSTimer|dispatch_get_global_queue/);
  });
});
