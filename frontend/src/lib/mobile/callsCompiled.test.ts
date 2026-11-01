import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE CALLS SWITCHES OF THE STORE BINARIES, ASSERTED AGAINST TWO FACTS (since 2026-10-21, B2').
 *
 * The owner decided on 2026-10-21 that the first production calls are audio 1:1 WITHOUT the native
 * ring, so what used to be one fact is two, each with the switches that follow it:
 *
 * | Switch | File | Follows | Read by |
 * |---|---|---|---|
 * | `CALLS_COMPILED` | `features.ts` | - | the app: in-app calls and the call kept alive in the background |
 * | `audio` | `canari_iOS/Info.plist` `UIBackgroundModes` | `CALLS_COMPILED` | WKWebView (it mutes a hidden page's microphone without it) and App Review |
 * | the microphone purpose string | `Info.plist`, `fr.lproj`, `en.lproj` | `CALLS_COMPILED` | App Review: it must name calls exactly when the binary can place one |
 * | the camera purpose string | `Info.plist`, `fr.lproj`, `en.lproj`, `project.yml` | `CALLS_VIDEO_ENABLED` in a store binary (1.5.2) | App Review: it must name calls exactly when a call can open the camera |
 * | `CALLS_NATIVE_RING_COMPILED` | `features.ts` | - | the ring of an app that is closed or in the background |
 * | `CALLS_ENABLED` | `CanariFirebaseMessagingService.kt` | the ring | the Android push service (`showIncomingCallNotification`) |
 * | `kCanariCallsEnabled` | `canari_push.mm` | the ring | the PushKit registry and the CallKit provider, installed at process start |
 * | `voip` | `canari_iOS/Info.plist` `UIBackgroundModes` | the ring | iOS (no PushKit token without it) and App Review |
 * | `USE_FULL_SCREEN_INTENT` | `AndroidManifest.xml` | the ring | Android (the locked-screen CallStyle ring) and Play |
 *
 * The Android microphone foreground service follows `CALLS_COMPILED` too, asserted in
 * `androidCallServiceManifest.test.ts`. The microphone purpose string is written so that a later
 * lives flip only APPENDS to it (docs/wiki/frontend/modules/live-production.md).
 *
 * Each cuts both ways: declared but unused is a store rejection (App Review refused `voip` under
 * guideline 2.5.4 on 2026-08-31), used but undeclared cannot work (no PushKit token, no full-screen
 * ring). So the assertion is AGREEMENT, never a hard-coded "off": a flip moves its group's values
 * and this file follows it without being edited - and a flip that forgot one fails here, naming it.
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
const iosWorkflow = read(resolve(here, '../../../../.github/workflows/ios.yml'));
const androidGradle = read(resolve(SRC_TAURI, 'gen/android/app/build.gradle.kts'));

/** The one capture group of `pattern` in `src`, or fail naming what went missing. */
function captured(src: string, pattern: RegExp, what: string): string {
  const match = src.match(pattern);
  expect(match, `${what} was renamed or removed`).not.toBeNull();
  return match![1];
}

/** The two facts. Read as text, as the others are: importing `features.ts` would evaluate its env. */
const COMPILED =
  captured(features, /export const CALLS_COMPILED = (true|false);/, 'CALLS_COMPILED') === 'true';
const RING =
  captured(
    features,
    /export const CALLS_NATIVE_RING_COMPILED = (true|false);/,
    'CALLS_NATIVE_RING_COMPILED'
  ) === 'true';
/**
 * Whether a STORE binary carries video. `CALLS_VIDEO_ENABLED` is an expression, not a literal: it
 * is `CALLS_ENABLED` since 1.5.2 (a production build then carries video exactly when it can call),
 * and was `deployEnvironment() === 'development'` before (dev only, so never a store binary). Any
 * other expression fails here rather than being guessed at.
 */
const VIDEO = (() => {
  const expression = captured(
    features,
    /export const CALLS_VIDEO_ENABLED = ([^;]+);/,
    'CALLS_VIDEO_ENABLED'
  ).trim();
  if (expression === 'CALLS_ENABLED') return COMPILED;
  expect(expression, 'CALLS_VIDEO_ENABLED is an expression this test cannot read').toBe(
    "deployEnvironment() === 'development'"
  );
  return false;
})();

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

/** A purpose string in the base Info.plist and in each localized InfoPlist.strings. */
function purposes(key: string): { where: string; text: string }[] {
  const base = captured(
    infoPlist,
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
    `${key} in Info.plist`
  );
  const out = [{ where: 'Info.plist', text: base }];
  for (const lang of ['fr', 'en']) {
    const strings = read(resolve(APPLE, `canari_iOS/${lang}.lproj/InfoPlist.strings`));
    out.push({
      where: `${lang}.lproj`,
      text: captured(strings, new RegExp(`"${key}"\\s*=\\s*"([^"]*)";`), `${key} in ${lang}.lproj`),
    });
  }
  return out;
}

const microphonePurposes = () => purposes('NSMicrophoneUsageDescription');
const cameraPurposes = () => purposes('NSCameraUsageDescription');

describe('the two facts', () => {
  it('never ring a phone whose binary cannot answer: the native ring implies CALLS_COMPILED', () => {
    expect(!RING || COMPILED, 'CALLS_NATIVE_RING_COMPILED is on while CALLS_COMPILED is off').toBe(
      true
    );
  });
});

describe(`the native ring's four switches agree with CALLS_NATIVE_RING_COMPILED (= ${RING})`, () => {
  it('the Kotlin CALLS_ENABLED', () => {
    // The push service runs when no webview exists and cannot read features.ts. What it gates is
    // the native ring (`showIncomingCallNotification`), so it mirrors the ring's fact.
    const kotlin = captured(
      pushService,
      /private const val CALLS_ENABLED = (true|false)/,
      'the Kotlin CALLS_ENABLED'
    );
    expect(kotlin === 'true', 'CanariFirebaseMessagingService.kt CALLS_ENABLED').toBe(RING);
    // A second declaration was once added by hand; Kotlin refuses the file, six minutes later.
    expect(pushService.split('private const val CALLS_ENABLED').length - 1).toBe(1);
  });

  it('the ObjC kCanariCallsEnabled', () => {
    const objc = captured(
      pushMm,
      /static const BOOL kCanariCallsEnabled = (YES|NO);/,
      'kCanariCallsEnabled'
    );
    expect(objc === 'YES', 'canari_push.mm kCanariCallsEnabled').toBe(RING);
  });

  it('the voip background mode', () => {
    // Parsed entries, never a substring: the comment that replaced the entry contains the word.
    expect(backgroundModes().includes('voip'), 'Info.plist UIBackgroundModes voip').toBe(RING);
  });

  it('the voip background mode in project.yml too, which an xcodegen run writes the plist from', () => {
    const projectYml = read(resolve(APPLE, 'project.yml'));
    const list = captured(
      projectYml,
      /UIBackgroundModes: \[([^\]]*)\]/,
      'UIBackgroundModes in project.yml'
    );
    expect(
      list
        .split(',')
        .map((s) => s.trim())
        .includes('voip'),
      'project.yml UIBackgroundModes voip'
    ).toBe(RING);
  });

  it('the USE_FULL_SCREEN_INTENT permission', () => {
    const declared = permissionTags().some((t) => t.includes('USE_FULL_SCREEN_INTENT'));
    expect(declared, 'AndroidManifest.xml USE_FULL_SCREEN_INTENT').toBe(RING);
  });
});

describe(`in-app calls and the background follow CALLS_COMPILED (= ${COMPILED})`, () => {
  it('the audio background mode', () => {
    // WP-C-BG-I: without it WKWebView mutes the microphone of a hidden page, so a stable that can
    // call needs it, and one that cannot must not declare it (2.5.4).
    expect(backgroundModes().includes('audio'), 'Info.plist UIBackgroundModes audio').toBe(
      COMPILED
    );
  });

  it('the microphone purpose string names calls exactly when calls are compiled', () => {
    // Whole words: a substring match would read "rappel" or "locally" as naming calls.
    for (const { where, text } of microphonePurposes()) {
      expect(
        /\b(appels?|calls?)\b/i.test(text),
        `NSMicrophoneUsageDescription (${where}): "${text}"`
      ).toBe(COMPILED);
    }
  });
});

describe(`video calls follow CALLS_VIDEO_ENABLED in a store binary (= ${VIDEO})`, () => {
  it('never compiles video into a binary that cannot call', () => {
    expect(!VIDEO || COMPILED).toBe(true);
  });

  it('the camera purpose string names calls exactly when a store binary carries video', () => {
    // App Review reads a purpose string as the list of uses (5.1.1): a camera opened by a call must
    // be named, and one that no call can open must not be.
    for (const { where, text } of cameraPurposes()) {
      expect(
        /\b(appels?|calls?)\b/i.test(text),
        `NSCameraUsageDescription (${where}): "${text}"`
      ).toBe(VIDEO);
    }
  });
});

/** Whether a workflow line WRITES the UIBackgroundModes array (a read-only Print does not). */
function writesBackgroundModes(line: string): boolean {
  return (
    /\b(Add|Set|Delete|Merge|Import|Clear)\s+:UIBackgroundModes/.test(line) ||
    /plutil\s+-(insert|replace|remove)\s+UIBackgroundModes/.test(line)
  );
}

describe('the committed files are the ONLY carriers: no build step patches a call switch in', () => {
  // Before the flip a pre-release got `audio` from a PlistBuddy branch of ios.yml and the Android
  // service from a gradle overlay on VITE_DEPLOY_ENVIRONMENT. Both are deleted: a build that
  // differs from the committed files is a build the tests above did not read.
  it('ios.yml WRITES no UIBackgroundModes entry (it may print the built ones)', () => {
    // Write commands only: PlistBuddy Add/Set/Delete/Merge/Import and plutil insert/replace/remove.
    // A read-only `Print :UIBackgroundModes` is the CI step that shows what the archive declares.
    const writes = iosWorkflow.split('\n').filter((line) => writesBackgroundModes(line));
    expect(writes, 'ios.yml writes UIBackgroundModes').toEqual([]);
  });

  it('the write detector bites: synthetic write lines are caught, a Print is not', () => {
    // Guards the guard: a lost backslash once made the pattern match nothing, and every ios.yml passed.
    expect(
      writesBackgroundModes(
        '/usr/libexec/PlistBuddy -c "Add :UIBackgroundModes:0 string audio" "$PLIST"'
      )
    ).toBe(true);
    expect(
      writesBackgroundModes('/usr/libexec/PlistBuddy -c "Set :UIBackgroundModes:1 audio" "$PLIST"')
    ).toBe(true);
    expect(writesBackgroundModes('plutil -insert UIBackgroundModes -array "$PLIST"')).toBe(true);
    expect(
      writesBackgroundModes('/usr/libexec/PlistBuddy -c "Print :UIBackgroundModes" "$PLIST"')
    ).toBe(false);
  });

  it('ios.yml prints the built background modes and microphone string, read-only', () => {
    expect(iosWorkflow).toContain('Print :UIBackgroundModes" "$BUILT_PLIST"');
    expect(iosWorkflow).toContain('Print :NSMicrophoneUsageDescription" "$BUILT_PLIST"');
  });

  it('build.gradle.kts merges no calls overlay', () => {
    expect(androidGradle).not.toContain('src/calls/');
    expect(androidGradle).not.toContain('VITE_DEPLOY_ENVIRONMENT');
  });
});

describe('the generic ring alert of an iPhone with no VoIP token is filed, not overwritten', () => {
  const nse = read(resolve(APPLE, 'canari_NSE/NotificationService.swift'));

  /** The text from `start` up to the next `end` after it, or fail naming what went missing. */
  function between(src: string, start: string, end: string, what: string): string {
    const from = src.indexOf(start);
    expect(from, `${what} was renamed or removed`).toBeGreaterThanOrEqual(0);
    const to = src.indexOf(end, from + start.length);
    expect(to, `the end of ${what} was not found`).toBeGreaterThan(from);
    return src.slice(from, to);
  }

  it('the extension has a call_ring case that never reaches the MLS ladder', () => {
    // Without it the type falls to handleMlsMessage, which replaces the server's "Appel entrant"
    // with the encrypted-message fallback and adds message buttons.
    const branch = between(nse, 'case "call_ring":', 'case "social"', 'the call_ring case');
    expect(branch).toContain('applyGenericCallRing');
    expect(branch).toContain('finish()');
    expect(branch).not.toContain('handleMlsMessage');
  });

  it('keeps the server wording, files it under its conversation and opens it without answering', () => {
    const body = between(
      nse,
      'private func applyGenericCallRing(',
      '/// Writes a server-sent',
      'applyGenericCallRing'
    );
    expect(body).not.toMatch(/content\.(title|body|subtitle) =/);
    expect(body).toContain('content.threadIdentifier = groupId');
    expect(body).toContain('Self.chatLink(groupId)');
    expect(body).not.toContain('acceptCall');
    expect(body).toContain('.timeSensitive');
    expect(body).toContain('content.userInfo["canariCallId"] = callId');
  });

  it('call_ring_end takes the delivered alert off the lock screen', () => {
    const end = between(
      pushMm,
      '@"call_ring_end"]) {',
      'BOOL isWelcome',
      'the call_ring_end branch'
    );
    expect(end).toContain('removeDeliveredNotificationsWithIdentifiers');
    expect(end).toContain('canariCallId');
  });

  it('app activation clears the banner too: its deep link is the chat prefix the sweep matches', () => {
    expect(pushMm).toContain('[deepLink hasPrefix:@"fr.emse.canari://chat"]');
    expect(nse).toContain('"fr.emse.canari://chat/\\(prefix)\\(id)"');
  });
});

describe('project.yml repeats the plist declarations, so an xcodegen run cannot drop them', () => {
  const projectYml = read(resolve(APPLE, 'project.yml'));

  it('the same background modes, in the same order', () => {
    const list = captured(
      projectYml,
      /UIBackgroundModes: \[([^\]]*)\]/,
      'UIBackgroundModes in project.yml'
    );
    expect(list.split(',').map((s) => s.trim())).toEqual(backgroundModes());
  });

  it('the same microphone purpose string', () => {
    const text = captured(
      projectYml,
      /NSMicrophoneUsageDescription: (.*)\r?\n/,
      'NSMicrophoneUsageDescription in project.yml'
    );
    expect(text.trim()).toBe(microphonePurposes()[0].text);
  });

  it('the same camera purpose string', () => {
    const text = captured(
      projectYml,
      /NSCameraUsageDescription: (.*)\r?\n/,
      'NSCameraUsageDescription in project.yml'
    );
    expect(text.trim()).toBe(cameraPurposes()[0].text);
  });
});

describe('what the calls switches must never take with them', () => {
  it('keeps the push background modes the rest of the app depends on', () => {
    // Separates "voip moved" from "someone trimmed the array": message delivery needs these two.
    expect(backgroundModes()).toEqual(expect.arrayContaining(['remote-notification', 'fetch']));
  });

  it('keeps the ring channels declared, so a revival needs no notification-settings migration', () => {
    expect(pushService).toMatch(
      /CHANNEL_CALLS\s*=\s*fr\.emse\.canari\.call\.IncomingRing\.CHANNEL_ID/
    );
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
