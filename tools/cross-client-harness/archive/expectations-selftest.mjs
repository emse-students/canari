/**
 * Pins `expectations.mjs`: an unarmed row (COMM-9/10's `VACUOUS` with `failures: []`) names every
 * precondition it could not get, and `true` is the only thing that arms it.
 */
import { armingFailures, unmet } from '../expectations.mjs';

let failures = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

check('all true arms the row', armingFailures({ a: true, b: true }), { armed: true, failures: [] });
check(
  'the COMM-9/10 shape: the kept message never arrived, and the row says so',
  armingFailures({ peerOnTheSalonRosterBefore: true, theKeptMessageArrived: false, peerHeldASeedBefore: true }),
  { armed: false, failures: ['could not arm - theKeptMessageArrived: false'] }
);
check(
  'a step that never ran is named with its value, apart from one that said no',
  armingFailures({ x: undefined, y: null, z: false }).failures,
  ['could not arm - x: undefined', 'could not arm - y: null', 'could not arm - z: false']
);
check('a truthy non-true value does not arm', armingFailures({ n: 1 }).armed, false);
check('unmet stays the one primitive', unmet({ a: true, b: false }), ['b: false']);

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('expectations-selftest OK');
