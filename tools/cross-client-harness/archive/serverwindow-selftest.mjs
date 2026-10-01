/**
 * Pins `serverwindow.mjs`: the server's window reaches the ledger row, a dirty one demotes a PASS,
 * and an unreadable one is never recorded as clean. The reader is injected - no estate needed.
 */
import { foldServerWindow, serverWindowDetail, takeServerWindow } from '../serverwindow.mjs';

let failures = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

const quiet = () => [];
const clean = takeServerWindow(quiet, '2026-10-01T00:00:00.000Z');
check('a quiet window is clean', clean.clean, true);
check('and carries no dirt', clean.dirt, undefined);
check('and records where it began', clean.since, '2026-10-01T00:00:00.000Z');

const noisy = (service) => (service === 'core-service' ? ['totally unclassified line'] : []);
const dirty = takeServerWindow(noisy, '2026-10-01T00:00:00.000Z');
check('an unclassified line makes the window dirty', dirty.clean, false);
check('naming the service and the count', dirty.dirt['core-service'].unexplained.count, 1);
check('and the line', dirty.dirt['core-service'].unexplained.lines, ['totally unclassified line']);
check('other services are not blamed', Object.keys(dirty.dirt), ['core-service']);

const down = takeServerWindow(() => {
  throw new Error('docker unreachable');
}, '2026-10-01T00:00:00.000Z');
check('an unreachable service is NOT clean', down.clean, false);
check('and the reason is recorded per service', Object.values(down.dirt).every((d) => /docker unreachable/.test(d.unreachable)), true);

check('a PASS over a clean window stays PASS', foldServerWindow('PASS', clean).verdict, 'PASS');
check('a PASS over a dirty window is PASS-DIRTY', foldServerWindow('PASS', dirty).verdict, 'PASS-DIRTY');
check('a FAIL is never rewritten', foldServerWindow('FAIL', dirty).verdict, 'FAIL');
check('no window leaves the verdict and the row alone', foldServerWindow('PASS', null), { verdict: 'PASS', detail: {} });
check('the row carries the window and a flat flag', Object.keys(foldServerWindow('PASS', dirty).detail), ['serverWindow', 'serverClean']);
check('a hand-built report condenses the same way', serverWindowDetail({ since: 's', clean: true }), { since: 's', clean: true });

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('serverwindow-selftest OK');
