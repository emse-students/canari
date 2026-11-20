import { readdirSync, readFileSync } from 'node:fs';
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
const backupExclusionRs = read('../../../src-tauri/src/backup_exclusion.rs');
const libRs = read('../../../src-tauri/src/lib.rs');

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
    // And the push's account, which binds every ledger write to its own slot (re-review of #2919).
    expect(firebaseKt).toContain(
      'nativeKeyGroupJoinClaim(filesDir, cacheKey, ctx.userId, groupId)'
    );
    expect(firebaseKt).toMatch(
      /nativeKeyGroupJoinSettle\(filesDir, cacheKey, ctx\.userId, groupId,/
    );
    expect(firebaseKt).not.toMatch(/File\([^)]*"key_group_push_joins\.json"\)/);
  });
});

describe('iOS keeps every local store out of backups: directories in Rust, the caches per file natively', () => {
  it('the launch pass excludes the directories, before the WebView exists', () => {
    // Since 1.7.2 nothing local may travel to another phone (mobile.md, "Nothing local travels to
    // another phone"): the data directory, WebKit's stores and the App Group's store are flagged
    // whole - never the App Group root, which refuses the flag (1.7.2-alpha.1).
    for (const dir of ['Library/Application Support', 'Library/WebKit', 'Library/Preferences']) {
      expect(backupExclusionRs).toContain(`"${dir}",`);
    }
    expect(backupExclusionRs).toContain('label: APP_GROUP_LABEL,');
    // WebKit creates its stores on the page's first storage access: the pass must come first.
    const setup = libRs.slice(libRs.indexOf('.setup(move |app| {'));
    const pass = setup.indexOf('backup_exclusion::exclude_install_from_backup(');
    expect(pass).toBeGreaterThan(0);
    expect(setup.indexOf('tauri::WebviewWindowBuilder::new(')).toBeGreaterThan(pass);
  });

  it('the native side excludes only the two cache files, never a directory', () => {
    // A directory flag has ONE writer, the Rust launch pass above; the native per-file pass
    // predates it and is redundant until the iPhone reading retires it.
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
    expect(pass).toContain('CanariExcludeNativeCacheFilesFromBackup(CanariAppGroupPath())');
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

describe('iOS: every App Group resolver answers the store, never the container root', () => {
  // The App Group root refuses the backup flag (1.7.2-alpha.1, the bench iPhone): whatever is
  // written there travels in a backup. So every process resolves the App Group to ONE directory of
  // ours inside it, flagged at creation, and moves an older build's root entries into it before
  // its first use (backup_exclusion.rs, module doc). A resolver that asks Foundation for the
  // container and writes there compiles and works - and puts mls.bin back into the backup.
  const RUST_SRC = resolve(here, '../../../src-tauri/src');
  const shareSwift = read('../../../src-tauri/gen/apple/canari_Share/ShareCapture.swift');
  const appGroupRs = read('../../../src-tauri/src/app_group.rs');
  const iosFfiRs = read('../../../src-tauri/src/mobile/ios_ffi.rs');

  it('names the store once per language, the same name', () => {
    const rust = /pub\(crate\) const APP_GROUP_STORE: &str = "([^"]+)";/.exec(backupExclusionRs);
    const swiftName = /static let storeDirName = "([^"]+)"/.exec(shareSwift);
    expect(rust?.[1]).toBeTruthy();
    expect(swiftName?.[1]).toBe(rust?.[1]);
  });

  it('asks Foundation for the container in exactly one function per process kind', () => {
    // Rust (the app, and the notification extension through the FFI): `app_group_container`, read
    // only by the store's opener and the launch verdict.
    const rustFiles = readdirSync(RUST_SRC, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.rs'));
    const asking = rustFiles.filter((f) =>
      read(resolve(RUST_SRC, f)).includes('containerURLForSecurityApplicationGroupIdentifier')
    );
    expect(asking).toEqual(['app_group.rs']);
    const containerCallers = rustFiles.filter((f) =>
      read(resolve(RUST_SRC, f)).includes('app_group_container()')
    );
    expect(containerCallers.sort()).toEqual(['app_group.rs', 'backup_exclusion.rs']);
    const resolver = between(appGroupRs, /pub\(crate\) fn app_group_dir\(\)/, /\n}\n/);
    expect(resolver).toContain('crate::backup_exclusion::open_store(&root,');
    expect(iosFfiRs).toMatch(
      /pub extern "C" fn canari_app_group_store_dir\(\)[^{]*\{\s*match crate::app_group::app_group_dir\(\)/
    );
    // The app's Objective-C and the notification extension reach Rust's resolver.
    for (const source of [iosMm, pushMm]) {
      expect(source).not.toContain('containerURLForSecurityApplicationGroupIdentifier');
    }
    expect(
      between(pushMm, /NSString \*_Nullable CanariAppGroupPath\(void\) \{/, /\n}\n/)
    ).toContain('canari_app_group_store_dir()');
    expect(swift).not.toContain('containerURL(forSecurityApplicationGroupIdentifier');
    expect(
      between(swift, /private static func appGroupDir\(\) -> URL\? \{/, /\n {2}}\n/)
    ).toContain('canari_app_group_store_dir()');
    // The share extension links no Rust: its one resolver opens the store as Rust does.
    expect(shareSwift.match(/containerURL\(/g)?.length).toBe(1);
    const storeDir = between(shareSwift, /private func storeDir\(\) -> URL\? \{/, /\n {4}}\n/);
    expect(storeDir).toContain('containerURL(');
    // Flagged created or found, then the move - in that order, as `open_store` does.
    expect(storeDir.indexOf('excludeFromBackup(store)')).toBeGreaterThan(
      storeDir.indexOf('mkdir(store.path')
    );
    expect(
      storeDir.indexOf('moveRootIntoStore(container: container, store: store)')
    ).toBeGreaterThan(storeDir.indexOf('excludeFromBackup(store)'));
    expect(storeDir).not.toMatch(/if mkdir\(store\.path[^\n]*\n[^\n]*\n\s*excludeFromBackup/);
    const move = between(shareSwift, /private func moveRootIntoStore\(/, /\n {4}}\n/);
    expect(move).toContain('flock(fd, LOCK_EX)');
    expect(move).toContain('renamex_np(from, to, UInt32(RENAME_EXCL))');
    expect(move).toContain('guard ShareCapture.isOurs(name) else {');
    expect(move).toContain('name != "Library" && !name.hasPrefix(".com.apple.")');
    expect(backupExclusionRs).toContain('name == "Library" || name.starts_with(".com.apple.")');
    expect(backupExclusionRs).toContain('libc::flock(dir.as_raw_fd(), libc::LOCK_EX)');
  });

  it('moves only an allowlist, the same in Rust and in Swift', () => {
    const list = (source: string, re: RegExp) =>
      [...(re.exec(source)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    const rustStems = list(
      backupExclusionRs,
      /pub\(crate\) const OURS_STEMS: \[&str; \d+\] = \[([^\]]+)\]/
    );
    const rustPrefixes = list(
      backupExclusionRs,
      /pub\(crate\) const OURS_PREFIXES: \[&str; \d+\] = \[([^\]]+)\]/
    );
    expect(rustStems.length).toBeGreaterThan(10);
    expect(list(shareSwift, /static let rootStems = \[([^\]]+)\]/)).toEqual(rustStems);
    expect(list(shareSwift, /static let rootPrefixes = \[([^\]]+)\]/)).toEqual(rustPrefixes);
    expect(shareSwift).toContain(
      /pub\(crate\) const SUPERSEDED_DIR: &str = "([^"]+)";/.exec(backupExclusionRs)?.[1] ??
        'missing'
    );
  });

  it('says the opening once in the notification extension, which has no Rust logger', () => {
    const resolver = between(swift, /private static func appGroupDir\(\) -> URL\? \{/, /\n {2}}\n/);
    expect(resolver).toContain('_ = storeOpeningLogged');
    const once = between(
      swift,
      /private static let storeOpeningLogged: Void = \{/,
      /\n {2}}\(\)\n/
    );
    expect(once).toContain('canari_app_group_store_report(&severity)');
    expect(iosFfiRs).toContain(
      'pub unsafe extern "C" fn canari_app_group_store_report(severity: *mut i32)'
    );
  });
});
