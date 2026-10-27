#!/usr/bin/env bun
/**
 * RECORDS THE PROVENANCE OF A PLAY TESTER BUILD ON A1, so `pin.mjs` can accept it as a dev build.
 *
 *   bun a1tester.mjs --tag v1.5.1-alpha.1          read, decide, and append the record on acceptance
 *   bun a1tester.mjs --tag v1.5.1-alpha.1 --dry    read and decide, write nothing
 *
 * The facts come from where they live: the installed versionName/versionCode from `dumpsys
 * package`, the running bundle's stamp from the app's own `/_app/version.json` (over CDP), and the
 * release, its run, its Android job and that job's log from GitHub (`gh`). `testerbuild.mjs`
 * decides; a refusal exits 1 and writes nothing. The record lands in `a1-builds.ndjson` beside the
 * rig's own builds (`apkbuild.mjs`), keyed by the same `builtAt`.
 *
 * READ-ONLY ON THE PHONE: no install, no uninstall, no tap. Run it once A1 reports the tester
 * build, before the first row on it.
 */
import { execFileSync } from 'node:child_process';
import { recordTesterBuild } from './apkbuild.mjs';
import { client } from './chat.mjs';
import { PORTS } from './names.mjs';
import { PKG, adb, useDevice } from './phone.mjs';
import { clientBuild } from './results.mjs';
import { SITE } from './site.mjs';
import { ANDROID_JOB, testerBuildVerdict } from './testerbuild.mjs';

const argv = process.argv.slice(2);
const tag = argv[argv.indexOf('--tag') + 1];
const dry = argv.includes('--dry');
if (!argv.includes('--tag') || !tag || tag.startsWith('--')) {
  console.error('usage: bun a1tester.mjs --tag vX.Y.Z-alpha.N [--dry]');
  process.exit(2);
}

/** `gh` as JSON; a throw is a GitHub this machine cannot read, and nothing is recorded. */
const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const ghText = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

useDevice('A1');
const dump = String(adb(['shell', 'dumpsys', 'package', PKG]));
const installed = {
  versionName: /versionName=(\S+)/.exec(dump)?.[1] ?? null,
  versionCode: /versionCode=(\d+)/.exec(dump)?.[1] ?? null,
};
console.log(`[a1tester] A1 has ${PKG} ${installed.versionName ?? '(none)'} (code ${installed.versionCode ?? '(none)'})`);

const cx = await client(PORTS.A1, null, { focus: false });
let stamp;
try {
  stamp = await clientBuild(cx);
} finally {
  cx.close();
}
console.log(`[a1tester] A1's bundle: ${stamp.commit.slice(0, 9)} built ${stamp.builtAt}`);

const release = gh('release', 'view', tag, '--json', 'tagName,isPrerelease');
const runs = gh('run', 'list', '--workflow', 'release.yml', '--limit', '30', '--json', 'databaseId,headBranch,event');
const run = runs.find((r) => r.headBranch === tag && r.event === 'release');
let job = null;
let log = '';
if (run) {
  const jobs = gh('run', 'view', String(run.databaseId), '--json', 'jobs').jobs ?? [];
  const j = jobs.find((x) => ANDROID_JOB.test(x.name));
  if (j) {
    job = { id: j.databaseId, run: run.databaseId, name: j.name, conclusion: j.conclusion, startedAt: j.startedAt, completedAt: j.completedAt };
    log = ghText('run', 'view', '--job', String(j.databaseId), '--log');
  }
}
console.log(`[a1tester] release ${tag}: pre-release=${release.isPrerelease}, run ${run?.databaseId ?? '(none)'}, Android job ${job ? `${job.id} ${job.conclusion}` : '(none)'}`);

const v = testerBuildVerdict({ tag, release, job, log, stamp, installed, site: SITE });
if (!v.ok) {
  console.error(`[a1tester] REFUSED: ${v.reason}`);
  process.exit(1);
}
if (dry) {
  console.log(`[a1tester] ACCEPTED (dry - nothing written): ${JSON.stringify(v.record)}`);
  process.exit(0);
}
recordTesterBuild(v.record);
console.log(`[a1tester] ACCEPTED and recorded: ${tag} on A1 is a dev build (${v.record.head}, built ${v.record.builtAt})`);
