/**
 * NO CHECK MAY SPELL THE APPLICATION'S ORIGIN. `SITE` IS WHERE THE ESTATE IS NAMED.
 *
 * ## The bug this exists to end, four times over
 *
 * The campaign moved to the LOCAL estate on 2026-09-03 and `SITE` became `http://localhost:8081`.
 * Every rule still anchored on `https://canari-emse.fr` went quietly false that day - not broken,
 * FALSE, which is worse, because a predicate that can no longer match does not fail: it answers.
 *
 *   - `watch.mjs` stripped that origin before rendering a request line, so `ignoringExpectedRefusal`
 *     compared a full URL against a path regex and forgave nothing. MENTION-5 recorded PASS-DIRTY
 *     on the 404 it exists to provoke.
 *   - `classify-selftest.mjs` had an assertion pinning the STRIPPED spelling, so it went green over
 *     the renderer that produced it.
 *   - `grp.mjs` required an invitation link to start with that origin. GRP-4 recorded **FAIL** -
 *     `urlShapeOk: false` beside `linkGenerationError: false`, an instrument accusing the product
 *     of breaking a link that was perfectly well formed.
 *   - the same row then stripped the origin by name to get a path, removed nothing, and handed a
 *     whole URL to `goto` as a path: `Cannot navigate to invalid URL (-32000)`.
 *
 * And `tab236.mjs` navigated a reopened tab to `https://canari-emse.fr/chat` outright - a row about
 * tabs would have driven a browser holding a live campaign session to the REAL SITE while reporting
 * on localhost.
 *
 * ## What it refuses, and what it deliberately allows
 *
 * The APP's origin, spelt in executable code. Comments are stripped first: this rig documents the
 * defects it has survived, at length, and a gate that could not tell prose from code would forbid
 * writing any of it down.
 *
 * THE IDENTITY PROVIDERS ARE NOT THE APP. `auth.canari-emse.fr` and `cas.emse.fr` are the real
 * Authentik and CAS hosts whatever estate the app runs on - the local estate signs in against
 * production identity, which is why the accounts are real accounts - so `login.mjs`'s `atAnIdP` is
 * correct as spelt and stays.
 *
 *   bun archive/origin-selftest.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_ROOT } from '../scriptpath.mjs';
import { codeOnly } from '../srcscan.mjs';

// This file has to spell what it forbids, in prose and in a pattern, so it excludes itself - by its
// OWN path, because a list of exempt filenames is a hole anything could be added to.
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

// SELF-TESTS HAVE NO ESTATE, so a spelt origin in one is DATA and never a rule. They are pure and
// run in CI from tracked files alone - `gate-selftest.mjs` enforces exactly that - so a self-test
// literally cannot import `SITE`, and forbidding the literal would forbid the one thing several of
// them exist to pin: that a classifier answers the same for the production spelling of a line as
// for the local one. `classify-selftest.mjs` carries three such fixtures on purpose.
const files = walk(HARNESS_ROOT).filter(
  (f) =>
    f !== SELF && !/[\\/]names\.(example\.)?mjs$/.test(f) && !/-selftest\.mjs$/.test(f)
);

/** The app's own host, in any spelling, but never one of the identity providers. */
const APP_HOST = /(?<!auth\.)(?<!cas\.)\bcanari-emse\.fr\b/g;
/** Anything that reads the estate from where it is declared. */
const DERIVED = /\bSITE\b/g;

const offenders = [];
let derivedUses = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  derivedUses += [...src.matchAll(DERIVED)].length;
  for (const m of codeOnly(src).matchAll(APP_HOST)) {
    const line = src.slice(0, m.index).split('\n').length;
    offenders.push(`${relative(HARNESS_ROOT, f).replace(/\\/g, '/')}:${line}`);
  }
}

// A GATE OVER AN EMPTY SET IS A VACUOUS PASS. If the walk or the comment-stripper ever stops
// working, the loop below holds trivially and this line is what says so.
ok(`the rig names its estate through SITE at all (${derivedUses} use(s))`, derivedUses > 5);

for (const o of offenders) {
  ok(`${o} spells the application's origin instead of using SITE`, false);
}

console.log(
  failures
    ? `[origin] ${failures} FAILURE(S) - a rule anchored on a spelt origin does not FAIL when the` +
        ' estate moves, it ANSWERS, and four checks were quietly deciding nothing before this gate'
    : `[origin] clean - no executable line spells the application's origin (${derivedUses} SITE use(s))`
);
process.exit(failures ? 1 : 0);
