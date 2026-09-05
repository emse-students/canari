/**
 * WHICH ESTATE A CLIENT IS ON IS A GATE, AND A GATE THAT ONLY EVER ACCEPTS IS NOT ONE.
 *
 * `pin.mjs` runs on every unlock, on both ways out of the gate, and refuses the run when the client
 * it just unlocked is talking to an estate the rig does not report on. That check decides whether a
 * `+A1` verdict means anything at all: an APK built against production installed with `--no-build`
 * would otherwise run every phone row against the real estate while the ledger recorded localhost.
 *
 * THE PREDICATE LIVED INSIDE THE COMMAND AND WAS THEREFORE TESTED BY NOTHING. Its docstring said it
 * had been *"exercised on five origin sets"* - true once, by hand, on the day it was written. The
 * defect below then shipped inside it and was found by a phase failing, which is the expensive way
 * and the one this rig has a rule against.
 *
 * THE DEFECT, measured on W1 on 2026-09-05: `new URL(name).origin` answers the string `'null'` for
 * every `data:` and `blob:` resource - an OPAQUE origin, with no host to be an estate of. The guard
 * compared `'null'` against `SITE`, found it different, and refused with the loudest sentence it
 * has, telling the reader to rebuild an APK. The offender was the application's own noise texture, a
 * `data:image/svg+xml` in its CSS, on every page. It was INTERMITTENT, which is worse than always
 * wrong: the resource timeline holds 250 entries and a navigation clears it, so whether the texture
 * was still in it depended on how long the tab had been up.
 *
 *   bun archive/estate-selftest.mjs
 */
import { estateOriginsAmong, estateVerdict, NOT_AN_ESTATE } from '../estate-origins.mjs';

const SITE = 'http://localhost:8081';
const PROD = 'https://canari-emse.fr';
const DEV = 'https://dev.canari-emse.fr';
const ENGINE = ['http://tauri.localhost', 'http://ipc.localhost'];

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

// ── the five sets the original was exercised on, now asserted rather than remembered ────────────
ok('local only is ACCEPTED', estateVerdict([SITE], SITE).ok);
ok('local behind the engine schemes is ACCEPTED', estateVerdict([...ENGINE, SITE], SITE).ok);
ok('production is REFUSED', !estateVerdict([PROD], SITE).ok);
ok('dev is REFUSED', !estateVerdict([DEV], SITE).ok);
ok('the engine schemes ALONE are refused, as silence', estateVerdict(ENGINE, SITE).reason === 'silent');

// THE STRAY IS THE CASE A WEAKER TEST PASSES. "SITE is among them" would accept this; a client
// calling both is not on the local estate, it is on both, and a verdict taken there says nothing.
const stray = estateVerdict([SITE, PROD], SITE);
ok('local WITH a production stray alongside it is REFUSED', !stray.ok);
ok('and the refusal NAMES the stray, not the whole set', stray.strangers.join() === PROD);

// ── the opaque origin: the defect this file exists for ──────────────────────────────────────────
ok("a data: URI reports 'null', which is not an estate", !estateOriginsAmong(['null']).length);
ok('so local + a data: URI is ACCEPTED', estateVerdict([SITE, 'null'], SITE).ok);
ok(
  'and local + engine + data: is ACCEPTED - the shape a real phone reports',
  estateVerdict([...ENGINE, SITE, 'null'], SITE).ok,
);
ok(
  "'null' ALONE is silence, never a pass - it names no estate to have been right about",
  estateVerdict(['null'], SITE).reason === 'silent',
);
ok('and it cannot rescue a stray either', !estateVerdict(['null', PROD], SITE).ok);

// ── the two facts that must NOT be merged ───────────────────────────────────────────────────────
// "This resource has no host" and "this resource's name could not be read" are different, and only
// the first is harmless. `pin.mjs` maps an unparseable name to `unparseable:<name>` precisely so it
// stays visible; forgiving it here would hide a client fetching something nobody can classify.
const unparseable = estateVerdict([SITE, 'unparseable:weird'], SITE);
ok('an UNPARSEABLE resource name is a stranger, not an opaque origin', !unparseable.ok);
ok('and it is named as the stranger', unparseable.strangers.join() === 'unparseable:weird');

// ── vacuity, the rule this rig applies to every gate ────────────────────────────────────────────
ok('an empty set is a REFUSAL, not a pass', !estateVerdict([], SITE).ok);
ok('and it says WHY - silent, not strangers', estateVerdict([], SITE).reason === 'silent');

// ── the shape of the answer ─────────────────────────────────────────────────────────────────────
ok('duplicates are collapsed', estateOriginsAmong([SITE, SITE, SITE]).join() === SITE);
ok('the excused list is exactly the three that are not estates', NOT_AN_ESTATE.length === 3);
ok('and a passing verdict reports the estate it accepted', estateVerdict([SITE], SITE).estates.join() === SITE);

console.log(
  failures
    ? `[estate] ${failures} FAILURE(S) - the gate deciding what a +A1 verdict is about does not hold`
    : '[estate] clean - it accepts the local estate, refuses every other, and an opaque origin is not one',
);
process.exit(failures ? 1 : 0);
