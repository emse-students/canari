import { readFileSync } from 'node:fs';
import { APP_FOREGROUND_EVENT } from './appForeground';

/**
 * BOTH PHONE SHELLS TELL THE PAGE WHETHER THE APP IS ON SCREEN, IN ONE CONTRACT (2026-11-02).
 *
 * The page has ONE implementation (`appForeground.ts`, `appForegroundState.svelte.ts`) and it reads
 * `window.__canariForeground` plus the `canari:foreground` event. Android wrote both; iOS wrote
 * neither, so on an iPhone the page believed itself on screen for ever and a frame processed in the
 * seconds before suspension counted as read on arrival. A shell that drifts from the contract makes
 * the page silently go back to "always on screen", which no other test would see.
 */
const android = readFileSync(
  'src-tauri/gen/android/app/src/main/java/fr/emse/canari/MainActivity.kt',
  'utf8'
);
const ios = readFileSync('src-tauri/gen/apple/Sources/canari/canari_ios.mm', 'utf8');

/** The body of the ObjC function `name` (up to the next top-level closing brace). */
function objcBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n}\n', start));
}

describe('the foreground contract between the shells and the page', () => {
  it('names the event the page listens for', () => {
    expect(APP_FOREGROUND_EVENT).toBe('canari:foreground');
  });

  it.each([
    ['Android', android],
    ['iOS', ios],
  ])('%s writes the global AND dispatches the event', (_shell, source) => {
    expect(source).toContain('window.__canariForeground=');
    expect(source).toContain(`new CustomEvent('${APP_FOREGROUND_EVENT}',{detail:{foreground:`);
  });

  it('iOS publishes on the background/foreground pair and after a page load', () => {
    for (const name of [
      'UIApplicationDidEnterBackgroundNotification',
      'UIApplicationWillEnterForegroundNotification',
    ]) {
      const at = ios.indexOf(`addObserverForName:${name}`);
      expect(at, name).toBeGreaterThan(-1);
      expect(ios.slice(at, ios.indexOf('}];', at)), name).toContain('CanariPublishForeground();');
    }
    const loadObserver = ios.slice(
      ios.indexOf('@implementation CanariLoadObserver'),
      ios.indexOf('@end', ios.indexOf('@implementation CanariLoadObserver'))
    );
    expect(loadObserver).toContain('CanariPublishForeground();');
  });

  it('iOS never publishes on the ACTIVE pair: a Face ID sheet does not take the app off screen', () => {
    for (const signature of [
      'static void CanariOnDidBecomeActive(',
      'static void CanariOnWillResignActive(',
    ]) {
      expect(objcBody(ios, signature), signature).not.toContain('CanariPublishForeground');
    }
  });
});
