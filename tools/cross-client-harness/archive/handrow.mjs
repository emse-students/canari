/**
 * RECORDS A ROW A PERSON PLAYED - the `O` rows of the 1.4.1 plan, section 4.3.
 *
 *   bun archive/handrow.mjs --row LIFE-5 --verdict PASS --what "<observed>" --since 2026-10-25T09:00:00.000Z
 *   bun archive/handrow.mjs --row CALL-12 --verdict SKIPPED --what "<why>"
 *
 * The person's observation is the client side and is recorded as `unobservable`; the server window
 * from `--since` (the start the lead gives) is the only thing the rig reads, and a dirty one demotes
 * a PASS. Judgement and wording in `handrows.mjs`, pinned by `archive/handrow-selftest.mjs`.
 */
import { srvLines } from '../estate.mjs';
import { HAND_ROWS, handRecord, parseHandArgs } from '../handrows.mjs';
import { exitOnRecorded, record } from '../results.mjs';
import { takeServerWindow } from '../serverwindow.mjs';

const args = parseHandArgs(process.argv.slice(2), Date.now());
if ('error' in args) {
  console.error(`[handrow] ${args.error}`);
  console.error(`usage: bun archive/handrow.mjs --row ${Object.keys(HAND_ROWS).join('|')} --verdict <V> --what "<observed>" --since <ISO>`);
  process.exit(2);
}
console.log(`[handrow] ${args.row} ${args.verdict}${args.since ? `, server window from ${args.since}` : ''}`);
const serverWindow = args.since ? takeServerWindow(srvLines, args.since, [], args.row) : null;
const { verdict, detail } = handRecord({ ...args, serverWindow });
if (verdict !== args.verdict) console.warn(`[handrow] ${args.row}: the server window was not clean - recorded ${verdict}, not ${args.verdict}`);
record(args.row, verdict, detail);
exitOnRecorded();
