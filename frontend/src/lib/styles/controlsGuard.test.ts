/**
 * THE CONTROLS GUARD: a screen does not hand-build a button, a select or a text field.
 *
 * WHY (owner, 2026-11-07): *"les boutons ne sont pas alignes, ont des hauteurs differentes et des
 * styles differents. Il faudrait rendre toute l'application homogene et coherente."* One admin row
 * held a select, a yellow button and a black-bordered button, three heights and three styles - each
 * one correct where it stood, which is exactly how 285 files drifted apart. The decision was
 * "mandatory components plus a test": `ui/Button`, `ui/Input` (the text field) and `ui/Select`
 * (`ui/Picker` under it) are the only things allowed to draw those three, and THIS file is the test.
 * The convention itself: docs/wiki/frontend/controls.md.
 *
 * WHAT IT COUNTS. A `<button>`, a `<select>`, and a text-like `<input>` (see `rawControls.ts`) in
 * any `.svelte` file (and a `<button` inside a `.ts` / `.js` string) outside `src/lib/components/ui/`, where the primitives live.
 *
 * THE RATCHET. 285 files violate today, and rewriting them in one change would be unreviewable, so
 * `rawControlsRatchet.json` records, per file, how many of each it may still contain. It works in
 * ONE direction:
 *
 *  - a file NOT in the list can never gain a raw control - a new screen uses the components or the
 *    test fails, and adding the file to the list is not a way out (it is refused below: the list
 *    may only hold files that already violated when it was first written, which is every entry);
 *  - a file IN the list may not exceed its recorded counts;
 *  - a file that now has FEWER than recorded fails too, until the list is lowered, so progress is
 *    written down and cannot be undone by the next edit. Lowering is mechanical:
 *    `CANARI_RATCHET_WRITE=1 bun x vitest run src/lib/styles/controlsGuard.test.ts`
 *    rewrites the file, and it REFUSES to write a number that went up or an entry that is new.
 *
 * It is a vitest file and therefore already part of `bun run test` / `make test-frontend`; no
 * workflow was added for it (CLAUDE.md: four visible workflows, deliberately).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../test/sourceTree';
import { rawControlsIn, totalRawControls, type RawControlCounts } from './rawControls';

const RATCHET_PATH = resolve(import.meta.dirname, 'rawControlsRatchet.json');

/** Where the primitives live and may draw what the rest of the app may not. */
const PRIMITIVES_DIR = 'src/lib/components/ui/';

type Ratchet = Record<string, RawControlCounts>;

function readRatchet(): Ratchet {
  return JSON.parse(readFileSync(RATCHET_PATH, 'utf8')) as Ratchet;
}

/** The raw controls of every screen file, by path; files with none are absent. */
function scan(): Ratchet {
  const found: Ratchet = {};
  for (const file of sourceFiles({ under: 'src', extensions: SCANNED, tests: 'exclude' })) {
    if (file.path.startsWith(PRIMITIVES_DIR)) continue;
    const counts = rawControlsIn(file.text);
    if (totalRawControls(counts) > 0) found[file.path] = counts;
  }
  return found;
}

/** `.ts` / `.js` are scanned too: a `<button` inside a string is a button drawn by hand. */
const SCANNED = ['svelte', 'ts', 'js'];

const KINDS: (keyof RawControlCounts)[] = ['button', 'select', 'input'];

describe('rawControlsIn', () => {
  it('counts a button, a select and a text field, and nothing else', () => {
    const counts = rawControlsIn(
      '<button class="x">a</button><select></select><input type="text" /><input />' +
        '<input type="checkbox" /><input type="file" /><input type="range" />'
    );
    expect(counts).toEqual({ button: 1, select: 1, input: 2 });
  });

  it('reads past a `>` inside an attribute expression', () => {
    // The old `[^>]*` reading ended this tag at `=>`, saw no `type`, and counted a checkbox.
    const counts = rawControlsIn('<input onchange={(e) => go(e)} type="checkbox" />');
    expect(counts.input).toBe(0);
  });

  it('is not tripped by a comment describing the rule', () => {
    const counts = rawControlsIn(
      '<!-- <button> -->\n<script>\n// <select>\n/* <input> */\n</script>'
    );
    expect(totalRawControls(counts)).toBe(0);
  });

  it('counts the spellings that draw a button without being `<button>`', () => {
    const counts = rawControlsIn(
      '<input type="submit" /><input type="button" value="x" />' +
        '<svelte:element this="button" /><svelte:element this="div" />' +
        'const html = \'<button class="x">\';'
    );
    expect(counts).toEqual({ button: 4, select: 0, input: 0 });
  });

  it('does not take `<Button` or `<Input` for a raw tag', () => {
    expect(totalRawControls(rawControlsIn('<Button>a</Button><Input /><Select />'))).toBe(0);
  });
});

describe('the controls ratchet', () => {
  const found = scan();

  it('reads the tree it thinks it is reading', () => {
    // A scan that walked nothing would pass every assertion below.
    expect(Object.keys(found).length).toBeGreaterThan(20);
    expect(
      sourceFiles({ under: 'src', extensions: ['svelte'], tests: 'exclude' }).length
    ).toBeGreaterThan(300);
  });

  it('rewrites the list downwards only, when asked', () => {
    if (process.env.CANARI_RATCHET_WRITE !== '1') return;
    const ratchet = readRatchet();
    const next: Ratchet = {};
    for (const [path, counts] of Object.entries(found)) {
      const old = ratchet[path];
      if (!old) throw new Error(`${path} is new: a file cannot be added to the ratchet`);
      for (const kind of KINDS) {
        if (counts[kind] > old[kind])
          throw new Error(`${path}: ${kind} went UP (${old[kind]} to ${counts[kind]})`);
      }
      next[path] = counts;
    }
    writeFileSync(RATCHET_PATH, `${JSON.stringify(next, null, 2)}\n`);
  });

  it('lets no file outside the list hand-build a control', () => {
    const ratchet = readRatchet();
    const offenders = Object.keys(found).filter((path) => !ratchet[path]);
    expect(
      offenders,
      'These files draw a button, select or text field by hand. Use ui/Button, ui/Select or ui/Input ' +
        '(docs/wiki/frontend/controls.md). The ratchet is not a place to add a file.'
    ).toEqual([]);
  });

  it('lets no listed file gain a hand-built control', () => {
    const ratchet = readRatchet();
    const grown = Object.entries(found)
      .filter(([path]) => ratchet[path])
      .flatMap(([path, counts]) =>
        KINDS.filter((kind) => counts[kind] > ratchet[path][kind]).map(
          (kind) => `${path}: ${kind} ${ratchet[path][kind]} -> ${counts[kind]}`
        )
      );
    expect(grown).toEqual([]);
  });

  it('has been lowered to what the tree now holds', () => {
    const ratchet = readRatchet();
    const stale = Object.entries(ratchet)
      .filter(([path, allowed]) => {
        const counts = found[path] ?? { button: 0, select: 0, input: 0 };
        return KINDS.some((kind) => counts[kind] < allowed[kind]);
      })
      .map(([path]) => path);
    expect(
      stale,
      'Fewer hand-built controls than recorded: lower the list with ' +
        'CANARI_RATCHET_WRITE=1 (it only ever goes down).'
    ).toEqual([]);
  });
});
