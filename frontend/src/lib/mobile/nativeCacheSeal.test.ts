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
const pushRs = read('../../../src-tauri/src/commands/push.rs');
const keyGroupJoinRs = read('../../../src-tauri/src/mobile/key_group_join.rs');
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

  it('Android unwraps it ONCE per salon push, and hands that copy down', () => {
    // Each Keystore unwrap is a hardware-backed decrypt; a salon push asks the mirror up to four
    // times, opens a frame and decrypts - one unwrap serves them all.
    const handler = between(firebaseKt, /private fun handleChannelMessage\(/, /\n {4}}\n/);
    expect(handler.match(/NativeCacheKey\.retrieve\(/g)).toHaveLength(1);
    for (const fn of [
      /private fun graineSeedHeld\(cacheKey: String,/,
      /private fun absorbGraineSeeds\(cacheKey: String,/,
      /private fun drainPendingChannelFrames\(cacheKey: String\)/,
      /private fun postChannelNotification\(\n\s*cacheKey: String,/,
      /private fun openSeedFrame\(\n\s*cacheKey: String,/,
      /private fun joinKeyGroupFromPush\(cacheKey: String,/,
    ]) {
      expect(firebaseKt).toMatch(fn);
      expect(between(firebaseKt, fn, /\n {4}}\n/)).not.toContain('NativeCacheKey.retrieve(');
    }
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

  it('Kotlin survives a native library without the seal symbol', () => {
    // The seal is a JNI call: an UnsatisfiedLinkError is an Error, which `catch (e: Exception)`
    // lets through to crash the push handler.
    const body = between(firebaseKt, /internal fun appendFcmCacheEntry\(/, /\n {8}}\n/);
    expect(body).toContain('catch (e: Throwable)');
    expect(body).not.toContain('catch (e: Exception)');
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

  it('Rust reads the file in ONE place, the function that opens it', () => {
    // A second reader of the raw file - `read_to_string` + `serde_json` on graine_seeds.json -
    // still compiles against a sealed mirror and answers "holds nothing" for every salon. Any
    // question about the mirror's contents goes through `read_graine_mirror` with the key.
    const production = pushRs.slice(0, pushRs.indexOf('\n#[cfg(test)]\nmod '));
    const rawReads = production.match(/fs::read(?:_to_string)?\([^;]*graine_seeds\.json/g) ?? [];
    expect(rawReads).toHaveLength(1);
    const reader = between(production, /pub\(crate\) fn read_graine_mirror\(/, /\n}\n/);
    expect(reader).toMatch(/fs::read\(data_dir\.join\("graine_seeds\.json"\)\)/);
  });

  it.each([
    ['Kotlin', firebaseKt, 'nativeGraineSeedHeld('],
    ['Swift', swift, 'canari_native_graine_seed_held('],
    ['Objective-C++', pushMm, 'canari_native_graine_seed_held('],
  ])('%s asks Rust whether a session is held', (_name, source, call) => {
    expect(source).toContain(call);
  });
});

describe('the push key-group join ledger is sealed by Rust alone', () => {
  // It names key groups, their state and the salon scope the server answered: metadata the app's
  // stores seal, in a file the push service writes with the app shut (`mobile/key_group_join.rs`).
  const ledgerWriter = between(keyGroupJoinRs, /fn with_ledger</, /\n}\n/);

  it('writes the ledger sealed, and re-excludes it after its atomic write', () => {
    expect(ledgerWriter).toContain('seal_file(key, Purpose::KeyGroupJoinLedger,');
    expect(ledgerWriter).toMatch(
      /fs::rename\(&tmp, &path\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*exclude_from_backup\(&path\);/
    );
  });

  it('every ledger call takes the cache key, and Kotlin hands it over', () => {
    for (const fn of [/pub fn claim\(/, /pub fn settle\(/, /pub fn take_all\(/]) {
      expect(between(keyGroupJoinRs, fn, /\) -> /)).toContain('key: &CacheKey');
    }
    expect(firebaseKt).toContain('nativeKeyGroupJoinClaim(filesDir, cacheKey, groupId)');
    expect(firebaseKt).toMatch(/nativeKeyGroupJoinSettle\(filesDir, cacheKey, groupId,/);
    expect(firebaseKt).not.toMatch(/File\([^)]*"key_group_push_joins\.json"\)/);
  });
});

describe('iOS keeps the caches out of backups, and nothing else', () => {
  it('excludes the two cache files, never a directory', () => {
    // The data directory also holds mls.bin, push_context.json and the identity files: a restore
    // that brought IndexedDB back without them would look like a damaged MLS state.
    const perFile = between(
      pushMm,
      /void CanariExcludeNativeCacheFilesFromBackup\(NSString/,
      /\n}\n/
    );
    expect(perFile).toContain('NSURLIsExcludedFromBackupKey');
    expect(perFile).toContain('isEqualToString:kGraineSeedsFileName');
    expect(perFile).toContain('hasPrefix:@"fcm_message_cache"');
    expect(perFile).toContain('isDirectory:NO');
    for (const source of [iosMm, pushMm, swift]) {
      expect(source).not.toMatch(/isDirectory:YES\][^;]*\n?[^;]*NSURLIsExcludedFromBackupKey/);
      expect(source).not.toContain('CanariExcludeDirectoryFromBackup');
    }
    const pass = between(iosMm, /static void CanariExcludeNativeCachesFromBackup\(/, /\n}\n/);
    expect(pass).toContain('CanariExcludeNativeCacheFilesFromBackup(CanariTauriDataDir())');
    expect(pass).toContain('containerURLForSecurityApplicationGroupIdentifier');
    expect(iosMm).not.toContain('NSURLIsExcludedFromBackupKey');
  });

  it('every writer re-applies it after its atomic write', () => {
    // An atomic write is a new inode renamed over the old one: the flag does not travel.
    const append = between(pushMm, /static void CanariAppendFcmCacheEntry\(/, /\n}\n/);
    const drain = between(pushMm, /void CanariDrainAppGroupFcmCache\(void\) \{/, /\n}\n/);
    const mirror = between(pushMm, /void CanariMirrorPushStateToAppGroup\(void\) \{/, /\n}\n/);
    expect(append).toMatch(
      /writeToFile:path[^\n]*\n\s*CanariExcludeNativeCacheFilesFromBackup\(dir\);/
    );
    expect(drain).toMatch(
      /writeToFile:path[^\n]*\n\s*CanariExcludeNativeCacheFilesFromBackup\(dst\);/
    );
    expect(mirror).toContain('CanariExcludeNativeCacheFilesFromBackup(container.path);');
    const nse = between(swift, /private func writeFcmCache\(/, /\n {2}}\n/);
    expect(nse).toMatch(
      /\.completeFileProtectionUntilFirstUserAuthentication\]\)\n\s*Self\.excludeFromBackup\(fileUrl\)/
    );
    const rustWriter = between(pushRs, /fn with_graine_mirror_inner</, /\n}\n/);
    expect(rustWriter).toMatch(
      /fs::rename\(&tmp, &path\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*crate::native_cache::exclude_from_backup\(&path\);/
    );
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
