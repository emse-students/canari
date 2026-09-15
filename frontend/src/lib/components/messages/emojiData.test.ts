import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setLocale } from '$lib/paraglide/runtime';
import { emojiPickerDataSource } from './emojiPickerShared';

/**
 * THE EMOJI PICKER MUST NOT PHONE A CDN, AND THE SET IT OFFERS MUST BE A COMMITTED FACT.
 *
 * `emoji-picker-element` fetches its dataset at runtime. Given no `data-source` it fetches
 * `https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json` from
 * jsDelivr, and the component asked for exactly that on the English locale by passing `undefined`
 * - a value that reads as "no preference" and means "a third party". Three separate costs, all of
 * them silent: every member who opens the picker sends their IP to a CDN, the picker cannot open
 * offline at all (fatal in the Tauri mobile apps, where there is no other source), and `@^1` pins
 * nothing, so the emoji this application offers could change without a commit.
 *
 * The French half had been self-hosted since the search keywords needed it, which is why the
 * English half went unnoticed: the picker worked, in the language most of this estate reads.
 *
 * These assertions are deliberately structural rather than behavioural. The failure is a network
 * request that happens inside a third-party web component, in a shadow root, only on one locale -
 * nothing a rendering test would see. What CAN be stated is that the attribute is always a local
 * path, that both files exist, and that they are byte-identical to an exactly-pinned package, so
 * the offered set is reproducible from the lockfile rather than fetched from whatever the CDN
 * serves that day.
 */

const here = import.meta.dirname;
const frontendRoot = resolve(here, '../../../..');

// Every mount point of `<emoji-picker>` in the app - both must resolve `data-source` through the
// same shared, tested function rather than inlining their own copy of the CDN-vs-local decision.
const PICKERS = [
  resolve(here, 'MessageEmojiPicker.svelte'),
  resolve(here, '../chat/ComposerEmojiPicker.svelte'),
];
const DATASETS = [
  { locale: 'en', served: 'emoji-data-en.json', packaged: 'en/emojibase/data.json' },
  { locale: 'fr', served: 'emoji-data-fr.json', packaged: 'fr/emojibase/data.json' },
];

describe('the emoji picker serves its own data', () => {
  beforeEach(() => setLocale('fr', { reload: false }));

  it('never leaves data-source unset, on either locale', () => {
    // `undefined` is the whole defect: it is not "no data source", it is the library's default,
    // and the library's default is a CDN. Any expression that can evaluate to it fails here.
    for (const locale of ['fr', 'en'] as const) {
      setLocale(locale, { reload: false });
      const src = emojiPickerDataSource();
      expect(src).not.toBeUndefined();
      // Nor may it name a remote one directly, which is the same outcome written out loud.
      expect(src).not.toMatch(/https?:|cdn/i);
      expect(src).toMatch(/^\/emoji-data-[a-z-]+\.json$/);
    }
  });

  it('every emoji-picker mount calls the shared resolver, not its own inline expression', () => {
    for (const file of PICKERS) {
      const src = readFileSync(file, 'utf8');
      expect(
        src,
        `${file} must set data-source={emojiPickerDataSource()} rather than inlining its own logic`
      ).toMatch(/data-source=\{emojiPickerDataSource\(\)\}/);
    }
  });

  it('pins the dataset package to an exact version, not a range', () => {
    const pkg = JSON.parse(readFileSync(resolve(frontendRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    const pinned = pkg.devDependencies?.['emoji-picker-element-data'];
    expect(pinned, 'emoji-picker-element-data is not a devDependency').toBeDefined();
    // A caret would put the offered set back under someone else's control, one `bun install` at a
    // time - which is the same non-determinism as the CDN, arriving through the lockfile instead.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const { locale, served, packaged } of DATASETS) {
    it(`serves the ${locale} dataset from static/, byte-identical to the pinned package`, () => {
      const servedBytes = readFileSync(resolve(frontendRoot, 'static', served));
      const packagedBytes = readFileSync(
        resolve(frontendRoot, 'node_modules/emoji-picker-element-data', packaged)
      );
      // Byte equality, not a parsed comparison: `tools/emoji-data/sync.mjs` copies the file, so
      // anything else means the committed artefact was edited by hand, the package moved without a
      // re-sync - or something rewrote it on its way into the commit, which is what actually
      // happened first: `oxfmt` formats `.json`, the pre-commit hook sweeps the whole frontend, and
      // it pretty-printed both datasets (+36% over the wire, for every member who opens the
      // picker). `oxfmt.json` ignores them now. A parsed comparison would have shrugged at all
      // three.
      expect(
        servedBytes.equals(packagedBytes),
        `static/${served} does not match the pinned package - run \`bun tools/emoji-data/sync.mjs\``
      ).toBe(true);
    });
  }
});
