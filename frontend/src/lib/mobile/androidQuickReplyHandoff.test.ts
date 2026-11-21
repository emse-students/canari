import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGE_QUICK_REPLY_COMMAND,
  NATIVE_QUICK_REPLY_EVENT,
  RETURN_QUICK_REPLIES_COMMAND,
  TAKE_QUICK_REPLIES_COMMAND,
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
  it('asks the route before the reply is built or queued, and hands it over on PAGE', () => {
    const reply = body(receiver, 'private fun handleReply(');
    const route = reply.indexOf('QuickReplyRoute.of(MainActivity.isInForeground)');
    expect(route).toBeGreaterThan(-1);
    expect(reply).toContain('CanariFirebaseMessagingService.nativePageHoldsMls()');
    const handed = reply.indexOf('handReplyToPage(');
    expect(handed).toBeGreaterThan(route);
    expect(handed).toBeLessThan(reply.indexOf('nativeBuildTextMessageProto('));
    expect(handed).toBeLessThan(reply.indexOf('enqueueOutboxMirror('));
  });

  it('writes the line before it tells the page, and never touches the outbox mirror', () => {
    const hand = body(receiver, 'private fun handReplyToPage(');
    const write = hand.indexOf('nativeHandQuickReplyToPage(');
    const tell = hand.indexOf('MainActivity.tellPage(QUICK_REPLY_EVENT)');
    expect(write).toBeGreaterThan(-1);
    expect(tell).toBeGreaterThan(write);
    expect(hand).not.toContain('enqueueOutboxMirror');
    expect(hand).not.toContain('drainOutboxBackground');
    // A reply that could not be handed over is said, never dropped in silence.
    expect(hand).toContain('repostReplyPending(');
    expect(receiver).toContain(`QUICK_REPLY_EVENT = "${NATIVE_QUICK_REPLY_EVENT}"`);
  });

  it('dispatches the event on the live page only', () => {
    expect(activity).toContain('fun tellPage(event: String): Boolean');
    expect(activity).toContain('pageWebView = webView');
    expect(activity).toContain('if (pageWebView === webView) pageWebView = null');
  });

  it('appends under the lock every Rust reader of the file holds', () => {
    expect(libRs).toContain('nativeHandQuickReplyToPage');
    expect(libRs).toContain('commands::push::hand_quick_reply_in(');
    expect(libRs).toContain('nativePageHoldsMls');
    expect(libRs).toContain('concurrency::live_manager_in_process()');
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
