import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The native caches are sealed at rest and kept out of backups (Rust `native_cache`, the design's
 * only copy), and FIVE files in four languages have to agree for that to hold.
 *
 * Nothing compiles one of them against another: the key's alias is a string spelled on each side,
 * a writer that forgets to seal still compiles and still works - it just puts message text back on
 * disk in the clear - and a reader that opens the JSON itself still compiles and silently misses
 * every seed. So each seam is pinned here:
 *
 *   - ONE alias, spelled in Rust, Kotlin, Swift and both Objective-C++ files;
 *   - every native writer of the push cache seals the line before it touches the disk, and writes
 *     nothing when it has no key;
 *   - no native reader opens `graine_seeds.json` itself - they ask Rust (`graineSeedHeld`);
 *   - the iOS key is created as a ThisDeviceOnly item in the App Group access group, and the
 *     directories holding the caches are excluded from backups at bootstrap and activation.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

const ANDROID = '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/';
const nativeCacheRs = read('../../../src-tauri/src/native_cache.rs');
const nativeCacheKeyKt = read(`${ANDROID}NativeCacheKey.kt`);
const firebaseKt = read(`${ANDROID}CanariFirebaseMessagingService.kt`);
const applicationKt = read(`${ANDROID}CanariApplication.kt`);
const swift = read('../../../src-tauri/gen/apple/canari_NSE/NotificationService.swift');
const pushMm = read('../../../src-tauri/gen/apple/Sources/canari/canari_push.mm');
const iosMm = read('../../../src-tauri/gen/apple/Sources/canari/canari_ios.mm');

const ALIAS = 'canari_native_cache_key';

/** The text from `start` to the first match of `end` after it. */
function between(source: string, start: RegExp, end: RegExp): string {
  const from = source.search(start);
  if (from < 0) throw new Error(`start not found: ${start}`);
  const rest = source.slice(from);
  const to = rest.slice(1).search(end);
  if (to < 0) throw new Error(`end not found: ${end}`);
  return rest.slice(0, to + 1);
}

describe('one key, under one alias, on every side', () => {
  it.each([
    ['native_cache.rs', nativeCacheRs, `"${ALIAS}"`],
    ['NativeCacheKey.kt', nativeCacheKeyKt, `"${ALIAS}"`],
    ['NotificationService.swift', swift, `"${ALIAS}"`],
    ['canari_push.mm', pushMm, `mls_bg_key_${ALIAS}`],
    ['canari_ios.mm', iosMm, `mls_bg_key_${ALIAS}`],
  ])('%s spells it', (_name, source, spelling) => {
    expect(source).toContain(spelling);
  });

  it('Android creates it at process start, and only there', () => {
    expect(applicationKt).toContain('NativeCacheKey.ensure(this)');
    expect(firebaseKt).not.toContain('NativeCacheKey.ensure(');
  });

  it('iOS creates it as a device-only item the extension can read, never synchronised', () => {
    const ensure = between(iosMm, /static void CanariEnsureNativeCacheKey\(/, /\n}\n/);
    expect(ensure).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(ensure).toContain('@"group.fr.emse.canari"');
    expect(ensure).toContain('errSecItemNotFound');
    expect(ensure).not.toContain('kSecAttrSynchronizable');
    // The extension only reads it: one creator, so one file is never sealed under two keys.
    expect(swift).not.toContain('SecItemAdd');
  });
});

describe('every writer of the push cache seals the line first', () => {
  it('Kotlin', () => {
    const body = between(firebaseKt, /internal fun appendFcmCacheEntry\(/, /\n {8}}\n/);
    expect(body).toContain('nativeSealCacheLine(');
    expect(body).toContain('(kept + sealed)');
    expect(body).not.toContain('kept + entry.toString()');
  });

  it('Swift', () => {
    const body = between(swift, /private func writeFcmCache\(/, /\n {2}}\n/);
    expect(body).toContain('canari_native_seal_cache_line(');
    expect(body).toContain('lines.append(entryLine)');
    expect(body).toMatch(/let entryLine = String\(cString: sealedRaw\)/);
  });

  it('Objective-C++', () => {
    const body = between(pushMm, /static void CanariAppendFcmCacheEntry\(/, /\n}\n/);
    expect(body).toContain('canari_native_seal_cache_line(');
    expect(body).toMatch(/NSString \*entryLine = \[NSString stringWithUTF8String:sealedPtr\]/);
  });
});

describe('the sealed seed mirror is read by Rust alone', () => {
  it.each([
    ['Kotlin', firebaseKt, /File\([^)]*"graine_seeds\.json"\)/],
    ['Swift', swift, /graineSeedsFile|appendingPathComponent\("graine_seeds\.json"\)/],
    ['Objective-C++', pushMm, /stringByAppendingPathComponent:@"graine_seeds\.json"\]/],
  ])('%s does not open the file itself', (_name, source, opener) => {
    expect(source).not.toMatch(opener);
  });

  it.each([
    ['Kotlin', firebaseKt, 'nativeGraineSeedHeld('],
    ['Swift', swift, 'canari_native_graine_seed_held('],
    ['Objective-C++', pushMm, 'canari_native_graine_seed_held('],
  ])('%s asks Rust whether a session is held', (_name, source, call) => {
    expect(source).toContain(call);
  });
});

describe('iOS keeps the caches out of backups', () => {
  it('excludes the data directory and the App Group container', () => {
    const exclude = between(iosMm, /static void CanariExcludeNativeCachesFromBackup\(/, /\n}\n/);
    expect(iosMm).toContain('NSURLIsExcludedFromBackupKey');
    expect(exclude).toContain('CanariTauriDataDir()');
    expect(exclude).toContain('containerURLForSecurityApplicationGroupIdentifier');
  });

  it('at bootstrap and at every activation', () => {
    const bootstrap = between(iosMm, /void canari_ios_bootstrap\(void\) \{/, /\n}\n/);
    const active = between(iosMm, /static void CanariOnDidBecomeActive\(/, /\n}\n/);
    for (const body of [bootstrap, active]) {
      expect(body).toContain('CanariEnsureNativeCacheKey();');
      expect(body).toContain('CanariExcludeNativeCachesFromBackup();');
    }
  });
});
