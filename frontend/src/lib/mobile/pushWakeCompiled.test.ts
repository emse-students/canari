import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUSH_WAKE_COMPILED } from '$lib/features';

/**
 * A REGISTRATION THAT SAYS `wake: true` IS A PROMISE THE NATIVE CODE KEEPS - and nothing compiles
 * the two together. The server sends a content-free wake-up push to a device ONLY when its
 * registration declared it (`push_token.wakeCapable`); a binary that declared it without a handler
 * would receive frames carrying nothing it could draw. So while `PUSH_WAKE_COMPILED` is on, each of
 * the three native receivers must branch on the wake type and fetch the one route that answers it
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
  it('is declared by this build', () => {
    expect(PUSH_WAKE_COMPILED).toBe(true);
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

  it('the iOS extension dispatches it, and re-enters the same switch with what it fetched', () => {
    const nse = read(NSE);
    expect(nse).toMatch(/case "wake":\s*handleWake\(/);
    expect(nse).toContain('/api/mls/push/wake');
    expect(nse).toContain('dispatch(type: type, userInfo: merged, content: content)');
  });

  it('the iOS app fetches a silent one and hands it to the same background allowlist', () => {
    const app = read(IOS_APP);
    expect(app).toMatch(
      /isEqualToString:@"wake"\]\) \{\s*CanariHandleWakeBackgroundFrame\(data, done\);/
    );
    expect(app).toContain('/api/mls/push/wake');
    expect(app).toContain('CanariHandleBackgroundFrame(fields, done);');
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
