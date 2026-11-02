import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUSH_WAKE_DECLARED } from '$lib/features';

/**
 * A REGISTRATION THAT SAYS `wake: true` IS A PROMISE THE NATIVE CODE KEEPS - and nothing compiles
 * the two together. The server sends a content-free wake-up push to a device ONLY when its
 * registration declared it (`push_token.wakeCapable`); a binary that declared it without a handler
 * would receive frames carrying nothing it could draw. So for every platform `PUSH_WAKE_DECLARED`
 * declares, its native receivers must branch on the wake type and fetch the one route that answers it
 * (docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md). Read as TEXT: Kotlin,
 * Swift and Objective-C++ are compiled only by their own toolchains.
 */
const tauri = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src-tauri');
const read = (path: string) => readFileSync(join(tauri, path), 'utf8');

const ANDROID = 'gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt';
const ANDROID_ANSWER = 'gen/android/app/src/main/java/fr/emse/canari/push/WakeAnswer.kt';
const NSE = 'gen/apple/canari_NSE/NotificationService.swift';
const IOS_APP = 'gen/apple/Sources/canari/canari_push.mm';

describe('the wake-up push the registration promises', () => {
  it('is declared on Android, and NOT on iOS until its notification P1 is closed (owner, 2026-11-02)', () => {
    expect(PUSH_WAKE_DECLARED).toEqual({ android: true, ios: false });
  });

  it('the Android service branches on it before anything else and fetches the wake route', () => {
    const service = read(ANDROID);
    expect(read(ANDROID_ANSWER)).toContain('const val WAKE_TYPE = "wake"');
    const received = service.slice(service.indexOf('override fun onMessageReceived('));
    // The wake branch comes before the dispatcher, which every other type goes through.
    expect(received.indexOf('WakeAnswer.WAKE_TYPE')).toBeGreaterThan(0);
    expect(received.indexOf('WakeAnswer.WAKE_TYPE')).toBeLessThan(
      received.indexOf('dispatchPush(data)')
    );
    expect(service).toContain('/api/mls/push/wake');
    // A fetched frame goes through the same dispatcher, never a second handler.
    expect(service).toContain('dispatchPush(outcome.fields)');
  });

  it('the Android fetch runs OFF the MLS lane, and every push reaches the lane in arrival order', () => {
    const service = read(ANDROID);
    const wake = service.slice(
      service.indexOf('private fun onWakePush('),
      service.indexOf('private fun onWakeFetched(')
    );
    // The round trip is on the fetch pool; the lane only ever sees the released, ordered action.
    expect(wake).toContain('WAKE_FETCH_POOL.execute');
    expect(wake).toContain('val ticket = WAKE_ORDER.arrive(');
    expect(wake).toContain('fetchWakeFrameWithinDeadline(queuedMessageId, silent, remainingMs)');
    // The ticket is settled on every path, the unschedulable fetch included.
    expect(wake).toMatch(/finally \{\s*settle\(outcome\)/);
    expect(wake).toMatch(/catch \(e: RejectedExecutionException\) \{[\s\S]*settle\(/);
    // EVERY push bound for the lane takes its turn in the same order (a full push included).
    const runner = service.slice(service.indexOf('private fun runSerializedWithWakeLock('));
    expect(runner.slice(0, 2500)).toContain('WAKE_ORDER.inOrder {');
    expect(service.match(/MLS_PUSH_LANE\.execute/g)).toHaveLength(1);
    // A failure for a mentions-only conversation is posted silently, under one id for all of them.
    expect(service).toContain('.setSilent(mentionsOnly || callHoldsSound())');
    expect(service).toContain('val notifId = WAKE_UNAVAILABLE_NOTIF_ID');
  });

  it('only the re-queue of the SAME frame bypasses the order; new lane work takes a ticket (F3)', () => {
    const service = read(ANDROID);
    const runner = service.slice(
      service.indexOf('private fun runSerializedWithWakeLock('),
      service.indexOf('private fun executeOnLane(')
    );
    // The one bypass needs BOTH: the same-frame flag and the lane's own thread.
    expect(runner).toMatch(
      /if \(requeueOfThisFrame && Thread\.currentThread\(\) === mlsLaneThread\)/
    );
    expect(runner).toContain('WAKE_ORDER.inOrder {');
    // The two same-frame re-queues say so; the key-group join a banner spawns does not.
    expect(service.match(/requeueOfThisFrame = true/g)).toHaveLength(2);
    expect(service).toMatch(
      /runSerializedWithWakeLock\("fcm_decrypt", requeueOfThisFrame = true\)/
    );
    expect(service).toMatch(
      /runSerializedWithWakeLock\("fcm_channel", requeueOfThisFrame = true\)/
    );
    expect(service).toMatch(/runSerializedWithWakeLock\("key_group_join", 90_000L\) \{/);
  });

  it('a Welcome is counted on its way to the lane, at release, before the batch hands anything over (F2)', () => {
    const service = read(ANDROID);
    // Counted by the hook, not at arrival.
    expect(service).toMatch(
      /"welcome_join", 90_000L,\s*onLane = \{ WELCOMES_ON_LANE\.merge\(groupId, 1, Int::plus\) \}/
    );
    expect(service).not.toMatch(
      /WELCOMES_ON_LANE\.merge\(groupId, 1, Int::plus\)\s*runSerializedWithWakeLock\("welcome_join"/
    );
    const lane = service.slice(service.indexOf('private fun executeOnLane('));
    const body = lane.slice(0, lane.indexOf('\n    }\n'));
    // The count, then the hand-off through the batch, then the executor.
    expect(body.indexOf('onLane()')).toBeLessThan(body.indexOf('WAKE_ORDER.handOff {'));
    expect(body.indexOf('WAKE_ORDER.handOff {')).toBeLessThan(
      body.indexOf('MLS_PUSH_LANE.execute {')
    );
    // A wake lock that cannot be taken never skips the block whose finally releases the count.
    expect(body).toMatch(
      /var wl: PowerManager\.WakeLock\? = null\s*try \{\s*\/\/[\s\S]*?wl\.acquire\(timeoutMs\)\s*\} catch/
    );
  });

  it('the iOS extension dispatches it, and re-enters the same switch with what it fetched', () => {
    const nse = read(NSE);
    expect(nse).toMatch(/case "wake":\s*handleWake\(/);
    expect(nse).toContain('/api/mls/push/wake');
    expect(nse).toContain('dispatch(type: type, userInfo: merged, content: content)');
    // The run becomes the fetched frame's kind first, so [NSE_OUTCOME] keeps message vs channel.
    const fetched = nse.slice(nse.indexOf('case .frame(let fields):'));
    expect(fetched.indexOf('trace?.rekind(type)')).toBeGreaterThan(0);
    expect(fetched.indexOf('trace?.rekind(type)')).toBeLessThan(fetched.indexOf('dispatch(type:'));
    // Every failure cause is letter-only: an HTTP status is named, never written as its digits.
    expect(nse).not.toMatch(/\.failed\("http-\\\(status\)"\)/);
    expect(nse).toContain('noteCause("wake-\\(stage)")');
  });

  it('the iOS app fetches a silent one and hands it to the same background allowlist', () => {
    const app = read(IOS_APP);
    expect(app).toMatch(
      /isEqualToString:@"wake"\]\) \{\s*CanariHandleWakeBackgroundFrame\(data, done\);/
    );
    expect(app).toContain('/api/mls/push/wake');
    expect(app).toContain('CanariHandleBackgroundFrame(fields, done);');
    // Signed out is checked before anything is read, as every other reader of the mirror does.
    const helper = app.slice(
      app.indexOf('static void CanariHandleWakeBackgroundFrame(NSDictionary *data, void (^done)')
    );
    expect(helper.indexOf('CanariPushSignedOut()')).toBeGreaterThan(0);
    expect(helper.indexOf('CanariPushSignedOut()')).toBeLessThan(
      helper.indexOf('CanariRetrievePushSecret()')
    );
  });

  it('every failure is drawn as not loaded, in both languages, never as the generic text', () => {
    const fr = read('gen/android/app/src/main/res/values/strings.xml');
    const en = read('gen/android/app/src/main/res/values-en/strings.xml');
    for (const table of [fr, en]) expect(table).toContain('name="notif_wake_unavailable"');
    for (const lang of ['fr', 'en']) {
      const strings = read(`gen/apple/canari_NSE/${lang}.lproj/Localizable.strings`);
      expect(strings).toContain('"notif.wake.unavailable"');
      expect(strings).toContain('"notif.wake.gone"');
    }
  });
});
