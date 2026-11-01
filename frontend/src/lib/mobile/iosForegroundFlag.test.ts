import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE iOS ACTIVE SIGNAL, THE FOREGROUND FLAG AND THE PUSH CACHE DRAIN, asserted on the native
 * source - the only gate these have short of an iPhone (`docs/wiki/device-verification.md`).
 *
 * - The page is told whether the app is ACTIVE (`window.__canariActive`, `appActive.ts`) from the
 *   same two callbacks that set the extension's App Group flag, and after every page load - and NOT
 *   through `__canariForeground`, which ten other consumers read with its own meaning.
 * - A new process clears the App Group flag at launch: one that died in front never ran
 *   `willResignActive`, and every push after it was written `presented: false` and announced twice.
 * - The drain RENAMES the App Group file before reading it, writes the app's copy, and only then
 *   removes the renamed file: nothing the extension writes during the drain can be deleted unread.
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

describe('the iOS active signal', () => {
  it('is told to the page on both transitions', () => {
    expect(body(IOS_MM, 'static void CanariOnDidBecomeActive(')).toContain(
      'CanariPushActiveToPage(YES)'
    );
    expect(body(IOS_MM, 'static void CanariOnWillResignActive(')).toContain(
      'CanariPushActiveToPage(NO)'
    );
  });

  it('is told again after every page load', () => {
    const start = IOS_MM.indexOf('@implementation CanariLoadObserver');
    const observer = IOS_MM.slice(start, IOS_MM.indexOf('@end', start));
    expect(observer).toContain('CanariPushActiveToPage(g_isInForeground');
  });

  it('writes its own global and event, and leaves the foreground flag alone', () => {
    const push = body(IOS_MM, 'static void CanariPushActiveToPage(BOOL active) {');
    expect(push).toContain('window.__canariActive=');
    expect(push).toContain("'canari:active'");
    expect(IOS_MM).not.toMatch(/__canariForeground\s*=/);
  });

  it('the App Group foreground flag is cleared at every launch', () => {
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

  it('renames the App Group file, then copies it, then removes the renamed file', () => {
    const rename = drain.indexOf('moveItemAtURL:srcUrl toURL:drainingUrl');
    const read = drain.indexOf('stringWithContentsOfURL:drainingUrl');
    const write = drain.indexOf('writeToFile:');
    const remove = drain.lastIndexOf('removeItemAtURL:drainingUrl');
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(rename);
    expect(write).toBeGreaterThan(read);
    expect(remove).toBeGreaterThan(write);
  });

  it('never deletes the file the extension writes to', () => {
    expect(drain).not.toContain('removeItemAtURL:srcUrl');
  });

  it('names the same draining file the Rust reader reads', () => {
    const rust = readFileSync(resolve(here, '../../../src-tauri/src/commands/push.rs'), 'utf8');
    const native = /kFcmCacheDrainingFileName = @"([^"]+)"/.exec(PUSH_MM)?.[1];
    const reader = /FCM_CACHE_DRAINING_FILE: &str = "([^"]+)"/.exec(rust)?.[1];
    expect(native).toBeDefined();
    expect(native).toBe(reader);
  });
});
