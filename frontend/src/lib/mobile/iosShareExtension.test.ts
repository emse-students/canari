import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE iOS SHARE EXTENSION IS THREE LANGUAGES AND A HAND-MAINTAINED PROJECT, AND NOTHING ON THIS
 * MACHINE COMPILES ANY OF IT.
 *
 * The extension (`gen/apple/canari_Share/`, Swift) copies under Android's rules
 * (`share/ShareRules.kt`, `share/SharedFileName.kt`) and writes a manifest the app (Rust,
 * `commands/app_group_share.rs`) carries out of the App Group; the native side (`canari_ios.mm`,
 * `canari_push.mm`) names the signal and the banner. Every one of those agreements is a string or a
 * number duplicated across languages, and a drift is silent: a share that never imports, or a
 * banner the app treats as a push. This reads the sources and fails on the drift instead.
 *
 * The pbxproj half pins what Xcode alone would otherwise say: the target exists, is embedded, is
 * built before the app, is signed with its own profile and versioned with the NSE (whose lines
 * `scripts/bump-app-version.sh` rewrites together). See `docs/wiki/frontend/sharing.md`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TAURI = resolve(here, '../../../src-tauri');
const APPLE = resolve(TAURI, 'gen/apple');
const SHARE = resolve(APPLE, 'canari_Share');
const KOTLIN = resolve(TAURI, 'gen/android/app/src/main/java/fr/emse/canari');
const REPO = resolve(TAURI, '../..');

const read = (path: string) => readFileSync(path, 'utf8');

const swiftRules = read(resolve(SHARE, 'ShareRules.swift'));
const swiftCapture = read(resolve(SHARE, 'ShareCapture.swift'));
const swiftController = read(resolve(SHARE, 'ShareViewController.swift'));
const kotlinRules = read(resolve(KOTLIN, 'share/ShareRules.kt'));
const kotlinName = read(resolve(KOTLIN, 'share/SharedFileName.kt'));
const kotlinShare = read(resolve(KOTLIN, 'IncomingShare.kt'));
const pbxproj = read(resolve(APPLE, 'canari.xcodeproj/project.pbxproj'));

/** The first capture of `re` in `source`, failing the test when there is none. */
function capture(source: string, re: RegExp): string {
  const match = re.exec(source);
  expect(match, `${re} matched nothing`).not.toBeNull();
  return match![1];
}

/**
 * `xml` with every `<!-- ... -->` comment cut out, in one left-to-right pass: a regex replace can
 * splice two halves into a new comment opener, a split on the opener cannot. An unclosed comment
 * runs to the end, as an XML reader would read it.
 */
function withoutXmlComments(xml: string): string {
  return xml
    .split('<!--')
    .map((part, i) => {
      if (i === 0) return part;
      const end = part.indexOf('-->');
      return end < 0 ? '' : part.slice(end + '-->'.length);
    })
    .join('');
}

/** `200L * 1024 * 1024` or `200 * 1024 * 1024` evaluated - a product of integer literals. */
function product(expr: string): number {
  return expr
    .replace(/L/g, '')
    .split('*')
    .map((n) => Number(n.trim()))
    .reduce((a, b) => a * b, 1);
}

describe('the Share Extension copies under Android rules', () => {
  it('has the same file count and byte ceilings as ShareRules.kt', () => {
    expect(Number(capture(swiftRules, /static let maxFiles = (\d+)/))).toBe(
      Number(capture(kotlinRules, /const val MAX_FILES = (\d+)/))
    );
    for (const [swift, kotlin] of [
      ['maxFileBytes', 'MAX_FILE_BYTES'],
      ['maxTotalBytes', 'MAX_TOTAL_BYTES'],
    ]) {
      const s = product(capture(swiftRules, new RegExp(`static let ${swift}: Int64 = ([\\d *]+)`)));
      const k = product(capture(kotlinRules, new RegExp(`const val ${kotlin} = ([\\dL *]+)`)));
      expect(s, swift).toBe(k);
      expect(s).toBeGreaterThan(0);
    }
  });

  it('keeps the same characters, length and generic name as SharedFileName.kt', () => {
    // Kotlin's class `[^A-Za-z0-9._ -]` and Swift's explicit set must keep exactly the same ASCII.
    const kotlinClass = new RegExp(capture(kotlinName, /Regex\("(\[\^[^"]+\])"\)/));
    const swiftSet = new Set(capture(swiftRules, /CharacterSet\(charactersIn: "([^"]+)"\)/));
    for (let code = 0; code < 128; code++) {
      const ch = String.fromCharCode(code);
      expect(swiftSet.has(ch), `0x${code.toString(16)}`).toBe(!kotlinClass.test(ch));
    }
    expect(Number(capture(swiftRules, /static let maxLength = (\d+)/))).toBe(
      Number(capture(kotlinName, /\.take\((\d+)\)/))
    );
    expect(kotlinName).toContain('"shared.$extension"');
    expect(swiftRules).toContain('"shared.\\(ext)"');
    expect(kotlinName).toContain('ifEmpty { "bin" }');
    expect(swiftRules).toContain('ext = "bin"');
  });
});

describe('the names the extension, the app and Android share', () => {
  const rust = read(resolve(TAURI, 'src/commands/handoff.rs'));
  const rustInbox = read(resolve(TAURI, 'src/commands/picked_files.rs'));
  const rustGroup = read(resolve(TAURI, 'src/commands/app_group_share.rs'));
  const rustAppGroup = read(resolve(TAURI, 'src/app_group.rs'));

  it.each([
    ['pendingFile', /PENDING_FILE = "([^"]+)"/, rust, /PENDING_SHARE_FILE: &str = "([^"]+)"/],
    ['inboxDir', /INBOX_DIR = "([^"]+)"/, rustInbox, /SHARED_INBOX: &str = "([^"]+)"/],
    ['epochFile', /EPOCH_FILE = "([^"]+)"/, rust, /SHARE_EPOCH_FILE: &str = "([^"]+)"/],
  ])('%s is the same in Swift, Kotlin and Rust', (swiftName, kotlinRe, rustSource, rustRe) => {
    const swift = capture(swiftCapture, new RegExp(`static let ${swiftName} = "([^"]+)"`));
    expect(capture(kotlinShare, kotlinRe)).toBe(swift);
    expect(capture(rustSource, rustRe)).toBe(swift);
  });

  it('locks the same file and names the same App Group as the app', () => {
    expect(capture(rustGroup, /GROUP_LOCK_FILE: &str = "([^"]+)"/)).toBe(
      capture(swiftCapture, /static let lockFile = "([^"]+)"/)
    );
    const group = capture(swiftCapture, /static let appGroupId = "([^"]+)"/);
    expect(rustAppGroup).toContain(`"${group}"`);
    expect(read(resolve(SHARE, 'canari_Share.entitlements'))).toContain(
      `<string>${group}</string>`
    );
  });

  it('writes a waiting share locked with the device: the folder, every copy, the manifest', () => {
    // `CompleteUnlessOpen`: a closed file is unreadable while the phone is locked, and a capture the
    // lock interrupts can still finish (sharing.md, "At rest"). Never plain `Complete` here.
    expect(swiftCapture).toMatch(
      /static let lockedAtRest: \[FileAttributeKey: Any\] = \[\.protectionKey: FileProtectionType\.completeUnlessOpen\]/
    );
    expect(swiftCapture).toMatch(
      /createDirectory\(\s*at: dir, [^)]*attributes: ShareCapture\.lockedAtRest\)/
    );
    expect(swiftCapture).toMatch(
      /createFile\(\s*atPath: target\.path, [^)]*attributes: ShareCapture\.lockedAtRest\)/
    );
    expect(swiftCapture).toMatch(
      /data\.write\(to: staging, options: \[\.completeFileProtectionUnlessOpen\]\)/
    );
    expect(swiftCapture).not.toMatch(/FileProtectionType\.complete\b(?!UnlessOpen)/);
    expect(swiftCapture).not.toMatch(/\.completeFileProtection\b(?!UnlessOpen)/);
  });

  it('puts a locked waiting manifest back, classified by domain and code, never deleted', () => {
    const claimBody = swiftCapture.slice(
      swiftCapture.indexOf('private func claimPending('),
      swiftCapture.indexOf('private func deleteClaim(')
    );
    // The put-back comes before any delete, and refuses to overwrite what landed meanwhile.
    expect(claimBody).toContain('if ShareCapture.isLockedRead(error) {');
    expect(claimBody).toContain('renamex_np(claimed.path, pending, UInt32(RENAME_EXCL))');
    expect(claimBody.indexOf('return .locked')).toBeLessThan(claimBody.indexOf('deleteClaim('));
    const locked = swiftCapture.slice(
      swiftCapture.indexOf('static func isLockedRead('),
      swiftCapture.indexOf('private func writePending(')
    );
    expect(locked).toContain('NSPOSIXErrorDomain');
    expect(locked).toContain('Int(EPERM)');
    expect(locked).toContain('NSUnderlyingErrorKey');
    expect(locked).not.toMatch(/localizedDescription|\.description/);
    // The Rust side reads the same code, and puts back the same way (handoff.rs).
    const handoff = read(resolve(TAURI, 'src/commands/handoff.rs'));
    expect(handoff).toContain('const EPERM: i32 = 1;');
    expect(handoff).toContain('libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL)');
  });

  it('asks UIKit about the lock only where the application object exists', () => {
    const ios = read(resolve(APPLE, 'Sources/canari/canari_ios.mm'));
    // The bootstrap runs before `ffi::start_app()` creates the application object: a question put
    // to it there answers NO on every launch, and skipped the sweep on every cold start.
    const bootstrap = ios.slice(
      ios.indexOf('void canari_ios_bootstrap(void) {'),
      ios.indexOf('bool canari_ios_is_in_foreground(void)')
    );
    expect(bootstrap).not.toContain('isProtectedDataAvailable');
    expect(bootstrap).toContain('CanariImportAppGroupShare(@"launch")');
    const importBody = ios.slice(
      ios.indexOf('static BOOL CanariImportAppGroupShare('),
      ios.indexOf('static void CanariImportAppGroupShareIfUnlocked(')
    );
    expect(importBody).not.toContain('isProtectedDataAvailable');
    expect(ios.match(/isProtectedDataAvailable/g)?.length).toBe(1);
    expect(ios).toContain('CanariImportAppGroupShareIfUnlocked(@"activation")');
    expect(ios).toContain('CanariImportAppGroupShareIfUnlocked(@"share ready")');
    // The unlock imports, and offers a share a locked drain left in the app data (no timer).
    expect(bootstrap).toMatch(
      /addObserverForName:UIApplicationProtectedDataDidBecomeAvailable\s[^}]*CanariOnProtectedDataAvailable\(\)/
    );
    const unlockStart = ios.indexOf('static void CanariOnProtectedDataAvailable(void) {');
    const unlock = ios.slice(unlockStart, ios.indexOf('\n}\n', unlockStart));
    expect(unlock).toContain('CanariShareManifestWaits(CanariTauriDataDir())');
    expect(unlock).toContain('CanariTellPageOfShare(@"unlock")');
    // The manifest the native side stats is the one Rust writes.
    const header = read(resolve(APPLE, 'Sources/canari/canari_rust_bridge.h'));
    expect(capture(header, /#define CANARI_SHARE_PENDING_FILE "([^"]+)"/)).toBe(
      capture(
        read(resolve(TAURI, 'src/commands/handoff.rs')),
        /PENDING_SHARE_FILE: &str = "([^"]+)"/
      )
    );
  });

  it('answers the native side in codes both sides read the same way', () => {
    // The launch import and sweep run before the Rust logger exists: their codes ARE the log.
    const header = read(resolve(APPLE, 'Sources/canari/canari_rust_bridge.h'));
    const rustConst = (name: string) =>
      capture(rustGroup, new RegExp(`const ${name}: (?:i32|u32) = ([^;]+);`));
    const headerDefine = (name: string) =>
      capture(header, new RegExp(`#define CANARI_SHARE_${name} \\(?([^)\\n]+)\\)?\\n`));
    const asNumber = (expr: string) => {
      const shift = /^1u? << (\d+)$/.exec(expr.trim());
      return shift ? 1 << Number(shift[1]) : Number(expr.trim());
    };
    const imports = [
      'IMPORTED',
      'NOTHING',
      'BUSY',
      'DROPPED',
      'PROTECTED',
      'DROPPED_OVER_LOCKED',
      'NO_DIRS',
      'NO_GROUP',
      'FAILED',
    ];
    // Every code is said by its own case: at launch that line is the only logger.
    const ios = read(resolve(APPLE, 'Sources/canari/canari_ios.mm'));
    for (const name of imports) {
      expect(asNumber(headerDefine(`IMPORT_${name}`)), name).toBe(
        asNumber(rustConst(`IMPORT_${name}`))
      );
      expect(ios, name).toContain(`case CANARI_SHARE_IMPORT_${name}:`);
    }
    expect([...rustGroup.matchAll(/const IMPORT_(\w+): i32/g)].map((m) => m[1]).sort()).toEqual(
      [...imports].sort()
    );
    // A drop over a locked share is a loss, said at ERROR.
    expect(ios).toMatch(/case CANARI_SHARE_IMPORT_DROPPED_OVER_LOCKED:[^;]*ERROR/);
    const sweeps = [...rustGroup.matchAll(/const SWEEP_(\w+): u32/g)].map((m) => m[1]);
    expect(sweeps.length).toBe(12);
    for (const name of sweeps) {
      expect(asNumber(headerDefine(`SWEEP_${name}`)), name).toBe(
        asNumber(rustConst(`SWEEP_${name}`))
      );
    }
    // The struct the sweep returns has the same fields, in the same order, on both sides.
    const rustFields = [
      ...capture(rustGroup, /pub struct CanariShareSweep \{([^}]+)\}/).matchAll(
        /pub (\w+): (\w+)/g
      ),
    ].map((m) => `${m[2]} ${m[1]}`);
    const cFields = [
      ...capture(header, /typedef struct \{([^}]+)\} CanariShareSweep;/).matchAll(
        /(\w+)_t (\w+);/g
      ),
    ].map((m) => `${m[1].replace('int', 'i').replace('ui', 'u')} ${m[2]}`);
    expect(cFields).toEqual(rustFields);
    expect(rustGroup).toContain('#[repr(C)]');
  });

  it('sweeps exactly the leftover names the two writers can leave', () => {
    const pendingFile = capture(swiftCapture, /static let pendingFile = "([^"]+)"/);
    const names = (constant: string) =>
      [
        ...capture(
          rustGroup,
          new RegExp(`${constant}: \\[&str; \\d+\\] = \\[([^\\]]+)\\]`)
        ).matchAll(/"([^"]+)"/g),
      ]
        .map((m) => m[1])
        .sort();
    // A claim holds a whole share: put back, or deleted as lost - said either way.
    expect(names('CLAIM_LEFTOVERS')).toEqual(
      [
        `${pendingFile}.draining`, // the page's drain (handoff::take_handoff)
        `${pendingFile}.importing`, // the app's claim (import_group_share)
        `${pendingFile}.replacing`, // the extension's claim, and the app's hand-over and sweep claims
      ].sort()
    );
    expect(names('STAGING_LEFTOVERS')).toEqual(
      [
        `${pendingFile}.tmp`, // either side's manifest write
        `${capture(swiftCapture, /static let epochFile = "([^"]+)"/)}.tmp`, // the epoch copy's write
      ].sort()
    );
    expect(swiftCapture).toContain('ShareCapture.pendingFile + ".replacing"');
    expect(swiftCapture).toContain('ShareCapture.pendingFile + ".tmp"');
    expect(rustGroup).toContain('claim(group, PENDING_SHARE_FILE, "importing", read)');
    expect(read(resolve(TAURI, 'src/commands/handoff.rs'))).toContain(
      'claim_and_read(dir, name, "draining", read_handoff)'
    );
  });

  it('tells the app a share is ready only once the lock is released, under an expiring activity', () => {
    // postReady is called once, from run(), after captureLocked() - whose defer releases the lock.
    expect(swiftCapture.match(/\bpostReady\(\)/g)?.length).toBe(2); // the call and the definition
    const run = swiftCapture.slice(
      swiftCapture.indexOf('func run(items:'),
      swiftCapture.indexOf('private func captureLocked(')
    );
    expect(run).toContain('performExpiringActivity');
    expect(run.indexOf('self.captureLocked(items: items)')).toBeLessThan(
      run.indexOf('postReady()')
    );
  });

  it('signals and announces with the names the native app listens for', () => {
    const ios = read(resolve(APPLE, 'Sources/canari/canari_ios.mm'));
    const push = read(resolve(APPLE, 'Sources/canari/canari_push.mm'));
    const ready = capture(swiftCapture, /static let readyNotification = "([^"]+)"/);
    expect(ios).toContain(`CFSTR("${ready}")`);
    const id = capture(swiftController, /UNNotificationRequest\(identifier: "([^"]+)"/);
    expect(ios).toContain(`kCanariShareNotificationId = @"${id}"`);
    // The banner's tap is recognised by this key, so it never reaches the push routing.
    expect(swiftController).toContain('content.userInfo = ["canariLocal": "incoming_share"]');
    expect(push).toContain('userInfo[@"canariLocal"] isEqualToString:@"incoming_share"');
  });
});

describe('a waiting share at rest and in the logs', () => {
  const rustGroup = read(resolve(TAURI, 'src/commands/app_group_share.rs'));
  const rustPicked = read(resolve(TAURI, 'src/commands/picked_files.rs'));

  /** The body of the Swift or Rust function `name`, up to the next one. */
  function body(source: string, start: string, end: string): string {
    const from = source.indexOf(start);
    expect(from, start).toBeGreaterThanOrEqual(0);
    return source.slice(from, source.indexOf(end, from + start.length));
  }

  it('keeps both iOS manifests and the App Group inbox out of backups, after every write', () => {
    const swiftWrite = body(swiftCapture, 'private func writePending(', 'private func deleteDir(');
    // After the rename: the rename is a new inode, and the flag does not travel with the name.
    expect(swiftWrite.indexOf('excludeFromBackup(URL(fileURLWithPath: target))')).toBeGreaterThan(
      swiftWrite.indexOf('rename(staging.path, target) == 0')
    );
    expect(swiftCapture).toContain('values.isExcludedFromBackup = true');
    const captureBody = body(swiftCapture, 'private func captureLocked(', 'static func isSafeId(');
    expect(captureBody).toContain('excludeFromBackup(inbox)');
    // Never the App Group root: it also holds what a restore must bring back.
    expect(swiftCapture).not.toContain('excludeFromBackup(container)');

    const rustWrite = body(rustGroup, 'fn write_pending(', 'fn delete_share_dir(');
    expect(rustWrite.indexOf('native_cache::exclude_from_backup(&target)')).toBeGreaterThan(
      rustWrite.indexOf('std::fs::rename(&staging, &target)')
    );
  });

  it('bounds the text a share keeps, and counts what passes the bound as refused', () => {
    expect(product(capture(swiftRules, /static let maxTextBytes = ([\d *]+)/))).toBe(1024 * 1024);
    const loop = body(swiftCapture, 'private func captureLocked(', 'static func isSafeId(');
    // The typed text, every text attachment and every link go through the one ceiling.
    expect(loop.match(/fitsTextCeiling\(/g)?.length).toBe(3);
    expect(swiftCapture).toContain('if held + size > ShareRules.maxTextBytes');
  });

  it('never logs the path of a picked or shared copy', () => {
    // A copy is `<index>_<sender's file name>`; a picker's keeps the photo's own name.
    expect(rustPicked).not.toMatch(/canonical\.display\(\)/);
    expect(rustPicked).not.toMatch(/dir\.display\(\)/);
  });
});

describe('the extension bundle', () => {
  it('holds the App Group and nothing else', () => {
    const ent = withoutXmlComments(read(resolve(SHARE, 'canari_Share.entitlements')));
    expect([...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual([
      'com.apple.security.application-groups',
    ]);
  });

  it('is a share-services extension activated for at most maxFiles items', () => {
    const info = read(resolve(SHARE, 'Info.plist'));
    expect(info).toContain('<string>com.apple.share-services</string>');
    expect(info).toContain('<string>$(PRODUCT_MODULE_NAME).ShareViewController</string>');
    const maxFiles = capture(swiftRules, /static let maxFiles = (\d+)/);
    for (const kind of ['Image', 'Movie', 'File']) {
      expect(
        capture(info, new RegExp(`ActivationSupports${kind}WithMaxCount</key>\\s*<integer>(\\d+)`)),
        kind
      ).toBe(maxFiles);
    }
  });

  it('carries the same strings in French and English, every key the Swift asks for', () => {
    const keysOf = (lang: string) =>
      [...read(resolve(SHARE, `${lang}.lproj/Localizable.strings`)).matchAll(/^"([^"]+)"\s*=/gm)]
        .map((m) => m[1])
        .sort();
    const fr = keysOf('fr');
    expect(fr).toEqual(keysOf('en'));
    const asked = new Set(
      [...swiftController.matchAll(/NSLocalizedString\("([^"]+)"/g)].map((m) => m[1])
    );
    expect([...asked].sort()).toEqual(fr);
  });
});

describe('the conversation suggestions (lot S5, the iOS twin of Android sharing shortcuts)', () => {
  const PLUGIN = resolve(TAURI, 'plugins/tauri-plugin-gallery');
  const suggestions = read(resolve(PLUGIN, 'ios/Sources/ShareSuggestions.swift'));
  const plugin = read(resolve(PLUGIN, 'ios/Sources/GalleryPlugin.swift'));
  const mobileRs = read(resolve(PLUGIN, 'src/mobile.rs'));
  const commandsRs = read(resolve(PLUGIN, 'src/commands.rs'));
  const kotlinTargets = read(resolve(PLUGIN, 'android/src/main/java/ShareTargets.kt'));
  const native = read(resolve(here, '../sharing/shareTargetsNative.ts'));

  it('declares INSendMessageIntent among the extension attributes, or the sheet offers none', () => {
    const info = withoutXmlComments(read(resolve(SHARE, 'Info.plist')));
    const attributes = capture(
      info,
      /<key>NSExtensionAttributes<\/key>\s*<dict>([\s\S]*)<\/dict>\s*<key>NSExtensionPointIdentifier/
    );
    expect(attributes).toMatch(
      /<key>IntentsSupported<\/key>\s*<array>\s*<string>INSendMessageIntent<\/string>\s*<\/array>/
    );
  });

  it('donates one outgoing INSendMessageIntent per target, in its own group', () => {
    expect(suggestions).toContain('import Intents');
    expect(suggestions).toMatch(/INSendMessageIntent\(\s*recipients: nil,/);
    expect(suggestions).toContain('conversationIdentifier: target.id,');
    expect(suggestions).toContain(
      'speakableGroupName: INSpeakableString(spokenPhrase: target.label)'
    );
    expect(suggestions).toContain('interaction.groupIdentifier = groupIdentifier');
    expect(suggestions).toContain('interaction.direction = .outgoing');
    expect(suggestions).toContain('interaction.donate {');
    expect(capture(suggestions, /static let groupIdentifier = "([^"]+)"/)).toBe(
      'fr.emse.canari.share-suggestions'
    );
  });

  it('deletes by its own group identifier - before every publish and at every clear', () => {
    // ONE delete, the group's: never `deleteAll`, which would take what the system learned of the
    // app beyond the suggestions.
    expect(suggestions).not.toContain('deleteAll');
    expect(suggestions.match(/INInteraction\.delete\(with: groupIdentifier\)/g)?.length).toBe(1);
    const publish = capture(
      suggestions,
      /static func publish\(([\s\S]*?)\n {2}\/\/\/ Deletes every/
    );
    expect(publish.indexOf('deleteGroup()')).toBeGreaterThan(-1);
    expect(publish.indexOf('deleteGroup()')).toBeLessThan(publish.indexOf('donate(target)'));
    // A failed delete donates nothing: the old account's suggestions must not stay beside these.
    expect(publish).toMatch(
      /if let code = deleteGroup\(\) \{[\s\S]*?done\(\.failure[\s\S]*?return\s*\}/
    );
    const clear = capture(
      suggestions,
      /static func clear\(([\s\S]*?)\n {2}\/\/\/ Deletes the donation group/
    );
    expect(clear).toContain('deleteGroup()');
  });

  it('validates a target with the bounds Android and the page use', () => {
    expect(capture(suggestions, /static let idPrefix = "([^"]+)"/)).toBe(
      capture(kotlinTargets, /ID_PREFIX = "([^"]+)"/)
    );
    expect(capture(suggestions, /static let maxIdLength = (\d+)/)).toBe(
      capture(kotlinTargets, /MAX_ID_LENGTH = (\d+)/)
    );
    expect(capture(suggestions, /static let maxLabelLength = (\d+)/)).toBe(
      capture(kotlinTargets, /MAX_LABEL_LENGTH = (\d+)/)
    );
    expect(capture(suggestions, /static let maxIdLength = (\d+)/)).toBe(
      capture(native, /MAX_SHARE_TARGET_ID_LENGTH = (\d+)/)
    );
  });

  it('answers the commands the Rust side runs on iOS, which it no longer refuses there', () => {
    for (const name of ['publishShareTargets', 'clearShareTargets']) {
      expect(mobileRs).toContain(`"${name}"`);
      expect(plugin).toContain(`@objc public func ${name}(_ invoke: Invoke)`);
    }
    expect(plugin).toContain(
      'invoke.resolve(["present": published.present, "leftover": published.leftover])'
    );
    expect(plugin).toContain('invoke.resolve(["removed": removed])');
    const publish = capture(commandsRs, /(fn publish_share_targets[\s\S]*?\n\})/);
    const clear = capture(commandsRs, /(fn clear_share_targets[\s\S]*?\n\})/);
    for (const body of [publish, clear]) {
      expect(body).toContain('#[cfg(mobile)]');
      expect(body).not.toContain('AndroidOnly');
    }
  });

  it('carries the picked suggestion into the manifest as Android does', () => {
    expect(swiftController).toContain('import Intents');
    expect(swiftController).toContain('extensionContext?.intent as? INSendMessageIntent');
    expect(swiftController).toContain('ShareRules.suggestedTarget(intent.conversationIdentifier)');
    expect(swiftController).toContain('ShareCapture().run(items: items, target: target)');
    expect(swiftCapture).toContain('outcome = self.captureLocked(items: items, target: target)');
    // Android's key, which the Rust import carries through and `sharedInbox.ts` reads.
    expect(kotlinShare).toContain('payload.put("target", target)');
    expect(swiftCapture).toContain('payload["target"] = target');
    // The same shape and bound as Android's `suggestedTarget`.
    expect(kotlinShare).toContain('id.startsWith("c:") && id.length in 3..200');
    expect(swiftRules).toContain('id.hasPrefix("c:") && (3...200).contains(id.count)');
  });

  it('erases the suggestions at sign-out on iOS too, and no conversation shortcut it never had', () => {
    const erase = capture(native, /(export function eraseAccountShortcuts[\s\S]*?\n\})/);
    expect(erase).toContain('if (!isMobileTauriRuntime()) return Promise.resolve();');
    expect(erase).toContain('clearShareTargets(reason, { force: true })');
    expect(erase).toContain('if (!isAndroidTauriRuntime()) return suggestions;');
    const auth = read(resolve(here, '../stores/auth.ts'));
    expect(auth).toContain("eraseAccountShortcuts('signed out')");
  });
});

/** A value of an old-style (OpenStep) property list, which is what a pbxproj is. */
type Pbx = string | Pbx[] | { [key: string]: Pbx };
type PbxDict = { [key: string]: Pbx };

/**
 * Parses a pbxproj, and THROWS on anything Xcode would refuse: an unclosed object, a missing `;`,
 * a key defined twice, trailing text. A scanner, not a regex: a `/*` or a brace inside a quoted
 * string is text, and an object left open is found here rather than by `xcodebuild` on a runner.
 * (A regex slice to the next `\t\t};` once read straight past two unterminated configurations.)
 */
function parsePbxproj(src: string): PbxDict {
  let i = 0;
  const fail = (what: string): never => {
    const line = src.slice(0, i).split('\n').length;
    throw new Error(`pbxproj line ${line}: ${what}`);
  };
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) fail('unterminated comment');
        i = end + 2;
      } else if (src.startsWith('//', i)) {
        const end = src.indexOf('\n', i);
        i = end < 0 ? src.length : end + 1;
      } else return;
    }
  };
  const expectChar = (c: string) => {
    skip();
    if (src[i] !== c) fail(`expected '${c}', found '${src[i] ?? 'end of file'}'`);
    i++;
  };
  const scalar = (): string => {
    skip();
    if (src[i] === '"') {
      let out = '';
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\') i++;
        out += src[i];
      }
      if (i >= src.length) fail('unterminated string');
      i++;
      return out;
    }
    const start = i;
    while (
      i < src.length &&
      /[A-Za-z0-9_$+\-./:]/.test(src[i]) &&
      !src.startsWith('/*', i) &&
      !src.startsWith('//', i)
    ) {
      i++;
    }
    if (i === start) fail(`unexpected '${src[i] ?? 'end of file'}'`);
    return src.slice(start, i);
  };
  const value = (): Pbx => {
    skip();
    if (src[i] === '{') {
      i++;
      const dict: PbxDict = {};
      for (;;) {
        skip();
        if (i >= src.length) fail('unclosed {');
        if (src[i] === '}') {
          i++;
          return dict;
        }
        const key = scalar();
        expectChar('=');
        const v = value();
        expectChar(';');
        if (Object.hasOwn(dict, key)) fail(`${key} defined twice`);
        dict[key] = v;
      }
    }
    if (src[i] === '(') {
      i++;
      const list: Pbx[] = [];
      for (;;) {
        skip();
        if (i >= src.length) fail('unclosed (');
        if (src[i] === ')') {
          i++;
          return list;
        }
        list.push(value());
        skip();
        if (src[i] === ',') i++;
        else if (src[i] !== ')') fail(`expected ',' or ')', found '${src[i]}'`);
      }
    }
    return scalar();
  };
  const root = value();
  skip();
  if (i !== src.length) fail('text after the root object');
  if (typeof root !== 'object' || Array.isArray(root)) fail('the root is not a dictionary');
  return root as PbxDict;
}

describe('the pbxproj builds, embeds and signs the extension', () => {
  // Parsed once; a parse error is the FIRST test's failure, and every other test then fails too.
  let parseError: Error | undefined;
  let project: PbxDict = { objects: {} };
  try {
    project = parsePbxproj(pbxproj);
  } catch (e) {
    parseError = e as Error;
  }
  const objects = project.objects as Record<string, PbxDict>;

  const obj = (id: Pbx): PbxDict => {
    const found = objects[id as string];
    expect(found, String(id)).toBeDefined();
    return found;
  };
  const ids = (value: Pbx): string[] => value as string[];
  const ofIsa = (isa: string) => Object.entries(objects).filter(([, o]) => o.isa === isa);

  function nativeTarget(name: string): { id: string; target: PbxDict } {
    const found = ofIsa('PBXNativeTarget').filter(([, o]) => o.name === name);
    expect(found.length, name).toBe(1);
    return { id: found[0][0], target: found[0][1] };
  }

  /** The build settings of each configuration of a target, by the configuration's own `name`. */
  function configs(name: string): Record<string, PbxDict> {
    const list = obj(nativeTarget(name).target.buildConfigurationList);
    const cfgs = ids(list.buildConfigurations).map(obj);
    expect(cfgs.length).toBe(2);
    return Object.fromEntries(cfgs.map((c) => [c.name as string, c.buildSettings as PbxDict]));
  }

  /** The `path` of every file a build phase carries. */
  const phasePaths = (phase: PbxDict) =>
    ids(phase.files).map((f) => obj(obj(f).fileRef).path as string);

  it('parses whole: every object closed, no key defined twice', () => {
    expect(parseError?.message).toBeUndefined();
    expect(Object.keys(objects).length).toBeGreaterThan(50);
    expect(obj(project.rootObject).isa).toBe('PBXProject');
  });

  it('names every build configuration and references no object that is missing', () => {
    for (const [id, cfg] of ofIsa('XCBuildConfiguration')) {
      expect(['debug', 'release'], id).toContain(cfg.name);
      expect(typeof cfg.buildSettings, id).toBe('object');
    }
    const walk = (v: Pbx, from: string) => {
      if (typeof v === 'string') {
        if (/^[0-9A-F]{23,24}$/.test(v)) expect(objects[v], `${from} -> ${v}`).toBeDefined();
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, from));
      else Object.values(v).forEach((x) => walk(x, from));
    };
    for (const [id, o] of Object.entries(objects)) walk(o, id);
  });

  it('is an app-extension target producing CanariShare.appex', () => {
    const { target } = nativeTarget('CanariShare');
    expect(target.productType).toBe('com.apple.product-type.app-extension');
    expect(obj(target.productReference).path).toBe('CanariShare.appex');
  });

  it('signs and versions both configurations like the NSE', () => {
    const share = configs('CanariShare');
    const nse = configs('CanariNotifications');
    expect(Object.keys(share).sort()).toEqual(['debug', 'release']);
    expect(Object.keys(nse).sort()).toEqual(['debug', 'release']);
    for (const [cfg, s] of Object.entries(share)) {
      expect(s.PRODUCT_BUNDLE_IDENTIFIER, cfg).toBe('fr.emse.canari.share');
      expect(s['PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]'], cfg).toBe('CanariShare');
      expect(s.CODE_SIGN_ENTITLEMENTS, cfg).toBe('canari_Share/canari_Share.entitlements');
      expect(s.INFOPLIST_FILE, cfg).toBe('canari_Share/Info.plist');
      expect(s.APPLICATION_EXTENSION_API_ONLY, cfg).toBe('YES');
      for (const key of ['MARKETING_VERSION', 'CURRENT_PROJECT_VERSION']) {
        expect(s[key], `${cfg} ${key}`).toBe(nse[cfg][key]);
      }
    }
  });

  it('is embedded in the app, built before it, and listed among the targets', () => {
    const app = nativeTarget('canari_iOS');
    const share = nativeTarget('CanariShare');
    const embed = ids(app.target.buildPhases)
      .map(obj)
      .filter((p) => p.name === 'Embed Foundation Extensions');
    expect(embed.length).toBe(1);
    expect(phasePaths(embed[0]).sort()).toEqual(['CanariNotifications.appex', 'CanariShare.appex']);
    const deps = ids(app.target.dependencies).map((d) => obj(d).target);
    expect(deps).toContain(share.id);
    expect(ids(obj(project.rootObject).targets)).toContain(share.id);
  });

  it('links Intents into the app (the donations) and the extension (the picked intent)', () => {
    const frameworksOf = (name: string) => {
      const phases = ids(nativeTarget(name).target.buildPhases)
        .map(obj)
        .filter((p) => p.isa === 'PBXFrameworksBuildPhase');
      expect(phases.length, name).toBe(1);
      // A Swift package product (Firebase) is a `productRef`, not a file: only files are read.
      return ids(phases[0].files)
        .map(obj)
        .filter((b) => b.fileRef !== undefined)
        .map((b) => obj(b.fileRef).path as string);
    };
    for (const name of ['canari_iOS', 'CanariShare']) {
      expect(frameworksOf(name), name).toContain('System/Library/Frameworks/Intents.framework');
    }
  });

  it('compiles every Swift file of canari_Share', () => {
    const sources = ids(nativeTarget('CanariShare').target.buildPhases)
      .map(obj)
      .filter((p) => p.isa === 'PBXSourcesBuildPhase');
    expect(sources.length).toBe(1);
    const swift = readdirSync(SHARE).filter((f) => f.endsWith('.swift'));
    expect(swift.length).toBeGreaterThan(0);
    expect(phasePaths(sources[0]).sort()).toEqual(swift.sort());
  });

  it('the parser refuses what it must', () => {
    expect(() => parsePbxproj('{ a = { b = c; }; ')).toThrow(/unclosed/);
    expect(() => parsePbxproj('{ a = b; a = c; }')).toThrow(/defined twice/);
    expect(() => parsePbxproj('{ a = "x /* } */ y"; }')).not.toThrow();
    expect(parsePbxproj('{ a = "x /* } */ y"; }').a).toBe('x /* } */ y');
    expect(() => parsePbxproj('{ a = b }')).toThrow(/expected ';'/);
  });
});

describe('the build and the bench signing know both extensions', () => {
  it('ios.yml installs the share profile, maps it for export and asserts the two appex', () => {
    const yml = read(resolve(REPO, '.github/workflows/ios.yml'));
    expect(yml).toContain('install_profile "$APPLE_PROVISIONING_PROFILE_SHARE" "share"');
    expect(yml).toMatch(/<key>fr\.emse\.canari\.share<\/key>\s*<string>CanariShare<\/string>/);
    // Both builds run it: the unsigned bench app and the store archive.
    expect(yml.match(/bash \.\.\/\.github\/scripts\/ios-extensions\.sh "\$/g)?.length).toBe(2);
    const script = read(resolve(REPO, '.github/scripts/ios-extensions.sh'));
    expect(script).toContain("'CanariNotifications.appex'");
    expect(script).toContain("'CanariShare.appex'");
    expect(pbxproj).toContain('path = CanariNotifications.appex;');
    expect(pbxproj).toContain('path = CanariShare.appex;');
  });

  it('sign-install.mjs signs the share extension with its own profile', () => {
    const sign = read(resolve(REPO, 'tools/ios-device/sign-install.mjs'));
    expect(sign).toContain("'fr.emse.canari.share': { profile: 'share.mobileprovision'");
    expect(sign).toContain("ent: 'canari_Share/canari_Share.entitlements'");
  });

  it('the page drains and erases a share on iOS as on Android', () => {
    const host = read(resolve(here, '../components/layout/IncomingShareHost.svelte'));
    expect(host).toContain('if (!isMobileTauriRuntime()) return;');
    const signOut = read(resolve(here, 'incomingShareSignOut.ts'));
    expect(signOut).toContain('if (!isMobileTauriRuntime()) return;');
  });
});
