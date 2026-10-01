/**
 * Pins `namesderive.mjs`: the counterpart helper answers for the pair and THROWS for anyone else.
 *
 * Needs no `names.mjs`, no browser, no estate: the values are fixtures.
 */
import { makeNameHelpers } from '../namesderive.mjs';

let failures = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};
const throws = (label, fn, needle) => {
  try {
    fn();
    failures += 1;
    console.log(`FAIL ${label}: did not throw`);
  } catch (e) {
    if (!String(e.message).includes(needle)) {
      failures += 1;
      console.log(`FAIL ${label}: threw '${e.message}', expected it to contain '${needle}'`);
    }
  }
};

const DISPLAY_NAME_OF = { owner: 'Olive Owner', peer: 'Paul Peer', third: 'Thea Third' };
const ACCOUNT_OF = { W1: 'owner', A1: 'owner', W2: 'peer', W4: 'third', W5: 'ghost' };
const h = makeNameHelpers({ DISPLAY_NAME_OF, ACCOUNT_OF });

check('OWNER_NAME derives from the keyed map', h.OWNER_NAME, 'Olive Owner');
check('PEER_NAME derives from the keyed map', h.PEER_NAME, 'Paul Peer');
check('the owner devices look for the peer', [h.peerNameFor('W1'), h.peerNameFor('A1')], ['Paul Peer', 'Paul Peer']);
check('the peer device looks for the owner', h.peerNameFor('W2'), 'Olive Owner');
check('a third account has a display name', h.displayNameFor('third'), 'Thea Third');
throws('a device outside the pair has NO counterpart', () => h.peerNameFor('W4'), 'outside the pair');
throws('a device with no account entry', () => h.peerNameFor('W9'), 'no ACCOUNT_OF entry');
throws('an account with no display name', () => h.displayNameFor('ghost'), 'no display name');
throws(
  'a map missing a pair member refuses to build',
  () => makeNameHelpers({ DISPLAY_NAME_OF: { owner: 'x' }, ACCOUNT_OF }),
  "'peer'"
);

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('names-selftest OK');
