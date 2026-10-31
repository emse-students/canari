import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE NATIVE RING'S SCREENS, HELD AS TEXT (review of #2727).
 *
 * The Kotlin of `IncomingCallActivity` and the ring notification is an Activity and a service: no JVM
 * test reaches them (`android-tests` compiles the pure packages only), and no CI gate compiles them.
 * So what must never regress is pinned here, in the source:
 * - the full-screen intent is the CALL SCREEN, never the answer (Android launches it by itself on a
 *   locked phone, which would answer every call nobody touched);
 * - the screen never outlives its ring (a launch after the ring ended, the app's resume, its own
 *   window, a second call);
 * - an iPhone whose app is open does not ring twice (CallKit over the in-app overlay);
 * - the server's `call_ring` is the only ring: a decrypted MLS `call_invite` never rings;
 * - the ring's end is armed before its photo, and an unnamed caller shows no photo;
 * - Answer lends its background-start privilege, or Android 14+ may block the app's launch.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../../src-tauri/gen');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');
const push = read('android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt');
const screen = read('android/app/src/main/java/fr/emse/canari/IncomingCallActivity.kt');
const pushMm = read('apple/Sources/canari/canari_push.mm');
const nse = read('apple/canari_NSE/NotificationService.swift');

/** The text from `start` to the next `end` after it, or fail naming what went missing. */
function between(src: string, start: string, end: string, what: string): string {
  const from = src.indexOf(start);
  expect(from, `${what} was renamed or removed`).toBeGreaterThanOrEqual(0);
  const to = src.indexOf(end, from + start.length);
  expect(to, `the end of ${what} was not found`).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe('the full-screen intent opens a screen that asks', () => {
  it('never hands setFullScreenIntent or the content intent the answer', () => {
    const calls = [...push.matchAll(/setFullScreenIntent\(([^,)]*)/g)].map((m) => m[1].trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const arg of calls) expect(arg).not.toMatch(/answer/i);
    for (const m of push.matchAll(/setContentIntent\(([^)]*)\)/g)) {
      expect(m[1]).not.toMatch(/answer/i);
    }
  });

  it('builds the full-screen PendingIntent from IncomingCallActivity', () => {
    const show = between(
      push,
      'internal fun showIncomingCallNotification(',
      'private fun buildIncomingCallNotification(',
      'showIncomingCallNotification'
    );
    expect(show).toMatch(
      /val fullScreenPending = PendingIntent\.getActivity\([\s\S]*?IncomingCallActivity\.intentFor\(/
    );
  });
});

describe('the call screen never outlives its ring', () => {
  it('a launch that lands after the ring ended closes at once', () => {
    const show = between(
      screen,
      'private fun show(intent: Intent)',
      'override fun onDestroy',
      'show'
    );
    const ask = show.indexOf('CanariFirebaseMessagingService.isRinging(callId)');
    const register = show.indexOf('showing[callId] = WeakReference(this)');
    expect(ask).toBeGreaterThan(0);
    // Asked BEFORE the screen registers itself as shown.
    expect(register).toBeGreaterThan(ask);
  });

  it('bounds itself by the ring window, and forgets that bound when it goes', () => {
    expect(screen).toContain(
      'main.postDelayed(ringWindowOver, CanariFirebaseMessagingService.CALL_RING_TIMEOUT_MS)'
    );
    const destroy = between(screen, 'override fun onDestroy()', 'super.onDestroy()', 'onDestroy');
    expect(destroy).toContain('main.removeCallbacks(ringWindowOver)');
  });

  it('a second call while it shows replaces it (singleTop) - only if that call still rings', () => {
    const onNew = between(
      screen,
      'override fun onNewIntent(intent: Intent)',
      'private fun show(intent: Intent)',
      'onNewIntent'
    );
    const askNext = onNew.indexOf('CanariFirebaseMessagingService.isRinging(next)');
    const keepFirst = onNew.indexOf('CanariFirebaseMessagingService.isRinging(previous)');
    const replace = onNew.indexOf('show(intent)');
    expect(askNext).toBeGreaterThan(0);
    expect(keepFirst).toBeGreaterThan(askNext);
    // Validated BEFORE the first call's screen entry is dropped and replaced.
    expect(onNew.indexOf('showing.remove(previous)')).toBeGreaterThan(keepFirst);
    expect(replace).toBeGreaterThan(keepFirst);
  });

  it("the app's resume closes every ring's screen before it forgets the rings", () => {
    const body = between(
      push,
      'fun cancelAllMessageNotifications(context: Context)',
      'activeCallRings.clear()',
      'cancelAllMessageNotifications'
    );
    expect(body).toContain('IncomingCallActivity.finishFor(ringing,');
  });

  it('the end of a ring closes its screen', () => {
    const cancel = between(
      push,
      'internal fun cancelIncomingCallNotification(',
      'Log.d(TAG, "cancelIncomingCallNotification',
      'cancelIncomingCallNotification'
    );
    expect(cancel).toContain('IncomingCallActivity.finishFor(callId,');
  });
});

describe('an open iPhone rings once', () => {
  it('a VoIP push to an app in the foreground is reported and ended at once', () => {
    const report = between(
      pushMm,
      'static void CanariReportVoipCall(',
      'long long nowMs',
      'CanariReportVoipCall'
    );
    expect(report).toMatch(
      /else if \(canari_ios_is_in_foreground\(\)\) \{[\s\S]*?ringUntilMs = 0;/
    );
  });

  it('the call not to ring is ended inside the report completion, not after it', () => {
    const tail = between(
      pushMm,
      'BOOL endAtOnce = remainingMs <= 0;',
      'long long ringMs',
      'the end-at-once report'
    );
    const completion = between(tail, 'completion:^', '}];', 'the report completion');
    expect(completion).toMatch(/if \(endAtOnce\) \{[\s\S]*?CanariEndCallKitCall\(callId,/);
    // Nothing ends the call outside the completion.
    const after = tail.slice(tail.indexOf('}];'));
    expect(after).not.toContain('CanariEndCallKitCall');
  });
});

describe('the one native ring is the server call_ring', () => {
  // A decrypted MLS call_invite rang past calls_mode, the conversation permission, the video rule
  // and blocks - all four applied by the server alone, before it sends call_ring.
  it('Android: a decrypted call_invite never rings', () => {
    const branch = between(
      push,
      'if (decrypted?.type == "call_invite") {',
      'return',
      'the Kotlin call_invite branch'
    );
    expect(branch).not.toContain('showIncomingCallNotification');
    // The ring has exactly ONE call site: the call_ring data push.
    const sites = [...push.matchAll(/(?<!fun )showIncomingCallNotification\(/g)];
    expect(sites).toHaveLength(1);
  });

  it('iOS: a decrypted call_invite never reports to CallKit', () => {
    const branch = between(
      pushMm,
      '[decrypted.type isEqualToString:@"call_invite"]) {',
      'return;',
      'the iOS call_invite branch'
    );
    expect(branch).not.toContain('CanariReportIncomingCall');
    expect(branch).not.toContain('CanariReportVoipCall');
    const sites = [...pushMm.matchAll(/(?<!static void )CanariReportIncomingCall\(/g)];
    expect(sites).toHaveLength(1);
  });

  it('iOS extension: a decrypted call_invite delivered as an alert rings nothing', () => {
    const branch = between(
      nse,
      'if let call = decrypted, call.type == "call_invite" {',
      'return',
      'the extension call_invite branch'
    );
    expect(branch).toContain('applyCallControlContent(');
    expect(branch).toContain('ended: false');
    expect(nse).not.toContain('applyCallInviteContent');
    expect(nse).not.toContain('.defaultRingtone');
    expect(nse).not.toContain('acceptCall=');
  });
});

describe('the ring and its photo', () => {
  const show = between(
    push,
    'internal fun showIncomingCallNotification(',
    'private fun buildIncomingCallNotification(',
    'showIncomingCallNotification'
  );

  it('arms the 60 s end before fetching the photo', () => {
    const expiry = show.indexOf('}, CALL_RING_TIMEOUT_MS)');
    const fetch = show.indexOf('context.fetchAvatar(');
    expect(expiry).toBeGreaterThan(0);
    expect(fetch).toBeGreaterThan(expiry);
  });

  it('fetches a photo only for a caller this phone named (decision 6)', () => {
    expect(show).toContain('val photoOf = if (name != null) callerId else ""');
    expect(show).toContain('context.fetchAvatar(photoOf)');
    expect(show).toMatch(/IncomingCallActivity\.intentFor\(context, callId, photoOf,/);
  });
});

describe('the native answer is a private intent carrying every fact the join needs', () => {
  // The webview joins on these facts alone (calls.md, "An answer from the ring joins on the ring's
  // facts"), and they reach it through a private file, never a parameter of a public link.
  const answer = read('android/app/src/main/java/fr/emse/canari/CallRingAnswer.kt');
  const main = read('android/app/src/main/java/fr/emse/canari/MainActivity.kt');

  it('Android: the answer link only navigates; the answer rides extras checked by a per-ring nonce', () => {
    const show = between(
      push,
      'internal fun showIncomingCallNotification(',
      'private fun buildIncomingCallNotification(',
      'showIncomingCallNotification'
    );
    expect(push).not.toContain('acceptCall');
    expect(show).toContain('setData(Uri.parse("fr.emse.canari://chat/$groupId"))');
    expect(show).toMatch(
      /CallRingAnswer\.record\(context, groupId, callId, callerId, hasVideo\)[\s\S]*?CallRingAnswer\.putAnswer\(this, callId, answerNonce\)/
    );
    // The pending accept is written from the RECORDED facts, only for the nonce its ring issued.
    const take = between(answer, 'fun takeAnswer(', 'private fun prefs(', 'takeAnswer');
    expect(take).toMatch(/entry\.optString\("nonce"\) != nonce[\s\S]*?return false/);
    expect(take).toContain('.put("groupId", entry.optString("groupId"))');
    expect(take).toContain('.put("acceptedAt", System.currentTimeMillis())');
    // Both doors of MainActivity hand the intent over, and the record dies with its ring.
    expect([...main.matchAll(/CallRingAnswer\.takeAnswer\(this, intent\)/g)]).toHaveLength(2);
    const cancel = between(
      push,
      'internal fun cancelIncomingCallNotification(',
      'Log.d(TAG, "cancelIncomingCallNotification',
      'cancelIncomingCallNotification'
    );
    expect(cancel).toContain('CallRingAnswer.forget(context, callId)');
  });

  it('iOS: the CallKit answer writes the caller into the pending accept; its link only navigates', () => {
    const answerMm = between(
      pushMm,
      'performAnswerCallAction:(CXAnswerCallAction *)action {',
      'performEndCallAction:',
      'performAnswerCallAction'
    );
    expect(answerMm).toContain('@"callerId" : callerId,');
    expect(answerMm).toContain('@"fr.emse.canari://chat/%@", groupId');
    expect(pushMm).not.toContain('acceptCall');
    // Both rings record the caller for it.
    expect([...pushMm.matchAll(/@"callerId" : callerId \?: @"",/g)]).toHaveLength(2);
  });

  it('iOS: the page is told the answer waits at the handover, never at the answer', () => {
    // K7/K8 on 1.5.2-alpha.2: a page PushKit launched in the background is already `visible`, so no
    // visibilitychange drains the file when the answer brings the app to the front.
    const setup = between(
      pushMm,
      'static void CanariCallKitSetup(void) {',
      '\n}\n',
      'CanariCallKitSetup'
    );
    // Queued behind the AnsweredElsewhere ends: once active, no CallKit End can cancel the answer.
    expect(setup).toMatch(
      /CanariEndCallKitCall\(callId, CXCallEndedReasonAnsweredElsewhere\);[\s\S]*?dispatch_async\(dispatch_get_main_queue\(\), \^\{\s*CanariTellPageOfPendingCallAccept\(\);/
    );
    const answer = between(
      pushMm,
      'performAnswerCallAction:(CXAnswerCallAction *)action {',
      '\n}\n',
      'performAnswerCallAction'
    );
    expect(answer).not.toContain('CanariTellPageOfPendingCallAccept');
    const tell = between(
      pushMm,
      'static void CanariTellPageOfPendingCallAccept(void) {',
      '\n}\n',
      'CanariTellPageOfPendingCallAccept'
    );
    expect(tell).toContain('fileExistsAtPath:');
    expect(tell).toContain("new CustomEvent('canari:call-accept')");
    // The page drains on that event.
    const service = readFileSync(
      resolve(here, '../components/layout/ChatBackgroundService.svelte'),
      'utf8'
    );
    expect(service).toMatch(
      /const handleNativeCallAccept = \(\) => \{[\s\S]*?void drainNativePendingCallAccept\(\);/
    );
    expect(service).toContain(
      "window.addEventListener('canari:call-accept', handleNativeCallAccept);"
    );
    expect(service).toContain(
      "window.removeEventListener('canari:call-accept', handleNativeCallAccept);"
    );
  });
});

describe('a decline on the ring reaches the caller', () => {
  const receiver = read(
    'android/app/src/main/java/fr/emse/canari/CanariNotificationActionReceiver.kt'
  );

  it('Android: Decline sends the in-app hangup, once, never through the outbox mirror', () => {
    const decline = between(
      receiver,
      'private fun handleCallDecline(',
      '\n    }\n}',
      'handleCallDecline'
    );
    expect(decline).toContain('nativeBuildCallHangupProto(');
    expect(decline).toContain('CALL_END_REASON_DECLINED');
    expect(decline).toContain('sendTransportFrameNow(');
    expect(decline).not.toContain('enqueueOutboxMirror');
    // The ring stops before anything is sent.
    expect(decline.indexOf('cancelIncomingCallNotification')).toBeLessThan(
      decline.indexOf('sendTransportFrameNow(')
    );
    const send = between(
      push,
      'internal fun sendTransportFrameNow(',
      '/** The body of [drainOutboxBackground]',
      'sendTransportFrameNow'
    );
    expect(send).toContain('silent = true, durable = false');
    expect(send).not.toContain('rewriteOutboxMirror');
  });

  it("Android: the call screen's Decline fires the same intent", () => {
    // The screen is handed the notification's own decline PendingIntent and only sends it.
    expect(push).toMatch(/IncomingCallActivity\.intentFor\([^)]*answerPending, declinePending\)/);
    expect(screen).toMatch(
      /private fun onDecline\(decline: PendingIntent\) \{[\s\S]*?decline\.send\(\)/
    );
  });

  it('iOS: the CallKit End sends it, and an End after the answer also cancels that answer', () => {
    const end = between(
      pushMm,
      'performEndCallAction:(CXEndCallAction *)action {',
      '@end',
      'performEndCallAction'
    );
    expect(end).toMatch(/if \(answered\) \{\s*CanariCancelPendingCallAccept\(callId\);\s*\}/);
    expect(end).toMatch(/if \(info != nil\) \{[\s\S]*?CanariSendCallDecline\(/);
    const cancel = between(
      pushMm,
      'static void CanariCancelPendingCallAccept(',
      '\n}\n',
      'CanariCancelPendingCallAccept'
    );
    // Only the answer of THIS call is removed.
    expect(cancel).toMatch(/isEqualToString:callId[\s\S]*?removeItemAtPath/);
    const answer = between(
      pushMm,
      'performAnswerCallAction:(CXAnswerCallAction *)action {',
      'performEndCallAction:',
      'performAnswerCallAction'
    );
    expect(answer).toContain('answered[@"answered"] = @YES;');
    const send = between(
      pushMm,
      'static void CanariSendCallDecline(',
      '\n}\n',
      'CanariSendCallDecline'
    );
    expect(send).toContain('canari_native_build_call_hangup_proto(');
    expect(send).toContain('entry.durable = NO;');
    expect(send).not.toContain('CanariRewriteOutboxMirror');
  });
});

describe('Answer may start the app from the call screen', () => {
  it('sends with a background-start mode chosen by SDK level', () => {
    const send = between(
      screen,
      'private fun sendAnswer(answer: PendingIntent)',
      'private fun onDecline(',
      'sendAnswer'
    );
    expect(send).toMatch(/sdk >= 36[\s\S]*?MODE_BACKGROUND_ACTIVITY_START_ALLOW_IF_VISIBLE/);
    expect(send).toContain('MODE_BACKGROUND_ACTIVITY_START_ALLOWED');
    expect(send).toContain('setPendingIntentBackgroundActivityStartMode(mode)');
    expect(send).toContain('answer.send(options.toBundle())');
  });
});
