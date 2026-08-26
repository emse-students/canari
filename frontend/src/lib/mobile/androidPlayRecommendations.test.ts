import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What Google Play asked of this app, held here - the four findings of its pre-launch analysis
 * and the Q3-2026 quality requirements that followed the same day.
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
const manifest = readFileSync(resolve(ANDROID, 'app/src/main/AndroidManifest.xml'), 'utf8');
const extraction = readFileSync(
  resolve(ANDROID, 'app/src/main/res/xml/data_extraction_rules.xml'),
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

/**
 * Play's Q3-2026 quality requirements, the half that is ours to assert.
 *
 * Three of the four thresholds are measured by Play from field data and cannot be pinned here:
 * dynamic memory and bitmap memory are 28-day P90s off Android vitals, and the 25% code-optimization
 * floor applies only above 10 MB of DEX - this app's release DEX is 2.83 MB, so it is out of scope
 * by size, and minification is asserted above anyway.
 *
 * The fourth, "a secure and seamless migration", is where this app had a real hole, and it is the
 * kind only a reference can close. `data_extraction_rules.xml` had sat in the tree since it was
 * written, saying in its own comment that the manifest referenced it, while the manifest's header
 * said in as many words NOT to add that reference. Nothing read the file. The resource shrinker
 * named it the moment it was switched on - `xml:data_extraction_rules is not reachable` - and it
 * now reports `reachable from AndroidManifest.xml` instead.
 */
describe("Play's Q3-2026 quality requirements", () => {
  it('excludes the app from device-to-device transfer, not just from cloud backup', () => {
    // `allowBackup="false"` is deprecated from Android 12 and, on several manufacturers, stops
    // cloud backup while leaving D2D transfer running. A missing <device-transfer> section is not
    // a refusal either: that mode is then fully enabled for everything outside cache/no-backup.
    // So the two attributes are not alternatives - allowBackup covers API 28-30, the rules file
    // covers 31+, and the app needs both.
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    expect(manifest).toMatch(/tools:replace="[^"]*android:dataExtractionRules/);
    expect(extraction).toMatch(/<cloud-backup>\s*<exclude domain="root" \/>\s*<\/cloud-backup>/);
    expect(extraction).toMatch(
      /<device-transfer>\s*<exclude domain="root" \/>\s*<\/device-transfer>/
    );
  });

  it('no longer carries the instruction that left the reference out', () => {
    // The header listed dataExtractionRules among the things never to restore, on the grounds of a
    // manifest merge conflict - which is what tools:replace answers, exactly as it already did for
    // allowBackup. An instruction that forbids the fix outlives whoever wrote it, so it is asserted
    // gone rather than merely edited.
    expect(manifest).not.toMatch(/nor fullBackupContent\/dataExtractionRules/);
    expect(manifest).toMatch(/dataExtractionRules\s+is IN/);
  });
});
