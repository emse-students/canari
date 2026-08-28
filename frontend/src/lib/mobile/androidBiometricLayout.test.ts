import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A CLASS REFERENCED ONLY FROM A LAYOUT IS A REFERENCE NO SOURCE GREP SEES.
 *
 * `build.gradle.kts` excludes `com.google.android.material:material` on the assertion that not one
 * Kotlin file in this app or in any bundled Tauri plugin names a class from it. That assertion was
 * true and insufficient: excluding a module also drops whatever only that module contributed, and
 * `material:1.7.0` was the single path to `androidx.coordinatorlayout` - the ROOT VIEW of
 * `app.tauri.biometric`'s `auth_activity.xml`.
 *
 * Measured on a Pixel 6a on 2026-08-28: zero occurrences of `coordinatorlayout` in all twelve dex
 * files of the built APK, and every biometric call ended in `FATAL EXCEPTION: main` /
 * `ClassNotFoundException` that took the process down. It reached a user as a revoked phone that
 * kept its conversations, because the wipe's biometric step killed the app 55 ms in and every step
 * after it never ran.
 *
 * Nothing compiles the Android app in CI, so this is the only place the pair can be checked: the
 * exclusion and the explicit declaration that repairs it must travel together. A test on the built
 * APK would be stronger and is not available here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const gradle = readFileSync(
  resolve(here, '../../../src-tauri/gen/android/app/build.gradle.kts'),
  'utf8'
);

describe('Android dependency graph around the biometric plugin', () => {
  it('declares androidx.coordinatorlayout whenever it excludes com.google.android.material', () => {
    const excludesMaterial = /exclude\(\s*group\s*=\s*"com\.google\.android\.material"/.test(
      gradle
    );
    if (!excludesMaterial) return;

    expect(
      /implementation\("androidx\.coordinatorlayout:coordinatorlayout:/.test(gradle),
      'the material exclusion removes androidx.coordinatorlayout transitively, and the biometric ' +
        "plugin's auth_activity.xml inflates it as its root view - declare it explicitly"
    ).toBe(true);
  });

  it('keeps the exclusion and the repair in the same file, so neither can move alone', () => {
    const exclusionAt = gradle.indexOf('exclude(group = "com.google.android.material"');
    const repairAt = gradle.indexOf(
      'implementation("androidx.coordinatorlayout:coordinatorlayout:'
    );
    expect(
      exclusionAt,
      'exclusion not found - if it was lifted, drop this test too'
    ).toBeGreaterThan(-1);
    expect(repairAt).toBeGreaterThan(-1);
  });
});
