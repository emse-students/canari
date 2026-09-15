import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const PICKER = resolve(here, 'MessageEmojiPicker.svelte');
const DATASETS = [
  { locale: 'en', served: 'emoji-data-en.json', packaged: 'en/emojibase/data.json' },
  { locale: 'fr', served: 'emoji-data-fr.json', packaged: 'fr/emojibase/data.json' },
];

describe('the emoji picker serves its own data', () => {
  it('never leaves data-source unset, on either locale', () => {
    const src = readFileSync(PICKER, 'utf8');
    const attr = src.match(/data-source=\{([^}]*)\}/);
    expect(attr, 'no `data-source` attribute on the emoji-picker element').not.toBeNull();

    // `undefined` is the whole defect: it is not "no data source", it is the library's default,
    // and the library's default is a CDN. Any expression that can evaluate to it fails here.
    expect(attr?.[1]).not.toContain('undefined');
    // Nor may it name a remote one directly, which is the same outcome written out loud.
    expect(attr?.[1]).not.toMatch(/https?:|cdn/i);
    // One root-relative dataset per locale branch, and nothing else that looks like a path.
    const literals = [...(attr?.[1].matchAll(/'([^']*)'/g) ?? [])].map((m) => m[1]);
    const paths = literals.filter((v) => v.includes('/'));
    expect(paths, 'expected one local dataset path per locale branch').toHaveLength(
      DATASETS.length
    );
    for (const value of paths) expect(value).toMatch(/^\/emoji-data-[a-z-]+\.json$/);
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
      // anything else means the committed artefact was edited by hand or the package moved without
      // a re-sync. Both are things a reader of this repository should be told about.
      expect(
        servedBytes.equals(packagedBytes),
        `static/${served} does not match the pinned package - run \`bun tools/emoji-data/sync.mjs\``
      ).toBe(true);
    });
  }
});
