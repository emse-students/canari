import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE FIVE SWITCHES OF THE CALLS REVIVAL, ASSERTED AGAINST ONE FACT: `CALLS_COMPILED`.
 *
 * Calling as the store binaries carry it is spelled in five places, because three of them run where
 * no webview exists and two are read by a store rather than by code:
 *
 * | Switch | File | Read by |
 * |---|---|---|
 * | `CALLS_COMPILED` | `features.ts` | the app - THE fact the four others follow |
 * | `CALLS_ENABLED` | `CanariFirebaseMessagingService.kt` | the Android push service (`showIncomingCallNotification`) |
 * | `kCanariCallsEnabled` | `canari_push.mm` | the PushKit registry and the CallKit provider, installed at process start |
 * | `voip` | `canari_iOS/Info.plist` `UIBackgroundModes` | iOS (no PushKit token without it) and App Review |
 * | `USE_FULL_SCREEN_INTENT` | `AndroidManifest.xml` | Android (the locked-screen CallStyle ring) and Play |
 *
 * Each cuts both ways: declared but unused is a store rejection (App Review refused `voip` under
 * guideline 2.5.4 on 2026-08-31), used but undeclared cannot work (no PushKit token, no full-screen
 * ring). So the assertion is AGREEMENT, never a hard-coded "off": the revival commit flips five
 * values and this file follows it without being edited - and a revival that moved four of five
 * fails here, naming the one it forgot. The microphone purpose string goes with them: App Review
 * reads it, and it must name calls exactly when the binary can place one.
 *
 * Every value is read as TEXT. The native files are not built by this suite, so this proves what is
 * written, not what runs - the revival's hardware rows are what prove the second.
 * See docs/wiki/frontend/modules/calls.md.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(here, '../../../src-tauri');
const APPLE = resolve(SRC_TAURI, 'gen/apple');
const ANDROID_MAIN = resolve(SRC_TAURI, 'gen/android/app/src/main');

const read = (path: string) => readFileSync(path, 'utf8');
const features = read(resolve(here, '../features.ts'));
const pushService = read(
  resolve(ANDROID_MAIN, 'java/fr/emse/canari/CanariFirebaseMessagingService.kt')
);
const manifest = read(resolve(ANDROID_MAIN, 'AndroidManifest.xml'));
const pushMm = read(resolve(APPLE, 'Sources/canari/canari_push.mm'));
const infoPlist = read(resolve(APPLE, 'canari_iOS/Info.plist'));

/** The one capture group of `pattern` in `src`, or fail naming what went missing. */
function captured(src: string, pattern: RegExp, what: string): string {
  const match = src.match(pattern);
  expect(match, `${what} was renamed or removed`).not.toBeNull();
  return match![1];
}

/** THE fact. Read as text, as the others are: importing `features.ts` would evaluate its env. */
const COMPILED =
  captured(features, /export const CALLS_COMPILED = (true|false);/, 'CALLS_COMPILED') === 'true';

/** The <string> entries of the UIBackgroundModes array, without the comments around them. */
function backgroundModes(): string[] {
  const array = captured(
    infoPlist,
    /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/,
    'the UIBackgroundModes array'
  );
  return [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

/** Every `<uses-permission .../>` TAG. Never a substring: the comment that replaced one names it. */
function permissionTags(): string[] {
  const tags = manifest.match(/<uses-permission\s[^>]*\/>/g) ?? [];
  // An empty list would make every "absent" below pass - the false green durable-rules records.
  expect(tags.length, 'no <uses-permission> tag parsed from the manifest').toBeGreaterThan(0);
  return tags;
}

/** The microphone purpose string in the base Info.plist and in each localized InfoPlist.strings. */
function microphonePurposes(): { where: string; text: string }[] {
  const base = captured(
    infoPlist,
    /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]*)<\/string>/,
    'NSMicrophoneUsageDescription in Info.plist'
  );
  const out = [{ where: 'Info.plist', text: base }];
  for (const lang of ['fr', 'en']) {
    const strings = read(resolve(APPLE, `canari_iOS/${lang}.lproj/InfoPlist.strings`));
    out.push({
      where: `${lang}.lproj`,
      text: captured(
        strings,
        /"NSMicrophoneUsageDescription"\s*=\s*"([^"]*)";/,
        `NSMicrophoneUsageDescription in ${lang}.lproj`
      ),
    });
  }
  return out;
}

describe(`the five calls switches agree with CALLS_COMPILED (= ${COMPILED})`, () => {
  it('the Kotlin CALLS_ENABLED', () => {
    // The push service runs when no webview exists and cannot read features.ts. What it mirrors
    // is the store binaries' calling (CALLS_COMPILED), not the dev builds' in-app calls.
    const kotlin = captured(
      pushService,
      /private const val CALLS_ENABLED = (true|false)/,
      'the Kotlin CALLS_ENABLED'
    );
    expect(kotlin === 'true', 'CanariFirebaseMessagingService.kt CALLS_ENABLED').toBe(COMPILED);
    // A second declaration was once added by hand; Kotlin refuses the file, six minutes later.
    expect(pushService.split('private const val CALLS_ENABLED').length - 1).toBe(1);
  });

  it('the ObjC kCanariCallsEnabled', () => {
    const objc = captured(
      pushMm,
      /static const BOOL kCanariCallsEnabled = (YES|NO);/,
      'kCanariCallsEnabled'
    );
    expect(objc === 'YES', 'canari_push.mm kCanariCallsEnabled').toBe(COMPILED);
  });

  it('the voip background mode', () => {
    // Parsed entries, never a substring: the comment that replaced the entry contains the word.
    expect(backgroundModes().includes('voip'), 'Info.plist UIBackgroundModes voip').toBe(COMPILED);
  });

  it('the USE_FULL_SCREEN_INTENT permission', () => {
    const declared = permissionTags().some((t) => t.includes('USE_FULL_SCREEN_INTENT'));
    expect(declared, 'AndroidManifest.xml USE_FULL_SCREEN_INTENT').toBe(COMPILED);
  });

  it('the microphone purpose string names calls exactly when calls are compiled', () => {
    for (const { where, text } of microphonePurposes()) {
      expect(/appel|call/i.test(text), `NSMicrophoneUsageDescription (${where}): "${text}"`).toBe(
        COMPILED
      );
    }
  });
});

describe('what the calls switches must never take with them', () => {
  it('keeps the push background modes the rest of the app depends on', () => {
    // Separates "voip moved" from "someone trimmed the array": message delivery needs these two.
    expect(backgroundModes()).toEqual(expect.arrayContaining(['remote-notification', 'fetch']));
  });

  it('keeps the ring channels declared, so a revival needs no notification-settings migration', () => {
    expect(pushService).toMatch(/CHANNEL_CALLS\s*=\s*"canari_calls"/);
    expect(pushService).toMatch(/CHANNEL_MENTIONS\s*=\s*"canari_mentions_v2"/);
  });

  it('gates the native rings at their single choke points, on the switch', () => {
    // Off, a peer still sends call_ring; these are the two places it must stop.
    expect(pushService).toMatch(/if \(!CALLS_ENABLED\) \{/);
    expect(pushService).toContain('showIncomingCallNotification: calls disabled');
    expect(pushMm).toContain('calls disabled - not reporting incoming call');
    expect(pushMm).toMatch(/if \(kCanariCallsEnabled\) \{\s*CanariCallKitSetup\(\);/);
  });
});
