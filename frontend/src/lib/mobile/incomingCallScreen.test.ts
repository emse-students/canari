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
 * - an iPhone whose app is open does not ring twice (CallKit over the in-app overlay).
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../../src-tauri/gen');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');
const push = read('android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt');
const screen = read('android/app/src/main/java/fr/emse/canari/IncomingCallActivity.kt');
const pushMm = read('apple/Sources/canari/canari_push.mm');

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

  it('a second call while it shows replaces it (singleTop)', () => {
    expect(screen).toContain('override fun onNewIntent(intent: Intent)');
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
});
