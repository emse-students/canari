import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The four things Google Play's pre-launch analysis named on 2026-08-26, held here.
 *
 * Each is invisible to every other check in this repository. Three live in files
 * `tauri android init` or a Tauri upgrade regenerates from the template - `gen/android` is
 * committed precisely because of that - and the fourth is Kotlin, compiled by a toolchain the
 * frontend suite never runs. All four would come back green from every gate we have.
 *
 * The list will not empty, and that is the point of writing down which parts of it are ours.
 * Play also reports `Window.setStatusBarColor` from `androidx.activity` and from
 * `com.google.android.gms`: the first is the backwards-compat path INSIDE the
 * `enableEdgeToEdge()` that Play's own edge-to-edge recommendation asks for - checked against the
 * 1.13.0 sources, where it is unchanged and `@Suppress("DEPRECATION")`-ed, so no upgrade silences
 * it - and the second is play-services-base, pulled by Firebase. Neither is actionable, and
 * neither is asserted here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ANDROID = resolve(here, '../../../src-tauri/gen/android');

const gradle = readFileSync(resolve(ANDROID, 'app/build.gradle.kts'), 'utf8');
const theme = readFileSync(resolve(ANDROID, 'app/src/main/res/values/themes.xml'), 'utf8');
const fcm = readFileSync(
  resolve(ANDROID, 'app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'),
  'utf8'
);

describe("Google Play's release recommendations, the actionable ones", () => {
  it('reads every image header before decoding its pixels', () => {
    // An avatar's resolution is NOT ours to bound: the bytes come from MiGallery, through
    // core-service, through /api/mls/push/avatar, and no hop carries a size parameter. The two
    // decodes used to run at whatever the owner uploaded, in the FCM service process, where
    // running out of memory loses the notification rather than softening its icon.
    expect(fcm).toContain('inJustDecodeBounds = true');
    expect(fcm).toContain('inSampleSize = sample');
    // Powers of two only, and the loop must stop at or ABOVE the target: crossing below it would
    // upscale in circleCrop, which is the one direction that shows.
    expect(fcm).toMatch(/while \(shortest \/ \(sample \* 2\) >= target\) sample \*= 2/);
  });

  it('hands options to every BitmapFactory call, with no second copy of the logic', () => {
    // The check Play actually runs, expressed against the source: a decode with no Options
    // argument is the finding, wherever it is added. Both call sites route through decodeSampled,
    // which is why the lambda's `it` is what each of them receives.
    const decodes = fcm.match(/BitmapFactory\.decode\w+\([^\n]*/g) ?? [];
    expect(decodes.length).toBeGreaterThan(0);
    for (const call of decodes) expect(call).toMatch(/,\s*it\)/);
    expect(fcm.match(/private fun decodeSampled\(/g)).toHaveLength(1);
  });

  it('sizes the notification icon from the platform, not from the source image', () => {
    // The framework scales a large icon to notification_large_icon_width; asking it is the fact
    // that spares us decoding an avatar at upload resolution to discover how big it was.
    expect(fcm).toContain('android.R.dimen.notification_large_icon_width');
    // circleCrop's output is the target, where it used to be the source's own shortest edge -
    // a second ARGB_8888 allocation that carried the full resolution one step further.
    expect(fcm).toMatch(/private fun circleCrop\(src: Bitmap, target: Int\)/);
    expect(fcm).toContain('Bitmap.createBitmap(target, target, Bitmap.Config.ARGB_8888)');
  });

  it('shrinks resources in release, which is what makes the R8 flag mean something', () => {
    const release = gradle.match(/getByName\("release"\) \{[\s\S]*?\n {8}\}/)?.[0] ?? '';
    expect(release).toContain('isMinifyEnabled = true');
    expect(release).toContain('isShrinkResources = true');
    // Already set, and inert until the shrinker itself is on.
    const props = readFileSync(resolve(ANDROID, 'gradle.properties'), 'utf8');
    expect(props).toContain('android.r8.optimizedResourceShrinking=true');
  });

  it('keeps the unused Material library out of the APK, declaration and all', () => {
    // Eight modules declare it - six Tauri plugins from the registry plus the two local patched
    // ones - and no Kotlin file anywhere names a class from it. Dropping our own line alone would
    // have resolved the plugins' 1.7.0 instead and kept MaterialDatePicker, the class Play
    // reports a deprecated Window.setStatusBarColor from.
    expect(gradle).not.toContain('implementation("com.google.android.material:material');
    expect(gradle).toMatch(
      /exclude\(group = "com\.google\.android\.material", module = "material"\)/
    );
    // The theme parent was its only real use here. Asserted on the `parent` attribute, not on
    // the file: the comment above the style names MaterialComponents to say what it stopped being.
    expect(theme).toContain('parent="Theme.AppCompat.DayNight.NoActionBar"');
    expect(theme).not.toMatch(/parent="Theme\.MaterialComponents/);
  });
});
