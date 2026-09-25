#!/usr/bin/env bun
/**
 * WRITES THE EMOJI PICTURES THE APP DRAWS, FROM A PINNED NOTO CHECKOUT.
 *
 * WHY PICTURES AND NOT A FONT (user, 2026-09-25). The bundled colour font never drew on WebKit:
 * Safari and the iOS app both showed Apple's glyphs, and the two surviving causes - `tech()` taken
 * and the COLRv1 derivation not painted, or the merged file rejected outright - could not be told
 * apart from here (`docs/wiki/frontend/emoji.md`). An `<img>` of an SVG is drawn by every engine the
 * same way, so the question stops mattering. The pictures are Noto's own, the same art the font
 * carried, so nothing changes visually on Android or the web.
 *
 * WHAT IT DOES, in order:
 *   1. Refuses unless `--noto` is a git checkout of googlefonts/noto-emoji AT `NOTO_COMMIT`. The
 *      set of emoji this app can draw is decided by that commit and by nothing else.
 *   2. Takes the union of `2D/svg` (every emoji but the country flags) and
 *      `third_party/region-flags/waved-svg` (the flags, waved as the font drew them). The two do not
 *      overlap; the script fails if they ever do, because one of the two would win silently.
 *   3. Optimises every file with `svgo@SVGO_VERSION` (a pinned CLI, run through `bun x`), its default
 *      preset minus the three plugins measured to damage a picture here (see the comment at the call).
 *   4. Writes `frontend/static/emoji/<set>/<name>.svg`. `<name>` is the sequence's code points in
 *      lower-case hex joined by `_`, with every U+FE0F removed - the name `emojiSvgName` computes
 *      at runtime (`frontend/src/lib/utils/emojiSvg.ts`); Noto names its files the same way, minus
 *      the `emoji_u` prefix. `<set>` is a hash of every name and every byte, so a picture whose
 *      content changes changes URL - which is what lets nginx serve `/emoji/` as `immutable` for a
 *      year, and a browser fetch each picture once, ever.
 *   5. Writes `frontend/src/lib/utils/emojiSvgNames.json` - `{ set, textDefault, names }`: the sorted
 *      names (the only source the runtime consults before emitting an `<img>`, so a sequence Noto
 *      does not draw stays text instead of becoming a broken image), and the code points among them
 *      whose default presentation is text - a fact computed here so no engine's Unicode tables decide it.
 *   6. Copies both licences next to the pictures (Apache 2.0 for Noto, public domain for the flags).
 *
 * svgo is lossless by design, and that was MEASURED for this set rather than assumed: every original
 * and its optimised copy drawn by Chromium and compared pixel by pixel (`docs/wiki/frontend/emoji.md`).
 *
 * WHY THE PICTURES ARE COMMITTED, like the font before them: nothing in CI can reproduce them
 * without the network and a third-party tool, and a pipeline that forgot to would ship broken
 * images. `check-emoji-coverage.mjs` fails the build if the list and the directory disagree, or if a
 * picker entry has no picture.
 *
 * Usage (one-off, local, needs the network for `bun x`):
 *   git clone --filter=blob:none --sparse https://github.com/googlefonts/noto-emoji.git /tmp/noto
 *   git -C /tmp/noto checkout <NOTO_COMMIT>
 *   git -C /tmp/noto sparse-checkout set 2D/svg third_party/region-flags
 *   bun tools/emoji-svg/build.mjs --noto /tmp/noto
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The noto-emoji commit the pictures come from. Changing it is re-running this script. */
export const NOTO_COMMIT = 'e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e';
/** Exact, never a range: the output bytes must be reproducible from this file alone. */
const SVGO_VERSION = '4.1.0';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(repoRoot, 'frontend/static/emoji');
const namesFile = resolve(repoRoot, 'frontend/src/lib/utils/emojiSvgNames.json');

const SOURCES = ['2D/svg', 'third_party/region-flags/waved-svg'];
const LICENCES = [
  { from: '2D/svg/LICENSE', to: 'LICENSE-noto-emoji.txt' },
  { from: 'third_party/region-flags/LICENSE', to: 'LICENSE-region-flags.txt' },
];

function fail(message) {
  console.error(`emoji-svg: ${message}`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(' ')} exited ${result.status}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const args = process.argv.slice(2);
const notoIndex = args.indexOf('--noto');
if (notoIndex === -1 || !args[notoIndex + 1]) fail('usage: build.mjs --noto <checkout>');
const noto = resolve(args[notoIndex + 1]);

const head = run('git', ['-C', noto, 'rev-parse', 'HEAD']).trim();
if (head !== NOTO_COMMIT) fail(`${noto} is at ${head}, expected ${NOTO_COMMIT}`);
console.log(`noto-emoji at ${head}`);

// 1-2: the union, keyed by the runtime name, refusing an overlap.
/** @type {Map<string, string>} runtime name -> source path */
const sources = new Map();
for (const dir of SOURCES) {
  const full = join(noto, dir);
  if (!existsSync(full)) fail(`${full} is missing - add it to the sparse checkout`);
  for (const file of readdirSync(full)) {
    const match = /^emoji_u([0-9a-f_]+)\.svg$/.exec(file);
    if (!match) continue;
    const name = match[1]
      .split('_')
      .filter((cp) => cp !== 'fe0f')
      .join('_');
    if (sources.has(name)) fail(`${name} is drawn by both ${sources.get(name)} and ${dir}/${file}`);
    sources.set(name, join(full, file));
  }
}
console.log(`${sources.size} pictures in the union of ${SOURCES.join(' + ')}`);

// 3: optimise in a scratch directory, flat, already under the runtime names.
const scratch = mkdtempSync(join(tmpdir(), 'emoji-svg-'));
const rawDir = join(scratch, 'raw');
const optDir = join(scratch, 'opt');
mkdirSync(rawDir);
mkdirSync(optDir);
for (const [name, path] of sources) copyFileSync(path, join(rawDir, `${name}.svg`));
// THREE PLUGINS OFF, each because it was MEASURED to damage a picture here (2026-09-25, every original
// and its copy drawn by Chromium at 64 px): `convertTransform` (U+1FAE2 lost 1307 of 4096 pixels, in
// every precision tried), `convertShapeToPath` (U+1F69F 99, U+1F3E3 44) and `convertPathData`
// (U+1F5BC 44). With the three off, no picture differs by more than 37 pixels - edge antialiasing -
// and the set is 12.9 MB compressed where the originals are 21.1 MB.
const config = join(scratch, 'svgo.config.mjs');
writeFileSync(
  config,
  "export default { multipass: true, plugins: [{ name: 'preset-default', params: { overrides: { convertTransform: false, convertShapeToPath: false, convertPathData: false } } }] };\n"
);
run('bun', ['x', `svgo@${SVGO_VERSION}`, '--quiet', '--config', config, '-f', rawDir, '-o', optDir]);

// 4-6: replace the committed directory wholesale, so a picture Noto dropped does not linger and an
// older set's directory does not stay deployed beside the new one.
const names = [...sources.keys()].sort();
const hash = createHash('sha256');
for (const name of names) hash.update(name).update('\0').update(readFileSync(join(optDir, `${name}.svg`)));
const set = hash.digest('hex').slice(0, 12);
const setDir = join(outDir, set);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(setDir, { recursive: true });
let bytes = 0;
for (const name of names) {
  copyFileSync(join(optDir, `${name}.svg`), join(setDir, `${name}.svg`));
  bytes += statSync(join(setDir, `${name}.svg`)).size;
}
for (const { from, to } of LICENCES) copyFileSync(join(noto, from), join(outDir, to));
// THE PRESENTATION FACT SHIPS WITH THE PICTURES, instead of being asked of the engine at runtime.
// `\p{Emoji_Presentation}` answers from the ENGINE's Unicode tables, so an older WebView does not know
// the newest emoji are emoji - measured 2026-09-25: Node's tables miss seven Unicode 16 entries the
// picker offers (U+1FAEA among them), and a phone would have drawn them as text or tofu while holding
// their picture. So it is computed ONCE, here, with this tool's own tables: of the code points that
// START a drawn sequence, the ones whose default presentation is TEXT (`©`, `↔`, the digits...).
// The runtime reads that list and never a Unicode property.
const textDefault = [
  ...new Set(
    names
      .map((name) => name.split('_')[0])
      .filter((hex) => !/\p{Emoji_Presentation}/u.test(String.fromCodePoint(parseInt(hex, 16))))
  ),
].sort();
writeFileSync(namesFile, `${JSON.stringify({ set, textDefault, names })}\n`);
rmSync(scratch, { recursive: true, force: true });

console.log(`wrote ${names.length} pictures (${bytes} bytes) to frontend/static/emoji/${set}/`);
console.log(`wrote the name list to ${namesFile.slice(repoRoot.length + 1)}`);
