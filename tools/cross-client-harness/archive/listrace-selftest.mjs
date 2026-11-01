/**
 * LIST-RACE-1'S TABLE AND JUDGE, PINNED (`listracerows.mjs`).
 *
 * The premise first, then the question: a held row whose answer was not held when the salon was
 * heard, or was held past the client's own 20 s stall, is INVALID - never a PASS that measured a
 * fresh answer, which is what the first run of this row did. Pure: no rig, no browser.
 *
 *   bun archive/listrace-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { ROW_TABLES, devicesFor } from '../checks.mjs';
import { isGroupDebris } from '../debris.mjs';
import { HOLD_RELEASE_BOUND_MS, LISTED_ROUNDS, LIST_RACE_ROWS, listRaceOwn } from '../listracerows.mjs';
import { rowGroupName } from '../rowkit.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

// ── the table ───────────────────────────────────────────────────────────────────────────────────
const rows = Object.entries(LIST_RACE_ROWS);
ok('four rows: the web and phone pairs, each with its control', rows.length === 4 && ['W', 'A1'].every((k) => LIST_RACE_ROWS[`LIST-RACE-1-${k}`]?.hold === true && LIST_RACE_ROWS[`LIST-RACE-1-${k}-CTL`]?.hold === false));
ok('a control plays the same seats as its row', ['W', 'A1'].every((k) => LIST_RACE_ROWS[`LIST-RACE-1-${k}`].devices.join() === LIST_RACE_ROWS[`LIST-RACE-1-${k}-CTL`].devices.join()));
ok('every row opens W1 and its subject, and a joiner only when it has one', rows.every(([, r]) => r.devices.includes('W1') && r.devices.includes(r.subject) && (r.joiner === null || r.devices.includes(r.joiner))));
ok('the phone row starts its listing with a first salon, the web row with a join', LIST_RACE_ROWS['LIST-RACE-1-A1'].firstSalon && LIST_RACE_ROWS['LIST-RACE-1-A1'].joiner === null && !LIST_RACE_ROWS['LIST-RACE-1-W'].firstSalon && LIST_RACE_ROWS['LIST-RACE-1-W'].joiner);
ok('the release bound is under the client stall of 20 s', HOLD_RELEASE_BOUND_MS < 20_000);
ok("the row's community is a sweepable shape", isGroupDebris(rowGroupName('LIST-1')));
ok('the runner holds the ANSWER, never the request', /fault: 'hold-answer once'/.test(readFileSync(new URL('./listrace.mjs', import.meta.url), 'utf8')) && !/fault: 'hold once'/.test(readFileSync(new URL('./listrace.mjs', import.meta.url), 'utf8')));

// ── the registry ────────────────────────────────────────────────────────────────────────────────
ok('the table is the runner table of listrace.mjs', ROW_TABLES['listrace.mjs'] === LIST_RACE_ROWS);
const phone = devicesFor('listrace.mjs', ['--row', 'LIST-RACE-1-A1']);
ok('the phone row is preflighted with A1', phone.devices.includes('A1'));
ok('the web row is preflighted with its three browsers and no phone', ['W1', 'W4', 'W8'].every((d) => devicesFor('listrace.mjs', ['--row', 'LIST-RACE-1-W']).devices.includes(d)) && !devicesFor('listrace.mjs', ['--row', 'LIST-RACE-1-W']).devices.includes('A1'));

// ── the judge ───────────────────────────────────────────────────────────────────────────────────
const held = { hold: true, joinedInSession: 1, heard: 1, heldStill: 1, heldForMs: 3_000, stalled: false, listedRound: 1 };
ok('held, heard while held, listed: PASS', listRaceOwn(held).verdict === 'PASS');
ok('held, heard while held, never listed: FAIL (the RED of 2026-10-26)', listRaceOwn({ ...held, listedRound: null }).verdict === 'FAIL');
ok('a FAIL names the rounds it waited', listRaceOwn({ ...held, listedRound: null }).failures[0].includes(String(LISTED_ROUNDS)));
ok('nothing held when the salon was heard: INVALID, not PASS', listRaceOwn({ ...held, heldStill: 0 }).verdict === 'INVALID');
ok('held past the bound: INVALID', listRaceOwn({ ...held, heldForMs: HOLD_RELEASE_BOUND_MS + 1 }).verdict === 'INVALID');
ok('a hold with no pause recorded: INVALID', listRaceOwn({ ...held, heldForMs: null }).verdict === 'INVALID');
ok('the client stalled and retried unheld: INVALID, even when listed', listRaceOwn({ ...held, stalled: true }).verdict === 'INVALID');
ok('never joined in session: INVALID (the void A1 run of 2026-10-26)', listRaceOwn({ ...held, joinedInSession: null }).verdict === 'INVALID');
ok('the salon never heard live: INVALID', listRaceOwn({ ...held, heard: null }).verdict === 'INVALID');
const ctl = { hold: false, joinedInSession: 1, heard: 2, heldStill: null, heldForMs: null, stalled: false, listedRound: 1 };
ok('a control needs no hold: listed is PASS', listRaceOwn(ctl).verdict === 'PASS');
ok('a control not listed: FAIL', listRaceOwn({ ...ctl, listedRound: null }).verdict === 'FAIL');

if (failures) {
  console.log(`\nlistrace-selftest: ${failures} FAILED`);
  process.exit(1);
}
console.log('\nlistrace-selftest: all pass');
