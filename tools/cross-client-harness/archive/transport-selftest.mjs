/**
 * A RUNNER THAT WAITS ON A NOTIFICATION MUST HAVE RENEWED THE PUSH TRANSPORT FIRST.
 *
 * ## The four verdicts this exists to stop
 *
 * On 2026-09-07 NOTIF-9 and NOTIF-11 recorded FAIL twice each with `notifiedInMs: null` over an app
 * that had done nothing wrong. The phone's connection to Google was ESTABLISHED throughout and
 * carried none of the six messages FCM had ACCEPTED; a new connection delivered the whole backlog
 * in five seconds. The full measurement, and the board pattern that had been legible for hours
 * before anyone read it, are in `fcmlink.mjs`.
 *
 * ## Why a gate and not a note
 *
 * `phone.awaitNotification` cannot tell "the app did not notify" from "the message never arrived",
 * and NOTHING downstream can either - the two produce byte-identical rows. So the distinction has
 * to be made BEFORE the row runs, by the one gesture that makes it: renewing the link and proving
 * it new. That is a precondition, and a precondition a runner is trusted to remember is one a new
 * runner will not have.
 *
 * The cost of forgetting is not a failed run. MENTION-3's claim half asserts SILENCE, so a dead
 * transport makes it PASS - a green row over a product that was never asked anything.
 *
 * ## What it matches, and what is exempt
 *
 * `phone.awaitNotification(` is the shared choke point of every push row by signature, so a file
 * that calls it is waiting on the transport by definition and needs no interpretation. `phone.mjs`
 * implements the wait and `fcmlink.mjs` implements the renewal; neither can perform it on itself.
 *
 *   bun archive/transport-selftest.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_ROOT } from '../scriptpath.mjs';

// This file writes both matched forms out in its own prose, so it excludes itself BY PATH - a list
// of exempt names is a hole anything can be added to, and `import.meta.url` cannot be claimed.
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

const files = walk(HARNESS_ROOT).filter((f) => f !== SELF);

/** `phone.awaitNotification(...)` - a row whose verdict the push transport decides. */
const WAITS = /\bphone\.awaitNotification\s*\(/;
/** `requireFreshFcmLink(...)` - the renewal, however the file spells its import. */
const RENEWS = /\brequireFreshFcmLink\s*\(/;

let waiters = 0;
const unrenewed = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  if (!WAITS.test(src)) continue;
  // `phone.mjs` implements the wait, `fcmlink.mjs` the renewal - neither performs it on itself.
  if (/[\\/](phone|fcmlink)\.mjs$/.test(f)) continue;
  waiters += 1;
  if (!RENEWS.test(src)) unrenewed.push(relative(HARNESS_ROOT, f).replace(/\\/g, '/'));
}

// A GATE OVER AN EMPTY SET IS A VACUOUS PASS. If the walk or the regex ever stops matching, the
// loop below holds trivially and this file reports "clean" over a rule it no longer enforces.
ok(`the rig waits on notifications at all (${waiters} runner(s) do)`, waiters > 2);
for (const f of unrenewed) {
  ok(`${f} waits on a notification without renewing the FCM link first`, false);
}

console.log(
  failures
    ? `[transport] ${failures} FAILURE(S) - a runner waits on a notification without renewing the ` +
      `phone's FCM link, so a link that is ESTABLISHED and dead records a product verdict about a ` +
      `message that never left Google. Call \`requireFreshFcmLink(<row id>)\` before the row sends ` +
      `anything - see fcmlink.mjs`
    : `[transport] clean - all ${waiters} runner(s) that wait on a notification renew the link first`
);
process.exit(failures ? 1 : 0);
