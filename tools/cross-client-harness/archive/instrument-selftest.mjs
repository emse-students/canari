/**
 * THE HASH THAT SAYS WHAT A CHECK MEASURES WITH IS ONLY WORTH ANYTHING IF IT SEES EVERY FILE.
 *
 * `instrument.mjs` finds a runner's dependencies with a REGEX, deliberately: the alternative is to
 * import the module, and importing a runner RUNS it, which is how a hash would come to drive a
 * phone. A regex can miss a specifier form, and a missed file is exactly the failure this whole
 * mechanism exists to fix - a shared gesture changing under a green row with nothing said. So the
 * forms are asserted here rather than hoped for.
 *
 * It also pins the two boundaries that make the hash mean what it claims: the out-of-tree
 * configuration is OUT (it holds credentials and machine-local paths, and hashing it would make two
 * checkouts incomparable), and a real runner's graph reaches the shared gestures it actually uses.
 *
 *   bun archive/instrument-selftest.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentFilesOf, instrumentShaOf } from '../instrument.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

// ── every specifier form this rig writes ────────────────────────────────────────────────────────
// The fixture is written INSIDE the harness, because `instrument.mjs` deliberately drops anything
// resolving outside it - one in the OS temp directory would be excluded for the right reason and
// would prove nothing. It is a TWO-LEVEL tree so the `../` form has an in-tree target the fixture
// owns; see the note beside `nest` for what pointing it at a real file cost.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(ROOT, 'instrument-selftest-'));
try {
  // ONE LEVEL DOWN, SO THE `../` FORM HAS A TARGET THIS TEST OWNS.
  //
  // It used to point the fixture's `../` at the harness's real `names.mjs` - and that file is in
  // `.gitignore`, because it carries the test accounts' display names and machine-local paths. So the
  // assertion passed on any machine that had run the campaign and FAILED on every fresh checkout,
  // which is CI: `an in-tree module reached with '../' is in`, red on 2026-09-05 and green here
  // since the day it was written. A self-test that needs a file the repository cannot contain is not
  // a gate - and `gate-selftest.mjs` could not catch this one, because the specifier lives in a
  // FIXTURE's source, assembled through `FROM` precisely so that gate would not read it.
  //
  // `leaf-i.mjs` is written in the parent and everything else beside the entry, so the walk still has
  // to leave the entry's own directory to find it - which is the whole assertion - while both files
  // die with the temp tree.
  const nest = join(dir, 'nested');
  mkdirSync(nest);
  const write = (name, body) => writeFileSync(join(nest, name), body, 'utf8');
  writeFileSync(join(dir, 'leaf-i.mjs'), 'export const i = 9;' + String.fromCharCode(10), 'utf8');

  // `from` IS SPELLED THROUGH A VARIABLE ON PURPOSE, and it is not obfuscation. `gate-selftest.mjs`
  // proves every self-test can run on a fresh checkout by scanning its source for `from './x'`, and
  // it cannot tell a fixture's SOURCE from the script's own imports - written literally, it demanded
  // that `leaf-a.mjs` be committed to git, a file that exists for four milliseconds. One indirection
  // is the cheaper half of that trade: the alternative is teaching a small gate to parse string
  // literals, and a gate that has to guess is worse than a variable that does not.
  const FROM = 'from';

  write('leaf-b.mjs', 'export const b = 2;\n');
  write('leaf-c.mjs', 'export const c = 3;\n');
  write('leaf-d.mjs', 'export const d = 4;\n');
  write('leaf-e.mjs', 'export const e = 5;\n');
  // SPAWNED, NEVER IMPORTED - the form an import walk is blind to by construction. `leaf-f` stands
  // for `pin.mjs`, which decides whether a phone row can read anything at all and was in no hash
  // until 2026-09-05. `leaf-g` is the same name in ARRAY position, which is how `spawnSync` is
  // actually written here (`[process.execPath, ['pin.mjs', ...]]`).
  write('leaf-f.mjs', 'export const f = 6;\n');
  write('leaf-g.mjs', 'export const g = 7;\n');
  // `leaf-b` is reached only THROUGH `leaf-a`, so its presence is what proves the walk is transitive
  // rather than one level deep.
  write('leaf-a.mjs', `import { b } ${FROM} './leaf-b.mjs';\nexport const a = b;\n`);
  write(
    'entry.mjs',
    [
      `import { a } ${FROM} './leaf-a.mjs';`,
      "import './leaf-c.mjs';",
      `export * ${FROM} './leaf-d.mjs';`,
      'async function late() {',
      "  return await import('./leaf-e.mjs');",
      '}',
      `import { i } ${FROM} '../leaf-i.mjs';`,
      `import { existsSync } ${FROM} 'node:fs';`,
      `import { load } ${FROM} '@tauri-apps/plugin-store';`,
      // The two spawn shapes this rig writes, and a name in prose that must NOT be followed.
      "function spawnOne() { return runScript('leaf-f.mjs', ['--device', 'A1']); }",
      "function spawnTwo() { return spawnSync(execPath, ['leaf-g.mjs', '--port', '9222']); }",
      "// see leaf-h.mjs for the older shape, and the note in 'leaf-h.mjs is where this used to live'",
      'export { a, late, i, existsSync, load, spawnOne, spawnTwo };',
      '',
    ].join('\n')
  );
  // Exists on disk, so being absent from the graph is a statement about the WALK rather than about
  // the file: a mention in a comment, and a filename embedded in a quoted sentence, are both prose.
  write('leaf-h.mjs', 'export const h = 8;\n');

  const found = instrumentFilesOf(join(nest, 'entry.mjs')).map((f) => basename(f));

  ok('the entry itself is in its own graph', found.includes('entry.mjs'));
  ok('`import x from` is followed', found.includes('leaf-a.mjs'));
  ok('TRANSITIVELY - a file reached only through another is in', found.includes('leaf-b.mjs'));
  ok('a bare `import` for side effects is followed', found.includes('leaf-c.mjs'));
  ok('`export * from` is followed', found.includes('leaf-d.mjs'));
  ok('a dynamic `import()` is followed', found.includes('leaf-e.mjs'));
  ok('an in-tree module reached with `../` is in', found.includes('leaf-i.mjs'));
  ok('a node: builtin is not a file and is not in', !found.some((f) => f.includes('node:')));
  ok('a bare package specifier is not followed', !found.some((f) => f.includes('plugin-store')));
  // WHAT THE ENTRY RUNS, not only what it loads. `phone.mjs` spawns `pin.mjs` and `del.mjs` spawns
  // `mlsdb.mjs`; neither was in any hash until 2026-09-05, so fixing `pin.mjs`'s hang flagged
  // nothing. Both call shapes are asserted because both are written in this rig.
  ok('a SPAWNED script named in call position is followed', found.includes('leaf-f.mjs'));
  ok('a SPAWNED script named in array position is followed', found.includes('leaf-g.mjs'));
  // THE OTHER HALF, and the one that keeps the hash worth reading. Over-inclusion is the safe
  // direction only while it stays bounded: a walk that followed every `.mjs` written anywhere would
  // pull in half the harness from the docstrings alone, and a hash invalidated by every edit
  // anywhere says exactly as much as no hash. `leaf-h.mjs` is on disk and named twice in prose.
  ok('a name in PROSE is not followed, so docstrings cannot inflate the set', !found.includes('leaf-h.mjs'));

  // THE BOUNDARY THAT KEEPS CREDENTIALS OUT. `names.mjs` in the harness re-exports the real values
  // from `<repo>/../../canari-harness/names.mjs`, which holds logins and machine-local absolute
  // paths. The pointer is hashed; what it points at must not be, or no two checkouts could ever
  // compare a verdict and a moved STATE_DIR would read as a changed instrument.
  ok(
    'the out-of-tree configuration is NOT in the graph',
    !instrumentFilesOf(join(nest, 'entry.mjs')).some((f) => f.replace(/\\/g, '/').includes('/canari-harness/'))
  );

  // ── the hash itself ───────────────────────────────────────────────────────────────────────────
  const before = instrumentShaOf(join(nest, 'entry.mjs'));
  ok('a hash is produced', typeof before === 'string' && before.length === 12);
  ok('it is stable across two reads of an unchanged tree', before === instrumentShaOf(join(nest, 'entry.mjs')));

  // THE ONE THAT MATTERS: an edit to a module the entry merely IMPORTS must move the hash. This is
  // the case `checkSha` could not see - `openConversation` in `chat.mjs` opening the wrong
  // conversation while every runner's own hash still matched (2026-09-04).
  write('leaf-b.mjs', 'export const b = 22;\n');
  ok('editing an IMPORTED module moves it', instrumentShaOf(join(nest, 'entry.mjs')) !== before);

  ok('a file that does not exist hashes to null', instrumentShaOf(join(nest, 'nope.mjs')) === null);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── a real runner, because a fixture cannot prove the graph is USEFUL ────────────────────────────
const msg1 = fileURLToPath(new URL('./msg1.mjs', import.meta.url));
if (existsSync(msg1)) {
  const real = instrumentFilesOf(msg1).map((f) => basename(f));
  // `chat.mjs` is the module whose defect started this. If a future refactor takes it out of MSG-1's
  // graph, that is worth knowing: it would mean the row stopped using the shared gesture.
  ok('MSG-1 reaches the shared chat gestures', real.includes('chat.mjs'));
  ok('MSG-1 reaches the verdict recorder', real.includes('results.mjs'));
  ok('MSG-1 reaches the CDP layer', real.includes('cdp.mjs'));
}

console.log(
  failures
    ? `[instrument] ${failures} FAILURE(S) - the hash does not see what it claims to`
    : '[instrument] clean - every specifier form is followed, and the out-of-tree config stays out'
);
process.exit(failures ? 1 : 0);
