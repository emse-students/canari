import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guardrail for the two window-layout behaviours that only exist in Kotlin.
 *
 * Both are invisible to every other check in this repository: they compile whatever they say, and
 * `tauri android init` or a Tauri upgrade regenerates `gen/android` from the template and drops
 * them. Neither can be caught by the frontend suite, which never runs inside an Activity.
 *
 * The keyboard half is the one worth stating twice. `android:windowSoftInputMode="adjustResize"`
 * is still in the manifest and is INERT: since Android 15 an edge-to-edge window is not resized
 * for the IME. Deleting the listener would therefore not break a build, would not fail a test that
 * only reads the manifest, and would silently put the composer back under the keyboard.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ANDROID_MAIN = resolve(here, '../../../src-tauri/gen/android/app/src/main');

const mainActivity = readFileSync(
  resolve(ANDROID_MAIN, 'java/fr/emse/canari/MainActivity.kt'),
  'utf8'
);
const manifest = readFileSync(resolve(ANDROID_MAIN, 'AndroidManifest.xml'), 'utf8');

describe('Android window layout (anti-regression)', () => {
  it('handles the IME inset itself, because adjustResize cannot', () => {
    // The manifest attribute is kept for pre-Android-15 devices, where it does work.
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
    expect(mainActivity).toContain('setOnApplyWindowInsetsListener');
    expect(mainActivity).toContain('WindowInsetsCompat.Type.ime()');
  });

  it('withdraws the navigation-bar inset while the keyboard is up, and only then', () => {
    // The web layer reserves a strip for the navigation bar through env(safe-area-inset-bottom).
    // Correct when the bar is at the bottom of the app; wrong once the keyboard is, because the
    // bar is then behind it - the strip becomes an empty band the page can be scrolled by.
    // The early return is what keeps the strip when the keyboard is down.
    expect(mainActivity).toMatch(/if \(ime == 0\) return@setOnApplyWindowInsetsListener insets/);
    expect(mainActivity).toContain('WindowInsetsCompat.Builder(insets)');
    expect(mainActivity).toMatch(/Insets\.of\(bars\.left, bars\.top, bars\.right, 0\)/);
    // The status bar is NOT withdrawn: it is still on screen with the keyboard open.
    expect(mainActivity).not.toContain('WindowInsetsCompat.Type.statusBars()');
  });

  it('locks a phone to portrait and lets a tablet rotate', () => {
    expect(mainActivity).toContain('R.bool.canari_lock_portrait');
    expect(mainActivity).toContain('ActivityInfo.SCREEN_ORIENTATION_PORTRAIT');
    // No literal orientation in the manifest: one value there could not serve both form factors.
    expect(manifest).not.toContain('android:screenOrientation');

    const phone = readFileSync(resolve(ANDROID_MAIN, 'res/values/bools.xml'), 'utf8');
    const tablet = readFileSync(resolve(ANDROID_MAIN, 'res/values-sw600dp/bools.xml'), 'utf8');
    expect(phone).toMatch(/<bool name="canari_lock_portrait">true<\/bool>/);
    expect(tablet).toMatch(/<bool name="canari_lock_portrait">false<\/bool>/);
  });

  it('keeps the orientation config change declared, so a tablet rotates without a restart', () => {
    // Losing `orientation|screenSize` would tear the WebView down on every rotation - the MLS
    // state reloads, and an in-flight send is interrupted, for a movement of the wrist.
    const activity = manifest.match(/<activity[\s\S]*?>/)?.[0] ?? '';
    expect(activity).toContain('orientation');
    expect(activity).toContain('screenSize');
  });
});
