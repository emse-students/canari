/**
 * Pins the two ways a client's identity can be misread, and the one way it must not pass quietly.
 *
 * The false P1 of 2026-09-09 was not caught by any check because none existed: the rig could name an
 * account by login and by display name, and the only key the server decides by was unreachable from
 * code. These are the cases that check has to get right, and none of them needs a browser.
 */
import { subjectOfToken, nameSubject, describeIdentity, wrongIdentities } from '../subject.mjs';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

const jwt = (payload) =>
  `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

const OWNER = 'f7a9bb80'.repeat(8);
const PEER = 'c71e1a5b'.repeat(8);
const roleOf = (s) => (s === OWNER ? 'owner' : s === PEER ? 'peer' : null);

check('a subject is read out of the payload', subjectOfToken(jwt({ sub: OWNER })), OWNER);
check('a token with no sub is null, not a throw', subjectOfToken(jwt({ admin: true })), null);
check('garbage is null, not a throw', subjectOfToken('not-a-token'), null);
check('an absent token is null', subjectOfToken(null), null);

check('a known subject is named', nameSubject(PEER, roleOf), 'peer');
check(
  'an UNKNOWN subject is reported, cut to twelve characters, never dropped and never printed whole',
  nameSubject('deadbeef'.repeat(8), roleOf),
  'unknown:deadbeefdead'
);

check(
  'the ordinary case: shows and acts as the account that owns it',
  describeIdentity({ saved: PEER, tokenSub: PEER, expected: 'peer', roleOf }),
  { shows: 'peer', actsAs: 'peer', agrees: true, correct: true }
);
check(
  'THE SPLIT the P1 claimed: shows one account, acts as another - both halves must be visible',
  describeIdentity({ saved: PEER, tokenSub: OWNER, expected: 'peer', roleOf }),
  { shows: 'peer', actsAs: 'owner', agrees: false, correct: false }
);
check(
  'the whole client is the wrong account: it agrees with itself and is still wrong',
  describeIdentity({ saved: OWNER, tokenSub: OWNER, expected: 'peer', roleOf }),
  { shows: 'owner', actsAs: 'owner', agrees: true, correct: false }
);
check(
  'no token yet is NOT an agreement, and is not correct either',
  describeIdentity({ saved: PEER, tokenSub: null, expected: 'peer', roleOf }),
  { shows: 'peer', actsAs: null, agrees: false, correct: false }
);

check(
  'an unreachable client is not a fault; a wrong one is',
  wrongIdentities([
    { device: 'W1', reachable: true, correct: true },
    { device: 'W2', reachable: true, correct: false },
    { device: 'W3', reachable: false },
  ]).map((r) => r.device),
  ['W2']
);

if (failures > 0) {
  console.log(`\nidentity-selftest: ${failures} failure(s)`);
  process.exit(1);
}
console.log('identity-selftest: ok');
