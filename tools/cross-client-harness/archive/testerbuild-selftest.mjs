/**
 * THE PLAY TESTER BUILD'S PROVENANCE, PINNED (`testerbuild.mjs`).
 *
 * A pre-release whose Android job said dev, built the commit the phone runs and finished around the
 * phone's bundle is accepted, and its record passes `appBundleVerdict`; each fact broken alone is
 * refused - a STABLE (a production build), a run that failed, a job that never said dev, another
 * commit, a bundle built outside the job, another versionName, a rig on another estate. Pure: no
 * rig, no phone, no `names.mjs`. Every id is synthetic.
 *
 *   bun archive/testerbuild-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appBundleVerdict } from '../estate-origins.mjs';
import { builtCommitOf, saidDev, testerBuildVerdict } from '../testerbuild.mjs';
import { installVerdict } from '../a1plan.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const DEV = 'https://dev.example.test';
const JOB_NAME = 'Google Play / Build Android APK';
const P = `${JOB_NAME}\tUNKNOWN STEP\t`;
const LOG = [
  `${P}2026-10-27T19:09:26.2643037Z HEAD is now at 0a1b2c3 chore: bump version to 9.8.7-alpha.1`,
  `${P}2026-10-27T19:11:05.5353346Z \u001b[36;1m  echo "Android build targets \${URL_ENVIRONMENT} (\${APP_URL})"\u001b[0m`,
  `${P}2026-10-27T19:11:05.5435619Z Android build targets dev (***)`,
].join('\n');
const base = {
  tag: 'v9.8.7-alpha.1',
  release: { isPrerelease: true },
  job: { id: 11, run: 22, name: JOB_NAME, conclusion: 'success', startedAt: '2026-10-27T19:09:06Z', completedAt: '2026-10-27T19:21:49Z' },
  log: LOG,
  stamp: { builtAt: '2026-10-27T19:15:00.000Z', commit: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567' },
  installed: { versionName: '9.8.7-alpha.1', versionCode: '2009870101' },
  site: DEV,
  now: '2026-10-27T20:00:00.000Z',
};
const refused = (patch, label, re) => {
  const v = testerBuildVerdict({ ...base, ...patch });
  ok(`COUNTER: ${label}`, !v.ok && !v.record && (!re || re.test(v.reason)));
};

console.log('the log');
ok("the job's checkout of its version bump is read", builtCommitOf(LOG, '9.8.7-alpha.1') === '0a1b2c3');
ok('... and not for another version', builtCommitOf(LOG, '9.8.7-alpha.2') === null);
ok("android.yml's dev line is read", saidDev(LOG));
ok('COUNTER: the echoed script line alone is not the dev line', !saidDev(LOG.split('\n')[1]));
ok('COUNTER: a production line is not the dev line', !saidDev(`${P}2026-10-27T19:11:05.5Z Android build targets production (***)`));

console.log('the verdict');
const good = testerBuildVerdict(base);
ok('a pre-release built for dev, the phone on its bundle: ACCEPTED', good.ok && good.record.source === 'play-tester' && good.record.origin === DEV && good.record.head === '0a1b2c3' && good.record.dirty === false);
ok('... and its record passes the bundle verdict pin.mjs reads', appBundleVerdict(good.record, DEV).ok);
ok('... but never authorises an install (it carries no APK sha)', !installVerdict([good.record], 'f'.repeat(64), DEV).ok);
refused({ tag: 'v9.8.7', release: { isPrerelease: false } }, 'a STABLE is a production build and is refused first', /not a pre-release tag/);
refused({ release: { isPrerelease: false } }, 'a hyphenated tag on a release not marked pre-release', /not marked a pre-release/);
refused({ release: null }, 'no release at all');
refused({ site: 'https://prod.example.test' }, 'a rig reporting on another estate', /dev only/);
refused({ job: null }, 'a run with no Android job');
refused({ job: { ...base.job, conclusion: 'failure' } }, 'an Android job that failed', /ended failure/);
refused({ log: LOG.split('\n').filter((l) => !/targets dev \(/.test(l)).join('\n') }, 'a job that never said dev', /never said/);
refused({ log: LOG.split('\n').filter((l) => !/HEAD is now/.test(l)).join('\n') }, 'a job with no checkout of its bump', /no checkout/);
refused({ stamp: { ...base.stamp, commit: 'ffffffff00000000' } }, 'a phone running another commit', /the job built/);
refused({ stamp: { ...base.stamp, builtAt: '2026-10-27T18:00:00.000Z' } }, 'a bundle built before the job', /outside the job/);
refused({ stamp: { ...base.stamp, builtAt: '2026-10-27T19:30:00.000Z' } }, 'a bundle built after the job', /outside the job/);
refused({ installed: { versionName: '1.5.0', versionCode: '1' } }, 'a phone on another versionName (the Play stable)', /versionName 1\.5\.0/);
refused({ installed: { versionName: null, versionCode: null } }, 'a phone with the app absent');
ok('COUNTER: an unknown build stays refused by the bundle verdict', appBundleVerdict(null, DEV).reason === 'unrecorded');

console.log('the spellings, against the workflow');
const wf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/android.yml'), 'utf8');
ok('android.yml prints the line this reads', wf.includes('echo "Android build targets ${URL_ENVIRONMENT} (${APP_URL})"'));
ok('... after refusing a pre-release that is not dev', wf.includes('if [ "$IS_PRERELEASE" = "true" ] && [ "$URL_ENVIRONMENT" != "dev" ]; then'));
ok('the job is the one this reads', /name: Build Android APK/.test(wf));

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
