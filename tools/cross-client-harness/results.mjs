/**
 * Append-only result log for the campaign.
 *
 * A check that passes earns a row in section 10 of the wiki page and nothing else; a check that
 * fails earns a Work Package with its captured log. Both need the raw record to have survived the
 * session, so every runner writes here rather than only to stdout.
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './names.mjs';

/**
 * Outside the repository, with the rest of the machine-local state: a verdict row carries the
 * condensed dirt of the run, which quotes captured console lines, and those name real conversations.
 */
const FILE = join(STATE_DIR, 'results.ndjson');

/** Every verdict THIS process has recorded, so the exit code can be derived rather than remembered. */
const recorded = [];

export function record(id, verdict, detail) {
  const row = { id, verdict, at: new Date().toISOString(), ...detail };
  appendFileSync(FILE, `${JSON.stringify(row)}\n`);
  console.log(`[${verdict}] ${id} ${JSON.stringify(detail)}`);
  recorded.push(row);
  return row;
}

/**
 * THE EXIT CODE IS DERIVED FROM THE VERDICTS, so no script can record a failure and exit 0.
 *
 * `finish` below states the two-consumer contract and enforces it perfectly - for the six scripts
 * that call it. The other twenty-four record with `record` and then simply reach their last line, so
 * `run.mjs` printed `done` beside a recorded `FAIL` in the same table. Adding a `finishAll` for them
 * would have moved the problem rather than solved it: the omission being fixed is one of FORGETTING,
 * and a second function to remember is a second thing to forget.
 *
 * So it is not a call at all. `beforeExit` fires when a script runs off its end - exactly the path
 * that was silent - and cannot fire on `process.exit` (which `finish` already codes correctly) or on
 * an uncaught throw (which is non-zero anyway). Nothing to add to any script, nothing to omit.
 *
 * Scoped to processes that recorded SOMETHING. Many one-shot probes import `mark` from here and
 * record nothing by design, and failing those would be inventing verdicts for scripts that never
 * claimed one. A phase script that records nothing is a real fault, but a different one, and
 * `run.mjs` already shows it as a job with no row rather than as a pass.
 */
process.on('beforeExit', () => {
  if (!recorded.length || process.exitCode) return;
  const owed = recorded.filter((r) => r.verdict !== 'PASS');
  if (!owed.length) return;
  console.log(`\n  ${owed.length} verdict(s) other than PASS - exiting non-zero: ${owed.map((r) => `${r.id}=${r.verdict}`).join(', ')}`);
  process.exitCode = 1;
});

/**
 * RECORD THE VERDICT AND EXIT ON IT - the whole contract, in the one place that cannot be half done.
 *
 * A check owes its verdict to TWO consumers: `results.ndjson`, which is the campaign's record and
 * the only thing the dashboard may be written from, and the EXIT CODE, which is what `run.mjs`
 * prints a failure tail for. Every script implemented one half or the other, never both, and each
 * omission is invisible in its own way:
 *
 *   - `msg2.mjs` recorded and never exited, so a run printed `msg2.mjs  done` beside a recorded
 *     `FAIL MSG-2` - the two halves of the same run contradicting each other in one table;
 *   - `msg8.mjs`, `msg8b.mjs`, `msg9.mjs` and `msg10.mjs` exited and never recorded, so the phase
 *     table showed 9 verdicts for 12 scripts and the four silent ones read as passes. A script that
 *     records nothing is indistinguishable from one that passed, which is the worse direction.
 *
 * Exit 0 for a clean PASS only. `PASS-DIRTY`, `INCONCLUSIVE`, `VACUOUS`, `INVALID` and `FAIL` all
 * exit non-zero, because the campaign's own rule is that a verdict counts as passed only when the
 * assertions hold AND the run is clean - so anything else is work still owed, and the runner must
 * not be able to report it as done.
 */
export function finish(id, verdict, detail) {
  record(id, verdict, detail);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

export function all() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A short unique marker, so two runs of the same check never collide in the history. */
export const mark = (id) => `${id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * The same marker with a sequence number, for a check that sends a RUN of messages.
 *
 * It exists because hand-rolled sequenced markers kept being written at the call site, and they
 * drifted from what `mark` produces in the one way that matters: `PEND-mson9mr-1041`, several
 * hundred of which are sitting in the test DM, carries a stamp `recon.mjs` cannot decode, so the
 * reconciliation excluded every one of them and reported success over an empty set. Producing the
 * sequence here keeps the stamp intact and the ordinal readable.
 */
export const markSeq = (id, n) => `${mark(id)}-${String(n).padStart(4, '0')}`;

/**
 * Recognises a campaign marker in rendered text - THE ONLY definition, imported by `recon.mjs`.
 *
 * Deliberately looser than what `mark` emits, because the history holds markers from checks written
 * before it existed (`NOTIF10-0-msi3g44rb9u`, `LIFE5B-abcde`, `PEND-<stamp>-1041`). Over-matching is
 * safe and under-matching is not: a token that is not really a marker appears in BOTH clients' text
 * and reconciles away, while a marker the pattern misses is a loss that cannot be seen. Anything
 * whose stamp will not decode is dropped from the comparison by `markerStamp` rather than reported.
 */
export const MARKER_RE = /\b[A-Z][A-Z0-9]{1,11}(?:-[0-9a-z]+){1,3}\b/g;

/** Wall time a marker was minted, or null when no segment of it decodes to a plausible one. */
export function markerStamp(marker) {
  for (const segment of marker.split('-').slice(1)) {
    // Either the whole segment (`mark` before the random suffix was added) or the segment with the
    // three random characters removed. Both are tried; the plausibility bound is what decides.
    for (const candidate of [segment, segment.slice(0, -3)]) {
      const t = parseInt(candidate, 36);
      if (Number.isFinite(t) && t > 1_700_000_000_000 && t < Date.now() + 60_000) return t;
    }
  }
  return null;
}
