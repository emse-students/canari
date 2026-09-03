/**
 * THE DECISIONS THE SUBMISSION TAKES, TESTED WITHOUT APPLE.
 *
 * WHAT IS WORTH TESTING HERE, AND WHAT IS NOT. The HTTP calls cannot be exercised off App Store
 * Connect and mocking them would only assert that this file's own fake matches this file's own
 * expectations. What CAN be got wrong, silently and expensively, is the classification: a build
 * state that makes the script poll for 45 minutes and then give up, a version state that makes it
 * write into a version a human is mid-way through, and release notes that describe the release
 * before last. Every one of those is green until somebody reads a store listing.
 *
 * THE ARM THAT MATTERS MOST IS THE UNKNOWN ONE. Apple adds states; a classifier that treats
 * anything it does not recognise as "keep waiting" holds a macOS runner until the job times out and
 * says nothing about why. So an unknown state is a refusal in both classifiers, and that is
 * asserted rather than assumed.
 *
 * Run: node tools/app-store/submit.test.mjs
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyBuildState, classifyVersionState, readWhatsNew, mintToken } from './submit.mjs';

let pass = 0;
let fail = 0;
const ok = (what) => {
  pass += 1;
  process.stdout.write(`  ok    ${what}\n`);
};
const no = (what, got) => {
  fail += 1;
  process.stdout.write(
    `  FAIL  ${what}${got === undefined ? '' : ` - got ${JSON.stringify(got)}`}\n`
  );
};
const eq = (what, actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected) ? ok(what) : no(what, actual);

const dir = mkdtempSync(join(tmpdir(), 'asc-notes-'));
const notes = (body) => {
  const f = join(dir, 'whats-new.txt');
  writeFileSync(f, body, 'utf8');
  return f;
};

try {
  process.stdout.write(
    '\na build is used, waited for, or refused - never waited for indefinitely\n'
  );
  eq('VALID is used', classifyBuildState('VALID').action, 'use');
  eq('PROCESSING is waited for', classifyBuildState('PROCESSING').action, 'wait');
  eq('INVALID is refused', classifyBuildState('INVALID').action, 'fail');
  eq('FAILED is refused', classifyBuildState('FAILED').action, 'fail');
  // THE POINT OF THE WHOLE FUNCTION. Anything unrecognised must stop the run, because the
  // alternative is polling a terminal state until the runner times out.
  eq('an unknown state is refused, not polled', classifyBuildState('SOMETHING_NEW').action, 'fail');
  eq('an absent state is refused', classifyBuildState(undefined).action, 'fail');
  eq('an empty state is refused', classifyBuildState('').action, 'fail');
  if (classifyBuildState('INVALID').why.includes('INVALID')) {
    ok('the refusal names the state it saw');
  } else {
    no('the refusal names the state it saw', classifyBuildState('INVALID').why);
  }

  process.stdout.write('\na version is edited, already done, or refused\n');
  eq(
    'PREPARE_FOR_SUBMISSION is editable',
    classifyVersionState('PREPARE_FOR_SUBMISSION').action,
    'edit'
  );
  eq(
    'DEVELOPER_REJECTED is editable again',
    classifyVersionState('DEVELOPER_REJECTED').action,
    'edit'
  );
  eq('REJECTED is editable again', classifyVersionState('REJECTED').action, 'edit');
  // A RE-RUN IS AN ORDINARY EVENT - a release can be re-published, and the workflow has a
  // hand-dispatched path. A version already with Apple must be reported as done, never resubmitted.
  eq('WAITING_FOR_REVIEW is done', classifyVersionState('WAITING_FOR_REVIEW').action, 'done');
  eq('IN_REVIEW is done', classifyVersionState('IN_REVIEW').action, 'done');
  eq('READY_FOR_SALE is done', classifyVersionState('READY_FOR_SALE').action, 'done');
  eq('an unknown state is refused', classifyVersionState('SOMETHING_NEW').action, 'fail');
  eq('an absent state is refused', classifyVersionState(undefined).action, 'fail');

  process.stdout.write(
    '\nthe release notes are the ones for THIS version, or there is no release\n'
  );
  eq(
    'notes naming this version are accepted',
    readWhatsNew({ file: notes('version: 0.16.0\nDes corrections.\n'), version: '0.16.0' }),
    { ok: true, text: 'Des corrections.' }
  );

  // THE DEFECT THIS FILE EXISTS FOR. A plain "is it non-empty" check passes for ever on a notes
  // file nobody updated, and the store then carries the previous release's notes - staleness no
  // mechanism could detect, because a file cannot be asked when it was last meant.
  const stale = readWhatsNew({
    file: notes('version: 0.15.0\nDes corrections.\n'),
    version: '0.16.0',
  });
  if (stale.ok === false && stale.why.includes('0.15.0') && stale.why.includes('0.16.0')) {
    ok('notes naming an EARLIER version are refused, and the refusal names both versions');
  } else {
    no('notes naming an earlier version are refused', stale);
  }

  const unmarked = readWhatsNew({ file: notes('Des corrections.\n'), version: '0.16.0' });
  eq('notes with no version marker are refused', unmarked.ok, false);

  const empty = readWhatsNew({ file: notes('version: 0.16.0\n\n   \n'), version: '0.16.0' });
  eq('a marker with nothing under it is refused', empty.ok, false);

  const missing = readWhatsNew({ file: join(dir, 'nope.txt'), version: '0.16.0' });
  eq('an absent file is refused', missing.ok, false);

  // Written on Windows, read on a Linux runner. A carriage return on the marker line would compare
  // "0.16.0\r" against "0.16.0" and refuse the release with a message showing two identical strings.
  eq(
    'CRLF notes are accepted, because the workstation writes them',
    readWhatsNew({ file: notes('version: 0.16.0\r\nDes corrections.\r\n'), version: '0.16.0' }).ok,
    true
  );

  const long = readWhatsNew({
    file: notes(`version: 0.16.0\n${'x'.repeat(4001)}\n`),
    version: '0.16.0',
  });
  eq("notes past Apple's 4000-character limit are refused here, not there", long.ok, false);

  process.stdout.write('\nthe token is the shape App Store Connect accepts\n');
  // A GENERATED KEY, so the test carries no credential. The assertion is on the SIGNATURE LENGTH:
  // `dsaEncoding: 'ieee-p1363'` yields the 64-byte r||s pair a JWT requires, and Node's default DER
  // encoding yields a variable-length 70-72 bytes that every verifier rejects with a bare 401.
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const jwt = mintToken({ keyId: 'ABC123', issuerId: 'issuer-uuid', privateKey });
  const [h, p, s] = jwt.split('.');
  eq('it has three segments', jwt.split('.').length, 3);
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  eq('the header is ES256 and carries the key id', [header.alg, header.kid], ['ES256', 'ABC123']);
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  eq('the audience is appstoreconnect-v1', claims.aud, 'appstoreconnect-v1');
  eq('the issuer is the issuer id', claims.iss, 'issuer-uuid');
  // Apple refuses anything longer than 20 minutes outright.
  eq('the lifetime is 20 minutes', claims.exp - claims.iat, 1200);
  eq('the signature is the raw 64-byte r||s pair, not DER', Buffer.from(s, 'base64url').length, 64);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write('\n');
if (fail !== 0) {
  process.stdout.write(`${fail} of ${pass + fail} assertions FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${pass} assertions passed\n`);
