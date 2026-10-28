/**
 * WHICH `ssh` FAILURES ARE RETRIED, PINNED (`ssh.mjs` `transportFailure`): the transport's own (255,
 * and a call killed for never answering) and nothing else - a remote command's answer, even a
 * failing one, must reach the caller unretried. Pure: no host is contacted.
 *
 *   bun archive/ssh-selftest.mjs
 */
import { execFileSync } from 'node:child_process';
import { transportFailure } from '../ssh.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

ok("ssh's own status 255 is the transport's", transportFailure({ status: 255 }) === '255');
ok('a remote command that exited 1 is an answer, never retried', transportFailure({ status: 1 }) === null);
ok('a remote command that exited 2 is an answer too', transportFailure({ status: 2 }) === null);
ok('no error shape at all is not a transport failure', transportFailure(undefined) === null && transportFailure({}) === null);

// THE REAL SHAPE, not a guess at it: a child killed by `timeout` is what TOK-3 met.
let killed = null;
try {
  execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 200 });
} catch (e) {
  killed = e;
}
ok(`a call killed for never answering is ETIMEDOUT with no exit status (code=${killed?.code}, status=${killed?.status})`, transportFailure(killed) === 'ETIMEDOUT');

let answered = null;
try {
  execFileSync(process.execPath, ['-e', 'process.exit(3)'], { timeout: 5000 });
} catch (e) {
  answered = e;
}
ok(`a child that answered with exit 3 inside its time is not retried (status=${answered?.status})`, transportFailure(answered) === null);

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
