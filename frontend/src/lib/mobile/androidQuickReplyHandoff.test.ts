import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGE_QUICK_REPLY_COMMAND,
  NATIVE_QUICK_REPLY_EVENT,
  RETURN_QUICK_REPLIES_COMMAND,
  TAKE_QUICK_REPLIES_COMMAND,
  UNCLAIMED_QUICK_REPLIES_COMMAND,
} from './quickReplyDrain';

/**
 * AN ANDROID QUICK REPLY TYPED WITH THE APP IN FRONT GOES TO THE PAGE.
 *
 * Read on the Mi 9T (#3912, 2026-11-20): the native encrypt was refused by the foreground guard, the
 * retry worker stood down for the page, and the page never heard of the mirror entry - the reply sat
 * queued until the app went to the background. The route itself is tested on the JVM
 * (`QuickReplyRouteTest`) and the page's drain in `quickReplyDrain.test.ts`; this pins the wiring
 * neither reaches: the route asked before anything is queued, the line on disk before the page is
 * told, and one file, one event and one set of commands on every side.
 * Mechanism: docs/wiki/frontend/mobile.md, "A quick reply over a page that holds the MLS state".
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(here, '../../../src-tauri');
const JAVA = resolve(SRC_TAURI, 'gen/android/app/src/main/java/fr/emse/canari');
const receiver = readFileSync(resolve(JAVA, 'CanariNotificationActionReceiver.kt'), 'utf8');
const activity = readFileSync(resolve(JAVA, 'MainActivity.kt'), 'utf8');
const service = readFileSync(resolve(JAVA, 'CanariFirebaseMessagingService.kt'), 'utf8');
const pushRs = readFileSync(resolve(SRC_TAURI, 'src/commands/push.rs'), 'utf8');
const libRs = readFileSync(resolve(SRC_TAURI, 'src/lib.rs'), 'utf8');
const chatService = readFileSync(
  resolve(here, '../components/layout/ChatBackgroundService.svelte'),
  'utf8'
);

/** The body of the function whose declaration starts with [signature], up to the next KDoc. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('\n    /**', start);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('an Android quick reply over a page that holds the MLS state', () => {
  it('routes on THE fact the guard refuses on, before the reply is built or queued', () => {
    const reply = body(receiver, 'private fun handleReply(');
    const route = reply.indexOf(
      'QuickReplyRoute.of(CanariFirebaseMessagingService.nativeForegroundGuardHolds())'
    );
    expect(route).toBeGreaterThan(-1);
    // Never the activity's resume edge: a second fact could disagree with the refusal.
    expect(reply).not.toContain('MainActivity.isInForeground');
    // ONE INFO line per reply names its route: the NATIVE one here, the PAGE one where the
    // hand-over's outcome is known - every line of the hand-over carries it.
    expect(reply).toContain('route NATIVE, the foreground guard is released');
    expect(reply).not.toContain('route PAGE');
    const hand = body(receiver, 'private fun handReplyToPage(');
    expect(hand.match(/Log\.i\(/g)).toHaveLength(1);
    expect(hand.match(/Log\.[iwe]\(TAG, "handReplyToPage: /g)?.length).toBe(
      hand.match(/handReplyToPage: route PAGE, the foreground guard holds - /g)?.length
    );
    const handed = reply.indexOf('handReplyToPage(');
    expect(handed).toBeGreaterThan(route);
    expect(handed).toBeLessThan(reply.indexOf('nativeBuildTextMessageProto('));
    expect(handed).toBeLessThan(reply.indexOf('enqueueOutboxMirror('));
  });

  it('writes the line, records it and draws it SENDING before it tells the page - never answered', () => {
    const hand = body(receiver, 'private fun handReplyToPage(');
    const locked = hand.indexOf('synchronized(HandedQuickReplyStore.LOCK)');
    const write = hand.indexOf('nativeHandQuickReplyToPage(');
    const record = hand.indexOf('HandedQuickReplyStore.record(');
    const sending = hand.indexOf('ReplyLine.SENDING');
    const tell = hand.indexOf('MainActivity.tellPage(QUICK_REPLY_EVENT)');
    expect(locked).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(locked);
    expect(record).toBeGreaterThan(write);
    expect(sending).toBeGreaterThan(record);
    expect(tell).toBeGreaterThan(sending);
    expect(hand).not.toContain('enqueueOutboxMirror');
    expect(hand).not.toContain('drainOutboxBackground');
    // A reply that could not be handed over is LOST and said - final, never "retrying".
    expect(hand).toContain('ReplyLine.NOT_SENT_RETYPE');
    expect(hand).not.toContain('ReplyLine.RETRYING');
    expect(receiver).toContain(`QUICK_REPLY_EVENT = "${NATIVE_QUICK_REPLY_EVENT}"`);
  });

  it('draws the banner answered only on the page settlement, and the final lines unawaited', () => {
    expect(service).toContain(
      'fun quickReplySettledByPage(replyId: String, outcome: Int): Boolean'
    );
    // The native side LISTS the unclaimed replies and draws none: the page settles each one from
    // what it holds (review of #3927 - "lost" decided from the file drew "retype it" over a sent one).
    expect(service).toContain('fun unclaimedHandedQuickReplies(accountId: String): String?');
    const from = service.indexOf('fun unclaimedHandedQuickReplies(');
    const unclaimed = service.slice(from, service.indexOf('\n        }\n', from));
    expect(unclaimed).not.toContain('drawHandedSettlement');
    expect(unclaimed).not.toContain('HandedQuickReplyStore.take');
    expect(service).toContain('NOT_SENT_RETYPE(R.string.notif_reply_not_sent_retype, false)');
    expect(service).toContain('NOT_SENT_IN_APP(R.string.notif_reply_not_sent_in_app, false)');
    expect(service).toContain('SENDING(R.string.notif_reply_sending, true)');
    expect(service).toContain(
      'if (line.awaited) extras.putString(LINE_PENDING_REPLY_ID, messageId)'
    );
    expect(pushRs).toContain('"quickReplySettledByPage"');
    expect(pushRs).toContain('"unclaimedHandedQuickReplies"');
    expect(pushRs).toContain(`pub(crate) async fn ${UNCLAIMED_QUICK_REPLIES_COMMAND}(`);
    expect(libRs).toContain(`            ${UNCLAIMED_QUICK_REPLIES_COMMAND},`);
    const ack = pushRs.slice(pushRs.indexOf(`pub(crate) fn ${ACKNOWLEDGE_QUICK_REPLY_COMMAND}(`));
    const ackBody = ack.slice(0, ack.indexOf('\n}\n'));
    expect(ackBody).toContain('#[cfg(any(target_os = "ios", target_os = "android"))]');
    // WHETHER THE NATIVE SIDE WAS TOLD is answered, never dropped: the page shows a loss nobody drew.
    expect(ackBody).toContain('-> Result<bool, String>');
    expect(ackBody).toContain('Ok(tell_quick_reply_settled(&reply_id, parsed))');
  });

  it('writes a handed-over reply under its reply id, and settles a sign-out from the leaving store', () => {
    const shell = chatService;
    expect(shell).toContain(
      'globalMessaging.sendTextTo(reply.text, reply.groupId, msgCtx(), reply.replyId)'
    );
    expect(shell).toContain('heldAs: (replyId) => globalMessaging.heldAs(replyId, msgCtx()),');
    const signedOut = shell.slice(shell.indexOf('function handleSignedOut()'));
    // BEFORE the teardown lets go of the store, and not awaited: `clearAuth` needs the teardown
    // synchronous.
    expect(signedOut.indexOf('settleLeavingQuickReplies();')).toBeGreaterThan(-1);
    expect(signedOut.indexOf('settleLeavingQuickReplies();')).toBeLessThan(
      signedOut.indexOf('globalSession.endSession(sessionCb())')
    );
    const settles = shell.slice(shell.indexOf('function settleLeavingQuickReplies()'));
    expect(settles.slice(0, settles.indexOf('\n  }\n'))).toContain(
      'const leavingCtx = msgCtx();\n    void settleNativeQuickRepliesAtSignOut('
    );
  });

  it('dispatches the event on the live page only', () => {
    expect(activity).toContain('fun tellPage(event: String): Boolean');
    expect(activity).toContain('pageWebView = webView');
    expect(activity).toContain('if (pageWebView === webView) pageWebView = null');
  });

  it('appends under the lock every Rust reader of the file holds', () => {
    expect(libRs).toContain('nativeHandQuickReplyToPage');
    expect(libRs).toContain('commands::push::hand_quick_reply_in(');
    expect(libRs).toContain('nativeForegroundGuardHolds');
    expect(libRs).toContain('if concurrency::foreground_is_active() {');
    expect(service).toContain('external fun nativeHandQuickReplyToPage(');
    const hand = pushRs.slice(pushRs.indexOf('pub(crate) fn hand_quick_reply_in('));
    expect(hand.slice(0, hand.indexOf('\n}\n'))).toContain('quick_reply_file_lock()');
    const take = pushRs.slice(pushRs.indexOf('pub(crate) fn take_quick_replies_in('));
    expect(take.slice(0, take.indexOf('\n}\n'))).toContain('quick_reply_file_lock()');
  });

  it('serves the same file and commands to Android as to iOS', () => {
    expect(pushRs).toContain('"pending_quick_replies.ndjson"');
    for (const cmd of [TAKE_QUICK_REPLIES_COMMAND, RETURN_QUICK_REPLIES_COMMAND]) {
      const fn = pushRs.slice(pushRs.indexOf(`pub(crate) async fn ${cmd}(`));
      expect(fn.slice(0, fn.indexOf('\n}\n')), cmd).toContain(
        '#[cfg(any(target_os = "ios", target_os = "android"))]'
      );
    }
    expect(pushRs).toContain(`pub(crate) fn ${ACKNOWLEDGE_QUICK_REPLY_COMMAND}(`);
  });

  it('registers the page as the sender on both phones', () => {
    expect(chatService).toContain(
      'const stopNativeQuickReply = isMobileTauriRuntime() ? listenForNativeQuickReplies()'
    );
    expect(chatService).not.toContain('isIosTauriRuntime()');
  });
});
