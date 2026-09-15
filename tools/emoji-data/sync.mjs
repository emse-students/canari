#!/usr/bin/env bun
/**
 * WRITES THE TWO EMOJI DATASETS THE PICKER SERVES, FROM A PINNED PACKAGE.
 *
 * `emoji-picker-element` fetches its data at runtime. Given no `data-source` it fetches
 * `https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json` - a
 * third-party request carrying every member's IP, impossible offline, hence impossible in the
 * mobile apps, and pinned to nothing, so the set of emoji this application offers could change
 * under it without a commit. The French half had already been self-hosted for that reason; the
 * English half had not, and `undefined` is what selected the CDN.
 *
 * SO BOTH ARE SERVED FROM `static/`, AND BOTH ARE REPRODUCIBLE. The bytes are copied verbatim out
 * of `emoji-picker-element-data`, pinned to an EXACT version in `frontend/package.json` (no
 * caret - a range would put the offered set back under someone else's control, one `bun install`
 * at a time). `emojiData.test.ts` fails if a committed file stops matching the package, so a bump
 * that is not re-synced cannot merge, and neither can a hand-edited dataset.
 *
 * WHY THE BYTES ARE COMMITTED RATHER THAN GENERATED AT BUILD TIME, since this repository's usual
 * disposition for a derived artefact is the opposite one (`src/lib/wasm/`, `src/lib/proto/`: built
 * by every pipeline, absent from git). Those are generated because every pipeline was TAUGHT to run
 * `bun run generate`, and `build` does not depend on it - so a pipeline that forgot would ship a
 * picker whose dataset 404s, which is the same silent broken screen this script exists to close,
 * arriving from the other side. A committed file cannot be forgotten.
 *
 * The cost is one red pull request per bump: Dependabot raises `emoji-picker-element-data`, the
 * bytes no longer match, and `emojiData.test.ts` fails. That is deliberate and it is not a queue
 * nobody drains - the failure NAMES the single command that lifts it, and it is the same shape as
 * any other bump needing a source change.
 *
 * AND THE FIRST THING THAT BROKE THE BYTE-IDENTITY WAS NOT A BUMP, IT WAS THE FORMATTER. `oxfmt`
 * formats `.json`, the pre-commit hook sweeps the whole frontend, and it pretty-printed both
 * datasets on the way in - 439662 bytes became 596686, and CI went red on a change that had been
 * green locally a minute earlier. A vendored artefact is not source, so `oxfmt.json` now ignores
 * the two datasets under `frontend/static/`, alongside the generated trees it already skipped. The
 * cost of getting this wrong is not only the red gate: a formatter adds 36% to a file every member
 * who opens the picker downloads.
 *
 * Usage: bun tools/emoji-data/sync.mjs   (no arguments, no network - it reads node_modules)
 */
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pkgRoot = resolve(repoRoot, 'frontend/node_modules/emoji-picker-element-data');
const staticDir = resolve(repoRoot, 'frontend/static');

/** Locale -> the file the picker is pointed at. Both halves, or the defaulting one goes to a CDN. */
export const EMOJI_DATASETS = [
  { locale: 'en', from: 'en/emojibase/data.json', to: 'emoji-data-en.json' },
  { locale: 'fr', from: 'fr/emojibase/data.json', to: 'emoji-data-fr.json' },
];

if (!existsSync(pkgRoot)) {
  console.error(
    `emoji-data: ${pkgRoot} is missing - run \`bun install\` in frontend/ first.\n` +
      'This script copies bytes; it never downloads them.'
  );
  process.exit(1);
}

for (const { locale, from, to } of EMOJI_DATASETS) {
  const src = resolve(pkgRoot, from);
  const dst = resolve(staticDir, to);
  copyFileSync(src, dst);
  console.log(`  ${locale} -> static/${to} (${statSync(dst).size} bytes)`);
}
console.log('emoji datasets synced from the pinned emoji-picker-element-data.');
