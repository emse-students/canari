/**
 * EVERY IMPORT IN EVERY RUNNER RESOLVES, AND NAMES SOMETHING THE TARGET ACTUALLY EXPORTS.
 *
 * WHY THIS EXISTS. `archive/roster.mjs` imported `psql` from `../ssh.mjs`, which exports only `SSH`
 * and `ssh` - a leftover from when the rig reached PRODUCTION over SSH, before it moved to the local
 * estate on 2026-09-03. The four membership-table rows it carries (MULTI-7, -8, -9, -10) therefore
 * died at module load with `Export named 'psql' not found`, recorded nothing, and had NEVER ONCE RUN.
 * The phase reported them as "exited non-zero", which is true of a broken import and of a real
 * failure alike, so nobody looked.
 *
 * The same week, `notif7.mjs` was found shelling out to `a1.py`, a file that was never committed.
 * TWO INSTRUMENT FAULTS OF ONE SHAPE: a runner that cannot start cannot answer anything, and the
 * campaign counts it as a row that failed rather than as a row that was never asked.
 *
 * STATIC, AND THAT IS THE WHOLE DESIGN. These runners EXECUTE on import - they drive browsers, kill
 * apps and write verdicts - so this gate must never import one. It reads the source, resolves each
 * relative specifier against the filesystem, and asserts that every named binding appears as an
 * export in the target. No process is spawned and no device is touched.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Bare specifiers (`node:fs`, packages) are left alone: they
 * are resolved by the runtime and a wrong one fails loudly at the first run rather than silently for
 * a month. `export *` in a target makes that target opaque, so its importers are accepted - and the
 * count of those is REPORTED, because a rig where everything re-exports everything would make this
 * gate vacuous without failing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let failures = 0;
let checked = 0;
let opaque = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

/** Every `.mjs` in the harness root and in `archive/`, which is where every runner lives. */
function harnessFiles() {
  const out = [];
  for (const dir of [ROOT, HERE]) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.mjs')) out.push(resolve(dir, name));
    }
  }
  return out.sort();
}

/** The named bindings and the specifier of each static import, ignoring bare specifiers. */
function relativeImports(source) {
  const found = [];
  // LINE-ANCHORED, AND THAT IS THE WHOLE CORRECTNESS OF THIS GATE. A real ES import is a
  // top-level statement and therefore starts its line; a sentence ABOUT an import does not.
  // An unanchored walk reported three failures on its first run and all three were prose:
  // `gate-selftest.mjs` explaining this very trap, `instrument.mjs` listing the import forms it
  // recognises, and one more comment. `gate-selftest.mjs` had already documented the pit and I
  // fell into it one file away - which is what a gate that accuses the wrong thing costs.
  const re = /^[ 	]*import\s+([^;'\"]*?)\s*from\s*['\"](\.[^'\"]+)['\"]/gm;
  for (const m of source.matchAll(re)) {
    const clause = m[1].trim();
    const spec = m[2];
    const braced = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    const names = braced
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
      .filter((n) => n !== '' && n !== 'type');
    found.push({ spec, names });
  }
  return found;
}

/** What a module exports by name, plus whether it re-exports something wholesale. */
function exportsOf(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g))
    names.add(m[1]);
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g))
    names.add(m[1]);
  // `export { a, b as c }` - the EXPORTED name is what an importer may ask for.
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      const exported = (bits[1] ?? bits[0] ?? '').trim();
      if (exported) names.add(exported);
    }
  }
  const wildcard = /export\s+\*\s+from/.test(source);
  return { names, wildcard };
}

console.log('every runner can be loaded at all:');
for (const file of harnessFiles()) {
  const source = readFileSync(file, 'utf8');
  const rel = file.replace(ROOT + '\\', '').replace(ROOT + '/', '').split('\\').join('/');
  for (const { spec, names } of relativeImports(source)) {
    const target = resolve(dirname(file), spec);
    checked++;
    if (!existsSync(target)) {
      bad(`${rel} imports ${spec}, which does not exist`);
      continue;
    }
    const { names: exported, wildcard } = exportsOf(readFileSync(target, 'utf8'));
    if (wildcard) {
      opaque++;
      continue;
    }
    const missing = names.filter((n) => !exported.has(n));
    if (missing.length > 0) {
      bad(`${rel} imports { ${missing.join(', ')} } from ${spec}, which exports no such name`);
    }
  }
}

// NON-VACUOUS, and this is the assertion that makes the rest mean anything: a parser that matched
// nothing would print no failures and look clean.
if (checked < 100) bad(`only ${checked} relative import(s) examined - the parser matched almost nothing`);
else ok(`${checked} relative import(s) across the rig resolve and name a real export`);
if (opaque > 0) console.log(`  note ${opaque} import(s) target a module using \`export *\`, so their names cannot be checked here`);

if (failures > 0) {
  console.log(`\n[imports] ${failures} failure(s) - a runner that cannot start cannot answer anything`);
  process.exit(1);
}
console.log('[imports] clean - every relative import in the rig resolves to a real export');
