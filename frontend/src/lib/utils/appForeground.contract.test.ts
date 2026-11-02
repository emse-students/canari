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

  it.each([
    ['Android', android],
    ['iOS', ios],
  ])('%s carries the link a resume opens in the edge itself', (_shell, source) => {
    expect(source).toMatch(/detail:\{foreground:[^}]*,opening:/);
  });

  /** The block of the LAST observer registered for `name` (didBecomeActive has two). */
  function observer(name: string): string {
    const at = ios.lastIndexOf(`addObserverForName:${name}`);
    expect(at, name).toBeGreaterThan(-1);
    return ios.slice(at, ios.indexOf('}];', at));
  }

  it('iOS publishes leaving at didEnterBackground, and coming back when the resume COMPLETES', () => {
    expect(observer('UIApplicationDidEnterBackgroundNotification')).toContain(
      'CanariPublishForeground(nil);'
    );
    // The resume begins at willEnterForeground and publishes nothing there: a tapped notification
    // reaches the delegate before the resume completes, and its link must ride the edge.
    const begins = observer('UIApplicationWillEnterForegroundNotification');
    expect(begins).toContain('g_resumePending = true;');
    expect(begins).not.toContain('CanariPublishForeground');
    const completes = observer('UIApplicationDidBecomeActiveNotification');
    expect(completes).toContain('if (!g_resumePending) return;');
    expect(completes).toContain('CanariPublishForeground(opening);');
    const loadObserver = ios.slice(
      ios.indexOf('@implementation CanariLoadObserver'),
      ios.indexOf('@end', ios.indexOf('@implementation CanariLoadObserver'))
    );
    expect(loadObserver).toContain('CanariPublishForeground(nil);');
  });

  it('iOS notes a tapped notification for the resume BEFORE the page is told of the tap', () => {
    const push = readFileSync('src-tauri/gen/apple/Sources/canari/canari_push.mm', 'utf8');
    const note = push.indexOf('CanariNoteResumeOpening(deepLink);');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(push.indexOf('CanariQueueNotificationTap(deepLink);', note));
  });

  it('iOS never publishes from the ACTIVE pair handlers: a Face ID sheet does not take the app off screen', () => {
    for (const signature of [
      'static void CanariOnDidBecomeActive(',
      'static void CanariOnWillResignActive(',
    ]) {
      expect(objcBody(ios, signature), signature).not.toContain('CanariPublishForeground');
    }
  });
});
