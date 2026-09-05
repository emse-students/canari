/**
 * NO CHECK MAY SPELL A DEVTOOLS PORT. `names.mjs` IS WHERE A DEVICE IS NAMED.
 *
 * ## The bug this exists to end
 *
 * `PORTS` in `names.mjs` is the map from a device name to the devtools endpoint that IS that device
 * - profile, MLS identity, session and enrolment. It is out of tree precisely so one machine's
 * layout can differ from another's. Measured 2026-09-05: sixteen runners called `client(9224, ...)`
 * with the number written out, and ELEVEN OF THOSE SIXTEEN ALREADY IMPORTED `PORTS` and used it
 * elsewhere in the same file - so a single runner named the same device two ways, one of which
 * follows `names.mjs` and one of which does not.
 *
 * WHAT THAT COSTS IS NOT AN ERROR. Change a port - add a second phone, move a profile, take the
 * `A2` gap `login.mjs` derives `TAB_PORT` from - and the imported half follows while the spelt half
 * connects to whatever now answers on the old number, or to nothing. Connecting to nothing is the
 * good case, because it says so. Connecting to the WRONG DEVICE does not: the run proceeds, the
 * assertions hold or fail on a client nobody meant to look at, and the verdict is recorded against
 * a device name that was never involved. A campaign whose whole premise is that W1 and W2 are two
 * distinct devices cannot survive an instrument that is vague about which one it opened.
 *
 * ## Why it matches `client(` and nothing wider
 *
 * A bare four-digit number is not evidence of anything - a timeout, a pixel, a message count and a
 * port all look alike, and a gate that guessed between them would be argued with rather than
 * obeyed. `client()`'s first argument is a port BY SIGNATURE, so a numeric literal there is a
 * device named by number and needs no interpretation. `names.mjs` itself is exempt: it is the file
 * that holds the values.
 *
 *   bun archive/ports-selftest.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_ROOT } from '../scriptpath.mjs';

// THIS FILE IS ITS OWN COUNTER-EXAMPLE. It has to write the refused form out, twice, in order to
// say what it refuses - so a gate that reads the whole tree reads its own prose and fails on it.
// Excluded by its OWN path rather than by name: a list of exempt filenames is a hole anything could
// be added to, and `import.meta.url` cannot be claimed by another file.
const SELF = fileURLToPath(import.meta.url);

/** Every `.mjs` under `dir`, recursively. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (extname(full) === '.mjs') out.push(full);
  }
  return out;
}

let failures = 0;
const ok = (what, cond) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
};

const files = walk(HARNESS_ROOT).filter(
  (f) => f !== SELF && !/[\\/]names\.(example\.)?mjs$/.test(f)
);

/** `client(9224, ...)` - a device named by number. Whitespace and newlines between are allowed. */
const SPELT = /\bclient\(\s*(\d{2,5})\b/g;
/** `client(PORTS.W1, ...)` - a device named by name, which is what every call should look like. */
const NAMED = /\bclient\(\s*PORTS\./g;

const offenders = [];
let namedCalls = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  namedCalls += [...src.matchAll(NAMED)].length;
  for (const m of src.matchAll(SPELT)) {
    const line = src.slice(0, m.index).split('\n').length;
    offenders.push(`${relative(HARNESS_ROOT, f).replace(/\\/g, '/')}:${line} client(${m[1]}`);
  }
}

// A GATE OVER AN EMPTY SET IS A VACUOUS PASS, which this project refuses everywhere else: if the
// walk or the regex ever stops matching, the loop below holds trivially and says nothing.
ok(`the rig opens clients at all (${namedCalls} call(s) named through PORTS)`, namedCalls > 10);

for (const o of offenders) {
  ok(`${o} names a device by number instead of PORTS`, false);
}

console.log(
  failures
    ? `[ports] ${failures} FAILURE(S) - a runner names a device by number, so it follows names.mjs` +
        ' in one place and not in another, and a moved port sends it to the wrong client silently'
    : `[ports] clean - every client() in the rig names its device through PORTS (${namedCalls} call(s))`
);
process.exit(failures ? 1 : 0);
