import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Installer-package contract guardrail.
 *
 * `installer_package.txt` is written by ONE native writer and read by ONE Rust reader:
 *   - Kotlin: CanariApplication.recordInstallerPackage (writes the installing package name)
 *   - Rust:   get_installer_package (storage.rs), exposed to the WebView as a Tauri command
 *
 * Nothing type-checks that cross-process path: a rename on either side leaves a reader that
 * silently finds nothing, and an unknown install source is indistinguishable from a Play
 * install. That matters because the Play build and the GitHub APK carry DIFFERENT signatures
 * - neither can install over the other - so a wrong answer sends a sideload user to a store
 * that will refuse the install.
 *
 * Also pins the installer package name the frontend compares against: `com.android.vending`
 * is Google Play's own package, and a typo there would classify every install as a sideload.
 */
const here = dirname(fileURLToPath(import.meta.url));

const CANARI_APPLICATION_KT = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariApplication.kt'
);
const STORAGE_RS = resolve(here, '../../../src-tauri/src/commands/storage.rs');
const LIB_RS = resolve(here, '../../../src-tauri/src/lib.rs');
const APP_VERSION_TS = resolve(here, '../utils/appVersion.ts');

const INSTALLER_FILE = 'installer_package.txt';

describe('installer_package.txt contract', () => {
  const kotlin = readFileSync(CANARI_APPLICATION_KT, 'utf8');
  const rust = readFileSync(STORAGE_RS, 'utf8');
  const ts = readFileSync(APP_VERSION_TS, 'utf8');

  it('is written by the Kotlin side at startup', () => {
    expect(kotlin).toContain(`"${INSTALLER_FILE}"`);
    expect(kotlin).toContain('recordInstallerPackage()');
    // Written into the same directory Rust reaches via app_data_dir().
    expect(kotlin).toContain('MlsContextLoader.tauriDataDir(this)');
  });

  it('is read back under the exact same name by the Rust command', () => {
    expect(rust).toContain(`const INSTALLER_PACKAGE_FILE: &str = "${INSTALLER_FILE}"`);
    expect(rust).toContain('pub(crate) fn get_installer_package');
    expect(rust).toContain('app_data_dir()');
  });

  it('queries the installer through both API levels', () => {
    // getInstallSourceInfo is API 30+; minSdk is below that, so the guarded fallback
    // is what keeps older devices from crashing on a missing method.
    expect(kotlin).toContain('getInstallSourceInfo');
    expect(kotlin).toContain('getInstallerPackageName');
    expect(kotlin).toContain('Build.VERSION_CODES.R');
  });

  it('invokes the command under the name Rust registers it with', () => {
    const lib = readFileSync(LIB_RS, 'utf8');
    // Missing from generate_handler! fails only at runtime, on the device, as a rejected
    // invoke - which the probe would swallow into "assume Play Store".
    expect(lib).toMatch(/generate_handler!\[[\s\S]*get_installer_package[\s\S]*\]/);
    expect(ts).toContain("invoke<string | null>('get_installer_package')");
  });

  it("compares against Google Play's own package name", () => {
    expect(ts).toContain("const PLAY_STORE_INSTALLER_PACKAGE = 'com.android.vending'");
  });
});
