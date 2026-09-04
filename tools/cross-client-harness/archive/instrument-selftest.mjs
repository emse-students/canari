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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
// would prove nothing. And at the harness ROOT rather than beside this file, so the fixture's
// `../names.mjs` names the real one: getting that wrong is what failed this test's first run.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(ROOT, 'instrument-selftest-'));
try {
  const write = (name, body) => writeFileSync(join(dir, name), body, 'utf8');

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
      `import { PORTS } ${FROM} '../names.mjs';`,
      `import { existsSync } ${FROM} 'node:fs';`,
      `import { load } ${FROM} '@tauri-apps/plugin-store';`,
      'export { a, late, PORTS, existsSync, load };',
      '',
    ].join('\n')
  );

  const found = instrumentFilesOf(join(dir, 'entry.mjs')).map((f) => basename(f));

  ok('the entry itself is in its own graph', found.includes('entry.mjs'));
  ok('`import x from` is followed', found.includes('leaf-a.mjs'));
  ok('TRANSITIVELY - a file reached only through another is in', found.includes('leaf-b.mjs'));
  ok('a bare `import` for side effects is followed', found.includes('leaf-c.mjs'));
  ok('`export * from` is followed', found.includes('leaf-d.mjs'));
  ok('a dynamic `import()` is followed', found.includes('leaf-e.mjs'));
  ok('an in-tree module reached with `../` is in', found.includes('names.mjs'));
  ok('a node: builtin is not a file and is not in', !found.some((f) => f.includes('node:')));
  ok('a bare package specifier is not followed', !found.some((f) => f.includes('plugin-store')));

  // THE BOUNDARY THAT KEEPS CREDENTIALS OUT. `names.mjs` in the harness re-exports the real values
  // from `<repo>/../../canari-harness/names.mjs`, which holds logins and machine-local absolute
  // paths. The pointer is hashed; what it points at must not be, or no two checkouts could ever
  // compare a verdict and a moved STATE_DIR would read as a changed instrument.
  ok(
    'the out-of-tree configuration is NOT in the graph',
    !instrumentFilesOf(join(dir, 'entry.mjs')).some((f) => f.replace(/\\/g, '/').includes('/canari-harness/'))
  );

  // ── the hash itself ───────────────────────────────────────────────────────────────────────────
  const before = instrumentShaOf(join(dir, 'entry.mjs'));
  ok('a hash is produced', typeof before === 'string' && before.length === 12);
  ok('it is stable across two reads of an unchanged tree', before === instrumentShaOf(join(dir, 'entry.mjs')));

  // THE ONE THAT MATTERS: an edit to a module the entry merely IMPORTS must move the hash. This is
  // the case `checkSha` could not see - `openConversation` in `chat.mjs` opening the wrong
  // conversation while every runner's own hash still matched (2026-09-04).
  write('leaf-b.mjs', 'export const b = 22;\n');
  ok('editing an IMPORTED module moves it', instrumentShaOf(join(dir, 'entry.mjs')) !== before);

  ok('a file that does not exist hashes to null', instrumentShaOf(join(dir, 'nope.mjs')) === null);
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
