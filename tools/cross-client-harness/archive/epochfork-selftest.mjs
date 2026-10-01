/**
 * Pins `epochfork.mjs`: the comparison that tells a healthy conversation from an epoch-forked one,
 * which a `data-ready` tile cannot. Fixtures only - no browser, no estate.
 */
import { epochForks } from '../epochfork.mjs';

let failures = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const fine = epochForks({ [A]: 4, [B]: 9 }, { [A]: 4, [B]: 9 });
check('every group at the server epoch is clean', [fine.observable, fine.clean, fine.inStep], [true, true, 2]);

const forked = epochForks({ [A]: 3, [B]: 9 }, { [A]: 4, [B]: 9 });
check('THE 2026-08-29 SHAPE: one epoch behind is not clean', forked.clean, false);
check('and names the group, cut, with its lag', forked.behind, [{ group: 'aaaaaaaa', client: 3, server: 4, lag: 1 }]);
check('the group in step is still counted', forked.inStep, 1);

const ahead = epochForks({ [A]: 5 }, { [A]: 4 });
check('a device AHEAD of the server is not in step either', [ahead.clean, ahead.ahead.length], [false, 1]);

const unknown = epochForks({}, { [A]: 4 });
check('a group the client has no epoch for is unknown, never in step', [unknown.clean, unknown.unknown], [false, ['aaaaaaaa']]);

const noClient = epochForks(null, { [A]: 4 });
check('an unreadable client half is UNOBSERVABLE, not clean', [noClient.observable, noClient.clean], [false, false]);
check('and says which half', noClient.why, 'the client epochs could not be read');
check('an unreadable server half likewise', epochForks({ [A]: 4 }, null).why, 'the server epochs could not be read');

check('a client-only group is not a fork of anything', epochForks({ [A]: 1, [B]: 2 }, { [A]: 1 }).clean, true);

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('epochfork-selftest OK');
