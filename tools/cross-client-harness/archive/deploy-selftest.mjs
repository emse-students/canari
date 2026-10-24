/**
 * A ROW DEV WAS REDEPLOYED UNDER IS ABSENT, NOT FAILING - AND THE GATE ASKS DEV, NOT DOCKER.
 *
 * R4 of the 1.4.1 campaign (2026-10-24). The rig's only redeploy question was "did a container of
 * the LOCAL compose project restart in the window", which cannot see dev at all: a
 * `gh release create vX.Y.Z-alpha.N` redeploys dev under whatever row is running, and the row would
 * record the restart's dropped requests as sentences about the product. Now, when the CONFIGURED
 * estate is dev, every window records the build it opened on (`watch()`), and `gate()` compares it
 * with the build at the end, the pre-release runs (read by TAG), dev's container start times and the
 * `dev-reset` job (`estateWindow` / `devWindowVerdict` in `deploy.mjs`). A window nobody could read
 * on dev is VACUOUS, never PASS.
 *
 * Every reader is injected: a self-test in the CI gate touches no network, no `gh` and no ssh.
 *
 *   bun archive/deploy-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { DEV_RESET_JOB, DEV_RESET_WORKFLOW, devWindowVerdict, estateWindow, mayDeployDev, restartsIn } from '../deploy.mjs';
import { gate } from '../watch.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const DEV = 'https://dev.canari-emse.fr';
const T0 = Date.parse('2026-10-24T10:00:00Z');
const MIN = 60_000;
const at = (build, atMs = T0) => ({ origin: DEV, atMs, build, version: '1.4.1-alpha.2' });
/** A `release.yml` run; `tag` is its `headBranch`, and the title is deliberately NOT the tag. */
const run = (tag, startMin, endMin) => ({
  id: 1,
  sha: 'abcdef12',
  status: endMin === null ? 'in_progress' : 'completed',
  conclusion: endMin === null ? null : 'success',
  startedMs: T0 + startMin * MIN,
  endedMs: endMin === null ? Number.POSITIVE_INFINITY : T0 + endMin * MIN,
  title: 'Release',
  tag,
});
const NO_RUNS = { ok: true, runs: [] };
const QUIET = { restarts: { asked: true, restarted: [] }, resets: NO_RUNS };
const verdict = (p) => devWindowVerdict({ runs: NO_RUNS, ...QUIET, sinceMs: T0, ...p });

// ── the pure verdict ────────────────────────────────────────────────────────────────────────────
{
  const v = verdict({ starts: [at('dev.aaa'), at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN) });
  ok('same build at start and end, nothing ran, nothing restarted: asked, nothing overlapped', v.asked && v.overlapped.length === 0);
  ok('and the builds are carried for the record', v.builds.start.join() === 'dev.aaa' && v.builds.end === 'dev.aaa');
}
{
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.bbb', T0 + 10 * MIN) });
  ok('the build changed between start and end: a redeploy', v.asked && v.overlapped.length === 1 && /dev\.aaa->dev\.bbb/.test(v.overlapped[0].sha));
}
{
  const v = verdict({ starts: [at('dev.aaa'), at('dev.bbb')], end: at('dev.bbb', T0 + 10 * MIN) });
  ok('two windows that opened on different builds: the deploy landed between them', v.asked && v.overlapped.some((o) => /different builds/.test(o.title)));
}
{
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs: { ok: true, runs: [run('v1.4.1-alpha.2', 2, 8)] } });
  ok('a PRE-RELEASE run inside the window counts even with the build unchanged (a rerun of the same tag)', v.asked && v.overlapped.length === 1);
}
ok(
  'a pre-release still in flight at the end counts',
  verdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs: { ok: true, runs: [run('v1.4.1-alpha.2', 2, null)] } }).overlapped.length === 1
);
{
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs: { ok: true, runs: [run('v1.4.1', 2, 8)] } });
  ok('a STABLE tag deploys production, which no dev row reads: not counted', v.asked && v.overlapped.length === 0);
}
ok(
  'a run on no version tag is counted (over-reporting costs a re-run)',
  verdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs: { ok: true, runs: [run('main', 2, 8)] } }).overlapped.length === 1
);
ok(
  'pre-release runs wholly before or after the window are not counted',
  verdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs: { ok: true, runs: [run('v1.4.1-alpha.1', -60, -5), run('v1.4.1-alpha.3', 15, 20)] } })
    .overlapped.length === 0
);
ok('the TAG decides, never the title: a stable tag titled like a pre-release', !mayDeployDev({ tag: 'v1.4.1', title: 'v1.4.1-alpha.2' }));
ok('and a pre-release tag titled like a stable', mayDeployDev({ tag: 'v1.4.1-alpha.2', title: 'v1.4.1' }));
ok('a run with no tag at all is counted', mayDeployDev({ title: 'v1.4.1' }));
{
  const v = verdict({ starts: [at('dev.aaa')], end: { origin: DEV, atMs: T0, error: 'timeout' } });
  ok('an unreadable END build is a blind spot, never "quiet"', !v.asked && /end build: timeout/.test(v.why));
}
{
  const v = verdict({ starts: [{ origin: DEV, atMs: T0, error: '502' }], end: at('dev.aaa') });
  ok('an unreadable START build is a blind spot', !v.asked && /start build: 502/.test(v.why));
}
{
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.aaa'), runs: { ok: false, why: 'gh logged out' } });
  ok('an unreadable gh is a blind spot when nothing else proved a redeploy', !v.asked && /gh logged out/.test(v.why));
}
{
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.bbb'), runs: { ok: false, why: 'gh logged out' } });
  ok('but a changed build is an ANSWER even with gh blind', v.asked && v.overlapped.length === 1);
}

// ── the fourth and fifth witnesses: dev's containers, dev's seed reset ──────────────────────────
{
  const starts = `/canari-dev-nginx-1 2026-10-24T10:03:00.123456789Z\n/canari-dev-postgres-1 2026-10-20T08:00:00Z\n`;
  const restarted = restartsIn(starts, T0, 'dev');
  ok('restartsIn keeps the containers started inside the window only', restarted.length === 1 && restarted[0].id === 'canari-dev-nginx-1' && restarted[0].sha === 'dev');
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), restarts: { asked: true, restarted } });
  ok('a dev container that started inside the window is a redeploy, build unchanged and no run', v.asked && v.overlapped.length === 1);
}
{
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.aaa'), restarts: { asked: false, why: 'ssh 255' } });
  ok("dev's containers unreadable: a blind spot", !v.asked && /containers: ssh 255/.test(v.why));
}
{
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), resets: { ok: true, runs: [run('main', 2, 3)] } });
  ok('a dev-reset inside the window counts, though nothing was built', v.asked && v.overlapped.length === 1);
}
{
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), resets: { ok: true, runs: [run('main', -30, -20)] } });
  ok('a dev-reset that ended before the window is not counted', v.asked && v.overlapped.length === 0);
}
{
  const v = verdict({ starts: [at('dev.aaa')], end: at('dev.aaa'), resets: { ok: false, why: 'gh rate-limited' } });
  ok('dev resets unreadable: a blind spot', !v.asked && /resets: gh rate-limited/.test(v.why));
}

{
  // The reset witness matches its job BY NAME, so a renamed job would make it silently blind.
  const wf = readFileSync(new URL(`../../../.github/workflows/${DEV_RESET_WORKFLOW}`, import.meta.url), 'utf8');
  ok(`the dev-reset job is still named "${DEV_RESET_JOB}" in ${DEV_RESET_WORKFLOW}`, new RegExp(`^\\s*name: ${DEV_RESET_JOB.replace(/\./g, '\\.')}\\s*$`, 'm').test(wf));
}

// ── which estate is asked: the CONFIGURED one, never a report's ─────────────────────────────────
const NEVER = (what) => () => {
  throw new Error(`${what} must not be asked`);
};
const devIo = (endBuild) => ({
  estate: 'dev',
  readBuild: (o) => (o === DEV ? at(endBuild, T0 + MIN) : NEVER('a non-dev build')()),
  readRuns: () => NO_RUNS,
  devRestarts: () => QUIET.restarts,
  readResets: () => NO_RUNS,
  restarts: NEVER('local docker'),
});
{
  let asked = null;
  const w = estateWindow([{ since: T0 }], T0, {
    estate: 'local',
    restarts: (s) => ((asked = s), { asked: true, restarted: [] }),
    readBuild: NEVER('dev'),
    readRuns: NEVER('gh'),
    devRestarts: NEVER('ssh'),
    readResets: NEVER('gh'),
  });
  ok('configured LOCAL: the local restart question, and nothing of dev', asked === T0 && w.asked && w.overlapped.length === 0 && w.estate === 'local');
}
{
  const w = estateWindow([{ since: T0, estateBuild: at('dev.aaa') }], T0, devIo('dev.bbb'));
  ok('configured DEV: dev is asked at its own origin, local docker never', w.asked && w.overlapped.length === 1 && w.estate === 'dev');
}
{
  const w = estateWindow([{ since: T0 }], T0, devIo('dev.aaa'));
  ok('configured DEV and a window that recorded NO start build: blind, NEVER the local fallback', !w.asked && /recorded no start build/.test(w.why));
}
{
  const w = estateWindow([{ since: T0, estateBuild: { ...at('dev.aaa'), origin: 'http://localhost:8081' } }], T0, devIo('dev.aaa'));
  ok('configured DEV and a window that read another origin: blind', !w.asked && /localhost:8081/.test(w.why));
}
{
  const w = estateWindow([{ since: T0 }], T0, { estate: null });
  ok('no estate registered: blind, and nothing is asked', !w.asked && w.estate === null && /no estate/.test(w.why));
}

// ── through gate(): the verdict ─────────────────────────────────────────────────────────────────
const CLEAN = (build) => ({ clean: true, since: T0, estateBuild: at(build) });
{
  const g = gate('PASS', { W1: CLEAN('dev.aaa'), W2: CLEAN('dev.aaa') }, { estateIo: devIo('dev.bbb') });
  ok('a PASS on dev that saw the build change is VACUOUS', g.verdict === 'VACUOUS' && g.detail.redeployedMidRun?.length === 1);
}
ok('a FAIL on dev that saw the build change is VACUOUS too', gate('FAIL', { W1: CLEAN('dev.aaa') }, { estateIo: devIo('dev.bbb') }).verdict === 'VACUOUS');
{
  const g = gate('PASS', { W1: CLEAN('dev.aaa') }, { estateIo: devIo('dev.aaa') });
  ok('a PASS on an unchanged dev stays PASS, and records the build it ran on', g.verdict === 'PASS' && g.detail.estateBuild?.end === 'dev.aaa');
}
{
  const g = gate('PASS', { W1: CLEAN('dev.aaa') }, { estateIo: { ...devIo('dev.aaa'), readBuild: () => ({ origin: DEV, atMs: T0, error: 'refused' }) } });
  ok('a blind end read on DEV is VACUOUS, never PASS, and says why', g.verdict === 'VACUOUS' && /refused/.test(g.detail.deployWindow));
}
{
  const g = gate('PASS', { W1: { clean: true, since: T0 } }, { estateIo: devIo('dev.aaa') });
  ok('a native window on dev that recorded no start build is VACUOUS', g.verdict === 'VACUOUS' && /no start build/.test(g.detail.deployWindow));
}
{
  const g = gate('PASS', { W1: { clean: true, since: T0 } }, { estateIo: { estate: 'local', restarts: () => ({ asked: false, why: 'docker down' }) } });
  ok('a blind LOCAL window keeps its verdict and says why, as before', g.verdict === 'PASS' && /docker down/.test(g.detail.deployWindow));
}

console.log(failures ? `[deploy] ${failures} FAILURE(S)` : '[deploy] clean - the configured estate decides, and a blind dev window is VACUOUS');
process.exit(failures ? 1 : 0);
