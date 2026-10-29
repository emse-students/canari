/**
 * THE "NOUVEL APPAREIL" DISMISSAL'S ALLOWLIST, PINNED (`devicenotice.mjs`).
 *
 * The plan taps only the leading notices of minted devices and stops at the first notice of any
 * other device; a seat with two accounts' pending queues is refused; the store name, the banner's
 * title and its button are pinned against the product's source, so a renamed key or a reworded
 * string fails here rather than leaving the dismissal finding nothing to tap. Pure: no rig, no
 * browser, no `names.mjs`. Every id is synthetic.
 *
 *   bun archive/devicenotice-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOTICE_DISMISS, NOTICE_STORE_PREFIX, NOTICE_TITLES, dismissPlan, queueOf } from '../devicenotice.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const MINTED_A = 'web-0a1b2c3d-mint-aaaa';
const MINTED_B = 'web-0a1b2c3d-mint-bbbb';
const FOREIGN = 'tauri-0a1b2c3d-real-cccc';
const n = (deviceId, k) => ({ key: `0a1b2c3d:${deviceId}|${k}`, deviceId });

console.log('the plan');
{
  const p = dismissPlan([n(MINTED_A, 1), n(MINTED_B, 2)], [MINTED_A, MINTED_B]);
  ok('every notice of a minted device is tapped, oldest first', p.tap.length === 2 && p.tap[0].includes(MINTED_A) && p.blockedBy === null && p.behind === 0);
}
{
  const p = dismissPlan([n(FOREIGN, 1), n(MINTED_A, 2)], [MINTED_A]);
  ok('COUNTER: a foreign notice on screen stops everything - nothing is tapped', p.tap.length === 0 && p.blockedBy?.deviceId === FOREIGN && p.behind === 1);
}
{
  const p = dismissPlan([n(MINTED_A, 1), n(FOREIGN, 2), n(MINTED_B, 3)], [MINTED_A, MINTED_B]);
  ok('COUNTER: the minted notice before a foreign one goes, the one behind it stays', p.tap.length === 1 && p.blockedBy?.deviceId === FOREIGN && p.behind === 1);
}
{
  const p = dismissPlan([n(MINTED_A, 1)], [MINTED_B]);
  ok('COUNTER: a notice of a device another row minted is foreign to this one', p.tap.length === 0 && p.blockedBy?.deviceId === MINTED_A);
}
{
  const p = dismissPlan([n(MINTED_A, 1)], []);
  ok('COUNTER: a row that minted nothing taps nothing', p.tap.length === 0 && p.blockedBy !== null);
}
{
  const p = dismissPlan([n('', 1)], ['', null]);
  ok('COUNTER: an empty or missing minted id never allows a notice', p.tap.length === 0);
}
ok('an empty queue is nothing to do', dismissPlan([], [MINTED_A]).tap.length === 0 && dismissPlan([], [MINTED_A]).blockedBy === null);

console.log('one account per seat');
ok('the one account with pending notices is the queue', queueOf([{ account: 'a', pending: [] }, { account: 'b', pending: [n(MINTED_A, 1)] }]).length === 1);
ok('no store is an empty queue', queueOf([]).length === 0);
{
  let threw = false;
  try {
    queueOf([{ account: 'a', pending: [n(MINTED_A, 1)] }, { account: 'b', pending: [n(MINTED_B, 2)] }]);
  } catch {
    threw = true;
  }
  ok('COUNTER: two accounts with pending notices on one seat is refused', threw);
}

console.log('the spellings, against the source');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const keys = readFileSync(join(ROOT, 'frontend/src/lib/utils/accountLocalKeys.ts'), 'utf8');
ok(`the store is ${NOTICE_STORE_PREFIX}<userId>`, keys.includes(`deviceNotices: (userId: string) => \`${NOTICE_STORE_PREFIX}\${userId}\``));
const fr = JSON.parse(readFileSync(join(ROOT, 'frontend/messages/fr.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(ROOT, 'frontend/messages/en.json'), 'utf8'));
ok('the banner title, in both locales', NOTICE_TITLES.includes(fr.device_notice_title) && NOTICE_TITLES.includes(en.device_notice_title));
ok('the dismiss button, in both locales', NOTICE_DISMISS.includes(fr.device_notice_dismiss) && NOTICE_DISMISS.includes(en.device_notice_dismiss));
const banner = readFileSync(join(ROOT, 'frontend/src/lib/components/shared/NewDeviceBanner.svelte'), 'utf8');
ok('the banner dismisses the notice it shows through that button', /onclick=\{\(\) => dismissDeviceNotice\(notice\.key\)\}\s*>\{m\.device_notice_dismiss\(\)\}/.test(banner));
ok('the banner shows the oldest pending notice', banner.includes('const notice = $derived(notices[0]);'));

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
