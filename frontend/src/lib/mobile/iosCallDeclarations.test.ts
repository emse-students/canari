import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * iOS twin of the `USE_FULL_SCREEN_INTENT` guardrail in androidFcmManifest.test.ts.
 *
 * `tauri ios init` regenerates `gen/apple`, and a regenerated Info.plist is the exact way the `voip`
 * background mode comes back without anyone deciding it should. It may not: App Review refused that
 * declaration under guideline 2.5.4 on 2026-08-31 for a VoIP service it could not locate, and while
 * CALLS_ENABLED holds calling off there is genuinely none to find. The declaration and the feature
 * move together or not at all - see docs/wiki/frontend/modules/calls.md.
 */
const here = dirname(fileURLToPath(import.meta.url));
const APPLE = resolve(here, '../../../src-tauri/gen/apple');

const infoPlist = readFileSync(resolve(APPLE, 'canari_iOS/Info.plist'), 'utf8');
const pushMm = readFileSync(resolve(APPLE, 'Sources/canari/canari_push.mm'), 'utf8');

/** The <string> entries of the UIBackgroundModes array, without the comments around them. */
function backgroundModes(): string[] {
  const array = infoPlist.match(/<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/);
  expect(array, 'UIBackgroundModes array not found in Info.plist').not.toBeNull();
  return [...array![1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

describe('iOS call declarations while calls are held off', () => {
  it('declares no voip background mode', () => {
    // Read as parsed entries, never as a substring of the file: the comment that replaced the entry
    // still contains the word, and `toContain` would pass on it.
    expect(backgroundModes()).not.toContain('voip');
  });

  it('keeps the push background modes the rest of the app depends on', () => {
    // The hold must not cost message delivery: this is what separates "voip removed" from
    // "someone trimmed the array".
    expect(backgroundModes()).toEqual(expect.arrayContaining(['remote-notification', 'fetch']));
  });

  it('does not install the PushKit registry or the CallKit provider', () => {
    expect(pushMm).toMatch(/static const BOOL kCanariCallsEnabled = NO;/);
    expect(pushMm).toContain('calls disabled - not reporting incoming call');
  });

  it('does not promise calls in the microphone purpose string', () => {
    // A purpose string is read by App Review too, and it claimed "et passer des appels".
    const usage = infoPlist.match(
      /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]*)<\/string>/
    );
    expect(usage, 'NSMicrophoneUsageDescription not found').not.toBeNull();
    expect(usage![1]).not.toMatch(/appel/i);
    for (const lang of ['fr', 'en']) {
      const strings = readFileSync(
        resolve(APPLE, `canari_iOS/${lang}.lproj/InfoPlist.strings`),
        'utf8'
      );
      const line = strings.split('\n').find((l) => l.includes('NSMicrophoneUsageDescription'));
      expect(line, `NSMicrophoneUsageDescription missing from ${lang}.lproj`).toBeDefined();
      expect(line).not.toMatch(/appel|call/i);
    }
  });
});
