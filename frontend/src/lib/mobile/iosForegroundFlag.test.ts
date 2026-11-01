import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE iOS FOREGROUND FLAG AND THE PUSH CACHE DRAIN, asserted on the native source - the only gate
 * these have short of an iPhone (`docs/wiki/device-verification.md`).
 *
 * - The flag the page reads (`window.__canariForeground`) is told from the same two callbacks that
 *   set the extension's App Group flag, and after every page load: without it the page read "in
 *   front" in every state and decided as an app on screen.
 * - A new process clears the App Group flag at launch: one that died in front never ran
 *   `willResignActive`, and every push after it was written `presented: false` and announced twice.
 * - The drain writes the app's copy BEFORE it removes the App Group file, and removes it only if the
 *   extension wrote nothing meanwhile: the other order lost every entry a failed write held.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = resolve(here, '../../../src-tauri/gen/apple/Sources/canari');
const IOS_MM = readFileSync(resolve(SOURCES, 'canari_ios.mm'), 'utf8');
const PUSH_MM = readFileSync(resolve(SOURCES, 'canari_push.mm'), 'utf8');

/** The body of the C function `name` - from its signature to the first `}` at column 0. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end);
}

describe('the iOS foreground flag', () => {
  it('is told to the page on both transitions', () => {
    expect(body(IOS_MM, 'static void CanariOnDidBecomeActive(')).toContain(
      'CanariPushForegroundToPage(YES)'
    );
    expect(body(IOS_MM, 'static void CanariOnWillResignActive(')).toContain(
      'CanariPushForegroundToPage(NO)'
    );
  });

  it('is told again after every page load', () => {
    const observer = IOS_MM.slice(
      IOS_MM.indexOf('@implementation CanariLoadObserver'),
      IOS_MM.indexOf('@end', IOS_MM.indexOf('@implementation CanariLoadObserver'))
    );
    expect(observer).toContain('CanariPushForegroundToPage(g_isInForeground');
  });

  it('writes the global and the event Android writes', () => {
    const push = body(IOS_MM, 'static void CanariPushForegroundToPage(BOOL inForeground) {');
    expect(push).toContain('window.__canariForeground=');
    expect(push).toContain("'canari:foreground'");
  });

  it('is cleared in the App Group at every launch', () => {
    const bootstrap = body(IOS_MM, 'void canari_ios_bootstrap(void) {');
    const launch = bootstrap.slice(
      bootstrap.indexOf('UIApplicationDidFinishLaunchingNotification'),
      bootstrap.indexOf('UIApplicationDidBecomeActiveNotification')
    );
    expect(launch).toContain('CanariSetAppGroupForegroundFlag(NO)');
    expect(launch).toContain('g_isInForeground = false');
  });
});

describe('the App Group push cache drain', () => {
  const drain = body(PUSH_MM, 'void CanariDrainAppGroupFcmCache(void) {');

  it("writes the app's copy before it removes the App Group file", () => {
    const write = drain.indexOf('writeToFile:');
    const remove = drain.indexOf('removeItemAtURL:');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(write);
  });

  it('removes it only when the extension wrote nothing during the drain', () => {
    const guard = drain.indexOf('isEqualToString:incoming');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(drain.indexOf('removeItemAtURL:')).toBeGreaterThan(guard);
  });
});
