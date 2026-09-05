/**
 * A SPAWN GIVEN A NAME IT CANNOT RESOLVE FAILS SILENTLY, AND THIS RIG HAS PAID FOR IT EIGHT TIMES.
 *
 * The runners used to sit at the harness root and moved into `archive/`. Every site that spawns one
 * by BARE NAME with `cwd` set to its own directory broke the same day - and broke QUIETLY, because
 * the child exits with `Module not found` on stderr and the parent typically records stdout, which
 * is empty. `scriptpath.mjs` was written for this, and its own docstring lists the first four:
 * `type.mjs`, `rows.mjs`, `ready-repair.mjs`, `healrevoke.mjs`. It ends with the sentence that
 * explains why a fifth was inevitable - *"Each was fixed where it was found, which is how a defect
 * gets found a fourth time."*
 *
 * It was then found four more times, on 2026-09-05: `tab236.mjs` (proven live - TAB-2 recorded
 * `pin.mjs failed: ... Module not found "pin.mjs"`, and TAB-3 CANNOT WORK without it, because
 * relaunching the browser raises the PIN gate), `notif7.mjs`, `burn.mjs`, and `heal-w2.mjs` twice
 * over (`newgroup.mjs` and `invite.mjs`, with no `cwd` at all, so they resolved against whatever
 * directory the campaign happened to be started from).
 *
 * A module that exists and is not reached fixes nothing. So this is the gate, and it is what makes
 * the rule checkable instead of remembered: **no `process.execPath` spawn may name its script as a
 * bare string literal.** `requireScript()` resolves it against both directories and THROWS naming
 * them, which turns a silent no-op into one sentence; `join(HARNESS_ROOT, name)` (what `atoms.mjs`
 * does) is equally absolute and equally fine.
 *
 * WHY A STYLE RULE AND NOT A RESOLUTION CHECK. Resolving each site the way the process would means
 * statically evaluating its `cwd:` expression, and those are written five different ways here - a
 * gate that has to guess is worse than one that forbids the guessable. The forbidden shape has an
 * exact, mechanical repair, and every current site already passes.
 *
 *   bun archive/spawn-selftest.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIRS = [ROOT, join(ROOT, 'archive')];

/**
 * A `process.execPath` spawn whose first argv entry is a quoted `*.mjs` filename.
 *
 * Anchored on `process.execPath` rather than on the function name: `execFileSync('adb', ...)` and
 * `spawnSync('git', ...)` are everywhere here and none of them is spawning one of our scripts. The
 * `[\s\S]*?` between the runtime and the array tolerates the line breaks the formatter introduces.
 */
const BARE = /(?:execFileSync|spawnSync)\(\s*process\.execPath\s*,\s*\[\s*(['"])([A-Za-z0-9._-]+\.mjs)\1/g;

let failures = 0;
let scanned = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const offenders = [];
for (const dir of DIRS) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    const path = join(dir, file);
    if (path === fileURLToPath(import.meta.url)) continue; // this file quotes the shape it forbids
    const src = readFileSync(path, 'utf8');
    scanned++;
    let m;
    while ((m = BARE.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${file}:${line} spawns ${m[2]} by bare name`);
    }
  }
}

ok(`no spawn names its script by bare string (${scanned} file(s) scanned)`, offenders.length === 0);
for (const o of offenders) console.log(`         ${o}`);

// VACUITY, because a regex that matches nothing passes every file. The gate has to be shown capable
// of failing, on the exact text it exists to reject - otherwise a later edit to the pattern turns it
// into a green light nobody notices, which is the failure mode `rawcheck.mjs` had for six days.
const SPECIMEN = `const r = spawnSync(process.execPath, ['pin.mjs', '--device', DEVICE], { cwd: HERE });`;
ok('and the rule can FAIL - it matches the shape it forbids', new RegExp(BARE.source).test(SPECIMEN));

// AND IT MUST NOT FIRE ON THE REPAIR, or the only way to satisfy it would be to delete the spawn.
const REPAIRED = `const r = spawnSync(process.execPath, [requireScript('pin.mjs'), '--device', DEVICE]);`;
const JOINED = `const r = spawnSync(process.execPath, [join(HARNESS_ROOT, script), ...args]);`;
ok('and it does not fire on requireScript()', !new RegExp(BARE.source).test(REPAIRED));
ok('and it does not fire on join(HARNESS_ROOT, ...)', !new RegExp(BARE.source).test(JOINED));

// A spawn of something that is NOT one of our scripts is not this gate's business.
const FOREIGN = `execFileSync('adb', ['shell', 'am', 'kill', PKG]);`;
ok('and it does not fire on a spawn of a foreign binary', !new RegExp(BARE.source).test(FOREIGN));

console.log(
  failures
    ? `[spawn] ${failures} FAILURE(S) - a spawn that cannot resolve its script does nothing, quietly`
    : '[spawn] clean - every spawned script is resolved through scriptpath.mjs, not guessed',
);
process.exit(failures ? 1 : 0);
