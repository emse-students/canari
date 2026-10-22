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

describe('the extension bundle', () => {
  it('holds the App Group and nothing else', () => {
    const ent = read(resolve(SHARE, 'canari_Share.entitlements')).replace(/<!--[\s\S]*?-->/g, '');
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

describe('the pbxproj builds, embeds and signs the extension', () => {
  /** The object `id = { ... };` at one tab depth inside the objects dictionary. */
  function object(id: string): string {
    const start = pbxproj.search(new RegExp(`\\n\\t\\t${id} (/\\*[^*]*\\*/ )?= \\{`));
    expect(start, id).toBeGreaterThan(-1);
    return pbxproj.slice(start, pbxproj.indexOf('\n\t\t};', start));
  }

  function nativeTarget(name: string): { id: string; body: string } {
    const id = capture(
      pbxproj,
      new RegExp(`\\n\\t\\t([0-9A-F]+) /\\* ${name} \\*/ = \\{\\n\\t\\t\\tisa = PBXNativeTarget;`)
    );
    return { id, body: object(id) };
  }

  /** The build settings of each configuration of a target, by configuration name. */
  function configs(name: string): Record<string, string> {
    const list = capture(nativeTarget(name).body, /buildConfigurationList = ([0-9A-F]+)/);
    const ids = [...object(list).matchAll(/\n\t\t\t\t([0-9A-F]+) \/\* (\w+) \*\//g)];
    expect(ids.length).toBe(2);
    return Object.fromEntries(ids.map(([, id, cfg]) => [cfg, object(id)]));
  }

  const setting = (body: string, key: string) =>
    capture(body, new RegExp(`\\n\\t+"?${key.replace(/[[\]*=]/g, '\\$&')}"? = ([^;]+);`));

  it('is an app-extension target producing CanariShare.appex', () => {
    const { body } = nativeTarget('CanariShare');
    expect(body).toContain('productType = "com.apple.product-type.app-extension";');
    expect(body).toMatch(/productReference = [0-9A-F]+ \/\* CanariShare\.appex \*\//);
  });

  it('signs and versions both configurations like the NSE', () => {
    const share = configs('CanariShare');
    const nse = configs('CanariNotifications');
    expect(Object.keys(share).sort()).toEqual(Object.keys(nse).sort());
    for (const [cfg, body] of Object.entries(share)) {
      expect(setting(body, 'PRODUCT_BUNDLE_IDENTIFIER'), cfg).toBe('fr.emse.canari.share');
      expect(setting(body, 'PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]'), cfg).toBe(
        'CanariShare'
      );
      expect(setting(body, 'CODE_SIGN_ENTITLEMENTS'), cfg).toBe(
        'canari_Share/canari_Share.entitlements'
      );
      expect(setting(body, 'INFOPLIST_FILE'), cfg).toBe('canari_Share/Info.plist');
      expect(setting(body, 'APPLICATION_EXTENSION_API_ONLY'), cfg).toBe('YES');
      for (const key of ['MARKETING_VERSION', 'CURRENT_PROJECT_VERSION']) {
        expect(setting(body, key), `${cfg} ${key}`).toBe(setting(nse[cfg], key));
      }
    }
  });

  it('is embedded in the app, built before it, and listed among the targets', () => {
    const embed = object(
      capture(pbxproj, /\n\t\t([0-9A-F]+) \/\* Embed Foundation Extensions \*\/ = \{/)
    );
    expect(embed).toContain('CanariNotifications.appex in Embed Foundation Extensions');
    expect(embed).toContain('CanariShare.appex in Embed Foundation Extensions');
    const app = nativeTarget('canari_iOS').body;
    const deps = [...app.matchAll(/([0-9A-F]+) \/\* PBXTargetDependency \*\//g)].map((m) =>
      object(m[1])
    );
    expect(deps.some((d) => d.includes(`target = ${nativeTarget('CanariShare').id} `))).toBe(true);
    expect(pbxproj).toMatch(/targets = \([^)]*\/\* CanariShare \*\/,[^)]*\);/);
  });

  it('compiles every Swift file of canari_Share', () => {
    const sources = capture(nativeTarget('CanariShare').body, /([0-9A-F]+) \/\* Sources \*\//);
    const phase = object(sources);
    const swift = readdirSync(SHARE).filter((f) => f.endsWith('.swift'));
    expect(swift.length).toBeGreaterThan(0);
    for (const file of swift) expect(phase, file).toContain(`/* ${file} in Sources */`);
  });

  it('defines each of its objects once and references none that is missing', () => {
    const ours = [...pbxproj.matchAll(/\b(5AE1A2B3C4D5E6F7[0-9A-F]{8})\b/g)].map((m) => m[1]);
    const defined = [
      ...pbxproj.matchAll(/\n\t\t(5AE1A2B3C4D5E6F7[0-9A-F]{8}) (\/\*[^*]*\*\/ )?= \{/g),
    ].map((m) => m[1]);
    expect(new Set(defined).size).toBe(defined.length);
    for (const id of new Set(ours)) expect(defined, id).toContain(id);
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
