import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Native string-resource guardrail, both platforms.
 *
 * Neither half of this is checked by anything else: the two native projects are verified by
 * COMPILING, and a resource file compiles whatever it says. iOS was already doing the right thing
 * with `.lproj` when this was written; Android was not, and the second describe block is here so
 * that stays true rather than being re-verified by hand.
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

describe('iOS string resources', () => {
  // Same invariant, the other platform's spelling - and a harsher failure than Android's. Both
  // resolvers (`CanariLocalized`, `NotificationService.localized`) pass `value: key`, so a key
  // missing from one `.lproj` ships a notification body reading `notif.message.from`. There is no
  // default table to fall back to, because the table is chosen by the app's locale, not the OS's.
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
