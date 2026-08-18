import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Native string-resource guardrail, both platforms.
 *
 * Neither half of this is checked by anything else: the two native projects are verified by
 * COMPILING, and a resource file compiles whatever it says.
 *
 * The per-platform blocks hold the resource files against EACH OTHER, so a sentence that never
 * entered a table used to be invisible to both: six of them were found in the Swift and ObjC
 * sources the day after this file was written. The last block closes that hole for both platforms
 * at once - see `describe('Native sources, both platforms')` for what it can and cannot see.
 *
 * Three things can drift on the Android side and NOTHING else reports them:
 *   - a `R.string.x` that no `strings.xml` declares. The Android build catches this one, but only
 *     when someone runs it, and an APK build is the slowest feedback loop in this repository.
 *   - a key declared in `values/` and forgotten in `values-en/`. This one NOTHING catches: Android
 *     silently falls back to the default resource, so an English phone shows French and the build
 *     is green. It is the exact failure this file was written after.
 *   - a French sentence left hardcoded in a `.kt`. Compiles, ships, and is untranslatable forever.
 *
 * The third is caught by its accents. That is a heuristic, not a proof - an unaccented French
 * literal slips through - but every user-visible string this app had in Kotlin on 2026-08-16 carried
 * one, and the check costs nothing. Anything it flags is either a string that belongs in
 * `strings.xml` or a comment that should not have been a literal.
 */
const here = dirname(fileURLToPath(import.meta.url));

const ANDROID_ROOT = resolve(here, '../../../src-tauri/gen/android/app/src/main');
const KOTLIN_DIR = join(ANDROID_ROOT, 'java/fr/emse/canari');
const STRINGS_FR = join(ANDROID_ROOT, 'res/values/strings.xml');
const STRINGS_EN = join(ANDROID_ROOT, 'res/values-en/strings.xml');
const MANIFEST = join(ANDROID_ROOT, 'AndroidManifest.xml');

/**
 * Keys that exist ONLY in the default resources, on purpose: they are the brand, which is the same
 * word in every language. Anything else missing from `values-en/` is a translation that was
 * forgotten, not a decision.
 */
const BRAND_ONLY = ['app_name', 'main_activity_title'];

/** Every `<string name="x">value</string>` of a resource file, as a Map. */
function parseStrings(path: string): Map<string, string> {
  const source = readFileSync(path, 'utf8');
  const entries = new Map<string, string>();
  for (const m of source.matchAll(/<string name="([^"]+)"\s*>([\s\S]*?)<\/string>/g)) {
    entries.set(m[1], m[2]);
  }
  return entries;
}

const kotlinFiles = readdirSync(KOTLIN_DIR)
  .filter((f) => f.endsWith('.kt'))
  .map((f) => ({ name: f, source: readFileSync(join(KOTLIN_DIR, f), 'utf8') }));

const fr = parseStrings(STRINGS_FR);
const en = parseStrings(STRINGS_EN);

describe('Android string resources', () => {
  it('parses both resource files', () => {
    // A typo in the XML would otherwise turn every assertion below into a vacuous pass.
    expect(kotlinFiles.length).toBeGreaterThan(5);
    expect(fr.size).toBeGreaterThan(20);
    expect(en.size).toBeGreaterThan(20);
  });

  it('declares every R.string a Kotlin source reads', () => {
    const missing: string[] = [];
    for (const { name, source } of kotlinFiles) {
      for (const m of source.matchAll(/R\.string\.(\w+)/g)) {
        if (!fr.has(m[1])) missing.push(`${name}: R.string.${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('translates every key into English, the brand aside', () => {
    const untranslated = [...fr.keys()].filter((k) => !en.has(k) && !BRAND_ONLY.includes(k));
    expect(untranslated).toEqual([]);
  });

  it('declares nothing in English that the default resources do not have', () => {
    // An orphan here means a rename landed in one file only: `values-en/` would answer for the old
    // key and `values/` for the new one, so the two languages would show DIFFERENT strings.
    const orphans = [...en.keys()].filter((k) => !fr.has(k));
    expect(orphans).toEqual([]);
  });

  it('keeps the same format arguments in both languages', () => {
    // `getString(key, arg)` passes its arguments positionally. A translation that drops `%1$s`
    // silently loses the salon name; one that adds a `%2$s` throws at runtime, in a background
    // notification, where nobody sees the stack.
    const mismatched: string[] = [];
    for (const [key, value] of fr) {
      const other = en.get(key);
      if (other === undefined) continue;
      const args = (s: string) => (s.match(/%\d+\$[sd]/g) ?? []).sort().join(',');
      if (args(value) !== args(other)) mismatched.push(key);
    }
    expect(mismatched).toEqual([]);
  });

  it('declares no string nothing reads', () => {
    const manifest = readFileSync(MANIFEST, 'utf8');
    const used = new Set<string>();
    for (const { source } of kotlinFiles) {
      for (const m of source.matchAll(/R\.string\.(\w+)/g)) used.add(m[1]);
    }
    for (const m of manifest.matchAll(/@string\/(\w+)/g)) used.add(m[1]);
    const dead = [...fr.keys()].filter((k) => !used.has(k));
    expect(dead).toEqual([]);
  });

  it('leaves no French sentence hardcoded in Kotlin', () => {
    const ACCENTED = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/;
    const offenders: string[] = [];
    for (const { name, source } of kotlinFiles) {
      source.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        // Comments may carry French freely - they are read by us, not by the user.
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        for (const m of line.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
          if (ACCENTED.test(m[0])) offenders.push(`${name}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('Android notification strings', () => {
  it('resolves every user-visible string through the app locale, never the system one', () => {
    // `appLocaleContext` exists because the Français/English toggle in Canari's settings and the
    // phone's language are two different settings. A bare `context.getString(...)` in a
    // notification path answers the second one - right for most users, wrong and invisible for the
    // ones whose settings disagree. `app_name` is exempt: it is the brand in every language.
    const strays: string[] = [];
    for (const { name, source } of kotlinFiles) {
      if (name === 'AppLocale.kt') continue;
      source.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/getString\(R\.string\.(\w+)/g)) {
          if (m[1] === 'app_name') continue;
          // The receiver, not the call, is what decides the language. A bare `getString` is the
          // Service itself, which is the system locale - so an absent receiver is a stray too.
          const receiver = line.slice(0, m.index);
          const localised =
            receiver.endsWith('res.') || /appLocaleContext\([^)]*\)\.$/.test(receiver);
          if (!localised) strays.push(`${name}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(strays).toEqual([]);
  });

  it('keeps one copy of the pending-sync nudge, reachable without a Service', () => {
    const service = kotlinFiles.find((f) => f.name === 'CanariFirebaseMessagingService.kt')!.source;
    // It used to exist twice, verbatim: once static for the workers and once instance for the
    // service. Two chances to update the wording, one certainty of forgetting.
    expect(service.match(/fun showPendingSyncNotification\(/g)).toHaveLength(1);
    expect(service).toContain('internal fun showPendingSyncNotification(context: Context)');
  });

  it('names the five notification channels from resources', () => {
    const application = kotlinFiles.find((f) => f.name === 'CanariApplication.kt')!.source;
    for (const channel of ['messages', 'social', 'forms', 'calls', 'mentions']) {
      expect(application).toContain(`R.string.notif_channel_${channel}_name`);
      expect(application).toContain(`R.string.notif_channel_${channel}_desc`);
    }
  });
});

const APPLE_ROOT = resolve(here, '../../../src-tauri/gen/apple');
const BUNDLES = ['canari_iOS', 'canari_NSE'];

/** Every `"key" = "value";` of a `.strings` file. */
function parseLproj(bundle: string, lang: string, file: string): Map<string, string> {
  const path = join(APPLE_ROOT, bundle, `${lang}.lproj`, file);
  const entries = new Map<string, string>();
  for (const m of readFileSync(path, 'utf8').matchAll(/^"([^"]+)"\s*=\s*"(.*)";/gm)) {
    entries.set(m[1], m[2]);
  }
  return entries;
}

describe('iOS string resources', () => {
  // Same invariant, the other platform's spelling - and a harsher failure than Android's. Both
  // resolvers (`CanariLocalized`, `NotificationService.localized`) pass `value: key`, so a key
  // missing from one `.lproj` ships a notification body reading `notif.message.from`. There is no
  // default table to fall back to, because the table is chosen by the app's locale, not the OS's.

  it.each(BUNDLES)('%s translates every key both ways', (bundle) => {
    const frLproj = parseLproj(bundle, 'fr', 'Localizable.strings');
    const enLproj = parseLproj(bundle, 'en', 'Localizable.strings');
    expect(frLproj.size).toBeGreaterThan(3);
    expect([...frLproj.keys()].sort()).toEqual([...enLproj.keys()].sort());
  });

  it('keeps the same format arguments in both languages', () => {
    const mismatched: string[] = [];
    for (const bundle of BUNDLES) {
      const frLproj = parseLproj(bundle, 'fr', 'Localizable.strings');
      const enLproj = parseLproj(bundle, 'en', 'Localizable.strings');
      for (const [key, value] of frLproj) {
        // `%@` is positional here too, and the same silent loss applies.
        const args = (s: string) => (s.match(/%@/g) ?? []).length;
        if (args(value) !== args(enLproj.get(key) ?? '')) mismatched.push(`${bundle}/${key}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('describes every permission it asks for, in both languages', () => {
    // An empty usage description is an immediate App Store rejection, and an untranslated one is
    // an English sentence in a French system dialog.
    const frInfo = parseLproj('canari_iOS', 'fr', 'InfoPlist.strings');
    const enInfo = parseLproj('canari_iOS', 'en', 'InfoPlist.strings');
    expect([...frInfo.keys()].sort()).toEqual([...enInfo.keys()].sort());
    for (const [, value] of [...frInfo, ...enInfo]) expect(value.length).toBeGreaterThan(10);
  });
});

/**
 * The seam between the SERVER's closed set of notification kinds and the four native tables that
 * have to spell each one.
 *
 * Since 2026-08-19 `social-service` sends a `contentKey` instead of a French sentence, and each
 * platform writes the sentence from its own table. Nothing else connects the two sides: adding a
 * key server-side with no matching resource does not fail any build - the phone silently keeps the
 * server's compatibility wording, which is the exact "French for everyone" this replaced, only now
 * invisible because it looks deliberate.
 *
 * The key set is read from `push-content.ts` rather than restated, so a key added there and
 * forgotten everywhere else fails HERE rather than on somebody's phone.
 */
describe('Server-composed push keys reach every native table', () => {
  const PUSH_CONTENT = resolve(here, '../../../../apps/social-service/src/push/push-content.ts');

  /** The `PushContentKey` union, read out of the source. */
  const serverKeys = (() => {
    const source = readFileSync(PUSH_CONTENT, 'utf8');
    const union = source.match(/export type PushContentKey =([\s\S]*?);/);
    if (!union) throw new Error('PushContentKey union not found in push-content.ts');
    return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  })();

  /** Keys whose title names the actor take an extra `%s`; the rest are fixed sentences. */
  const androidNames = (key: string) => [`notif_${key}_title`, `notif_${key}_body`];
  const iosNames = (key: string) => {
    const dotted = key.replace(/^social_/, 'social.').replace(/^form_/, 'form.');
    return [`notif.${dotted}.title`, `notif.${dotted}.body`];
  };

  it('finds the server key set at all', () => {
    expect(serverKeys.length).toBeGreaterThan(3);
    expect(serverKeys).toContain('social_comment');
  });

  it.each(serverKeys)('%s is spelled in both Android tables', (key) => {
    for (const name of androidNames(key)) {
      expect(fr.has(name), `${name} missing from values/strings.xml`).toBe(true);
      expect(en.has(name), `${name} missing from values-en/strings.xml`).toBe(true);
    }
  });

  it.each(serverKeys)('%s is spelled in all four iOS tables', (key) => {
    for (const bundle of BUNDLES) {
      const frLproj = parseLproj(bundle, 'fr', 'Localizable.strings');
      const enLproj = parseLproj(bundle, 'en', 'Localizable.strings');
      for (const name of iosNames(key)) {
        expect(frLproj.has(name), `${name} missing from ${bundle}/fr.lproj`).toBe(true);
        expect(enLproj.has(name), `${name} missing from ${bundle}/en.lproj`).toBe(true);
      }
    }
  });

  it('is handled by both native composers, not merely declared', () => {
    // A key with resources that no `when`/`switch` names renders the server's wording anyway.
    const kotlin = kotlinFiles.find((f) => f.name === 'CanariFirebaseMessagingService.kt');
    const swift = readFileSync(join(APPLE_ROOT, 'canari_NSE', 'NotificationService.swift'), 'utf8');
    const objc = readFileSync(join(APPLE_ROOT, 'Sources', 'canari', 'canari_push.mm'), 'utf8');
    for (const key of serverKeys) {
      expect(kotlin?.source.includes(`"${key}"`), `${key} unhandled in Kotlin`).toBe(true);
      expect(
        swift.includes(`"${key}"`) || swift.includes(key.replace(/^social_/, '')),
        `${key} unhandled in the NSE`
      ).toBe(true);
      expect(
        objc.includes(`@"${key}"`) || objc.includes(key.replace(/^social_/, '')),
        `${key} unhandled in canari_push.mm`
      ).toBe(true);
    }
  });
});

describe('Native sources, both platforms', () => {
  /**
   * NO NATIVE SOURCE MAY CARRY A LITERAL A TABLE ALREADY TRANSLATES.
   *
   * The two blocks above hold resource files against each other, which cannot see a sentence that
   * never entered a table - the hole the six iOS literals of 2026-08-17 went through. This one
   * needs no wordlist and no accent heuristic: it asks whether the same words already exist as a
   * translated value, which is the definition of the defect. A literal it flags is either a string
   * that belongs in the table, or a duplicate of one that is already there and will drift from it.
   *
   * COMPARED FOLDED (lowercase, accents stripped, Swift `\u{...}` decoded) because that is exactly
   * how the previous defect was spelled: `Repondre` for `Répondre`, `Appel vid\u{00e9}o entrant`
   * for `Appel vidéo entrant`. An exact match would have found neither.
   *
   * ONLY THE FRENCH SIDE OF EACH TABLE IS THE CORPUS, and that is not a shortcut. Every identifier
   * these sources carry is English by rule - the push `"channel"` type and the `"reply"` action id
   * both fold onto an English translation, and neither is a user-visible string. French is the one
   * language in which a literal cannot be an identifier, which is what makes this check need no
   * exemption list.
   *
   * WHAT IT CANNOT SEE, stated so a green run is not read as more than it is: a French literal
   * whose wording exists in no table at all. Nothing catches that but the Kotlin accent heuristic
   * above, and on iOS nothing at all.
   */
  const APPLE_SOURCES = [
    { dir: join(APPLE_ROOT, 'Sources/canari'), exts: ['.mm', '.h'] },
    { dir: join(APPLE_ROOT, 'canari_NSE'), exts: ['.swift'] },
  ];

  /**
   * Lowercase, diacritics stripped, `\u{...}` and `\'` decoded, and stripped of whatever decorates
   * the sentence at either end.
   *
   * THE DECORATION STRIP IS LOAD-BEARING, not tidiness: the two call literals were spelled
   * `"\u{1f4f9} Appel vid\u{00e9}o entrant"`, an emoji the table does not carry followed by a
   * sentence it does. Equality on the raw value finds neither, which is the same failure as the
   * accent heuristic - a check that cannot fire on the defect it was written for. Applied to BOTH
   * sides, so a literal that drops a table value's final full stop still matches.
   */
  function fold(value: string): string {
    return value
      .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/\\'/g, "'")
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/[^\p{L}\p{N}]+$/u, '');
  }

  /** Every French value of both platforms, folded, mapped back to where it is declared. */
  const translated = new Map<string, string>();
  for (const [key, value] of fr) {
    // The brand is the same word in every language, so a `"Canari"` in a source is not an
    // untranslated string - it is the app's name. Same exemption as `values-en/`.
    if (!BRAND_ONLY.includes(key) && value.trim().length > 0) {
      translated.set(fold(value), `android/${key}`);
    }
  }
  for (const bundle of BUNDLES) {
    for (const [key, value] of parseLproj(bundle, 'fr', 'Localizable.strings')) {
      if (value.trim().length > 0) translated.set(fold(value), `${bundle}/${key}`);
    }
  }

  const appleFiles = APPLE_SOURCES.flatMap(({ dir, exts }) =>
    readdirSync(dir)
      .filter((f) => exts.some((e) => f.endsWith(e)))
      .map((f) => ({ name: f, source: readFileSync(join(dir, f), 'utf8') }))
  );

  it('reads both platforms', () => {
    // A wrong path would turn the assertion below into a vacuous pass.
    expect(appleFiles.length).toBeGreaterThan(5);
    expect(translated.size).toBeGreaterThan(20);
  });

  it('leaves no literal a table already translates', () => {
    const offenders: string[] = [];
    for (const { name, source } of [...kotlinFiles, ...appleFiles]) {
      source.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        // A comment may quote a sentence freely - that is documentation, not a shipped string.
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        for (const m of line.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
          const declaredBy = translated.get(fold(m[0].slice(1, -1)));
          if (declaredBy) offenders.push(`${name}:${i + 1} ${m[0]} -> ${declaredBy}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
