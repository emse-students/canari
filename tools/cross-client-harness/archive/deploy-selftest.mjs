/**
 * A ROW DEV WAS REDEPLOYED UNDER IS ABSENT, NOT FAILING - AND THE GATE ASKS DEV, NOT DOCKER.
 *
 * R4 of the 1.4.1 campaign (2026-10-24). The rig's only redeploy question was "did a container of
 * the LOCAL compose project restart in the window", which cannot see dev at all: a
 * `gh release create vX.Y.Z-alpha.N` redeploys dev under whatever row is running, and the row would
 * record the restart's dropped requests as sentences about the product. Now a client standing on dev
 * records the build its window opened on (`watch()`), and `gate()` compares it with the build at the
 * end and with the pre-release runs in between (`estateWindow` / `devWindowVerdict` in `deploy.mjs`).
 *
 * Every reader is injected: a self-test in the CI gate touches no network and no `gh`.
 *
 *   bun archive/deploy-selftest.mjs
 */
import { devWindowVerdict, estateWindow } from '../deploy.mjs';
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
const run = (title, startMin, endMin) => ({
  id: 1,
  sha: 'abcdef12',
  status: endMin === null ? 'in_progress' : 'completed',
  conclusion: endMin === null ? null : 'success',
  startedMs: T0 + startMin * MIN,
  endedMs: endMin === null ? Number.POSITIVE_INFINITY : T0 + endMin * MIN,
  title,
});
const NO_RUNS = { ok: true, runs: [] };

// ── the pure verdict ────────────────────────────────────────────────────────────────────────────
{
  const v = devWindowVerdict({ starts: [at('dev.aaa'), at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs: NO_RUNS, sinceMs: T0 });
  ok('same build at start and end, no release run: asked, nothing overlapped', v.asked && v.overlapped.length === 0);
  ok('and the builds are carried for the record', v.builds.start.join() === 'dev.aaa' && v.builds.end === 'dev.aaa');
}
{
  const v = devWindowVerdict({ starts: [at('dev.aaa')], end: at('dev.bbb', T0 + 10 * MIN), runs: NO_RUNS, sinceMs: T0 });
  ok('the build changed between start and end: a redeploy', v.asked && v.overlapped.length === 1 && /dev\.aaa->dev\.bbb/.test(v.overlapped[0].sha));
}
{
  const v = devWindowVerdict({ starts: [at('dev.aaa'), at('dev.bbb')], end: at('dev.bbb', T0 + 10 * MIN), runs: NO_RUNS, sinceMs: T0 });
  ok('two windows that opened on different builds: the deploy landed between them', v.asked && v.overlapped.some((o) => /different builds/.test(o.title)));
}
{
  const runs = { ok: true, runs: [run('v1.4.1-alpha.2', 2, 8)] };
  const v = devWindowVerdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs, sinceMs: T0 });
  ok('a PRE-RELEASE run inside the window counts even with the build unchanged (a rerun of the same tag)', v.asked && v.overlapped.length === 1);
}
{
  const runs = { ok: true, runs: [run('v1.4.1-alpha.2', 2, null)] };
  const v = devWindowVerdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs, sinceMs: T0 });
  ok('a pre-release still in flight at the end counts', v.overlapped.length === 1);
}
{
  const runs = { ok: true, runs: [run('v1.4.1', 2, 8)] };
  const v = devWindowVerdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs, sinceMs: T0 });
  ok('a STABLE deploys production, which no dev row reads: not counted', v.asked && v.overlapped.length === 0);
}
{
  const runs = { ok: true, runs: [run('Release', 2, 8)] };
  ok('a run whose title names no version is counted (over-reporting costs a re-run)', devWindowVerdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs, sinceMs: T0 }).overlapped.length === 1);
}
{
  const runs = { ok: true, runs: [run('v1.4.1-alpha.1', -60, -5), run('v1.4.1-alpha.3', 15, 20)] };
  ok('pre-release runs wholly before or after the window are not counted', devWindowVerdict({ starts: [at('dev.aaa')], end: at('dev.aaa', T0 + 10 * MIN), runs, sinceMs: T0 }).overlapped.length === 0);
}
{
  const v = devWindowVerdict({ starts: [at('dev.aaa')], end: { origin: DEV, atMs: T0, error: 'timeout' }, runs: NO_RUNS, sinceMs: T0 });
  ok('an unreadable END build is a blind spot, never "quiet"', !v.asked && /end build: timeout/.test(v.why));
}
{
  const v = devWindowVerdict({ starts: [{ origin: DEV, atMs: T0, error: '502' }], end: at('dev.aaa'), runs: NO_RUNS, sinceMs: T0 });
  ok('an unreadable START build is a blind spot', !v.asked && /start build: 502/.test(v.why));
}
{
  const v = devWindowVerdict({ starts: [at('dev.aaa')], end: at('dev.aaa'), runs: { ok: false, why: 'gh logged out' }, sinceMs: T0 });
  ok('an unreadable gh is a blind spot when nothing else proved a redeploy', !v.asked && /gh logged out/.test(v.why));
}
{
  const v = devWindowVerdict({ starts: [at('dev.aaa')], end: at('dev.bbb'), runs: { ok: false, why: 'gh logged out' }, sinceMs: T0 });
  ok('but a changed build is an ANSWER even with gh blind', v.asked && v.overlapped.length === 1);
}

// ── which estate is asked ───────────────────────────────────────────────────────────────────────
{
  let asked = null;
  const w = estateWindow([{ since: T0 }], T0, {
    restarts: (s) => ((asked = s), { asked: true, restarted: [] }),
    readBuild: () => {
      throw new Error('dev must not be read for a local window');
    },
    readRuns: () => NO_RUNS,
  });
  ok('no report carries an estate build: the LOCAL restart question, as before', asked === T0 && w.asked && w.overlapped.length === 0);
}
{
  let restartsAsked = false;
  const w = estateWindow([{ since: T0, estateBuild: at('dev.aaa') }], T0, {
    restarts: () => ((restartsAsked = true), { asked: true, restarted: [] }),
    readBuild: (o) => at(o === DEV ? 'dev.bbb' : 'x', T0 + MIN),
    readRuns: () => NO_RUNS,
  });
  ok('a report on dev: dev is asked, at the origin the window recorded', w.asked && w.overlapped.length === 1 && !restartsAsked);
}
{
  const w = estateWindow([{ estateBuild: at('dev.aaa') }, { estateBuild: { ...at('dev.aaa'), origin: 'http://localhost:8081' } }], T0, {
    readBuild: () => at('dev.aaa'),
    readRuns: () => NO_RUNS,
  });
  ok('windows naming two estates are a blind spot, not a guess', !w.asked && /2 estates/.test(w.why));
}

// ── through gate(): the verdict ─────────────────────────────────────────────────────────────────
const CLEAN = (build) => ({ clean: true, since: T0, estateBuild: at(build) });
const io = (endBuild, runs = NO_RUNS) => ({ readBuild: () => at(endBuild, T0 + 5 * MIN), readRuns: () => runs, restarts: () => ({ asked: true, restarted: [] }) });
{
  const g = gate('PASS', { W1: CLEAN('dev.aaa'), W2: CLEAN('dev.aaa') }, { estateIo: io('dev.bbb') });
  ok('a PASS on dev that saw the build change is VACUOUS', g.verdict === 'VACUOUS' && g.detail.redeployedMidRun?.length === 1);
}
ok('a FAIL on dev that saw the build change is VACUOUS too', gate('FAIL', { W1: CLEAN('dev.aaa') }, { estateIo: io('dev.bbb') }).verdict === 'VACUOUS');
{
  const g = gate('PASS', { W1: CLEAN('dev.aaa') }, { estateIo: io('dev.aaa') });
  ok('a PASS on an unchanged dev stays PASS, and records the build it ran on', g.verdict === 'PASS' && g.detail.estateBuild?.end === 'dev.aaa');
}
{
  const g = gate('PASS', { W1: CLEAN('dev.aaa') }, { estateIo: { ...io('dev.aaa'), readBuild: () => ({ origin: DEV, atMs: T0, error: 'refused' }) } });
  ok('a blind end read keeps the verdict and says why', g.verdict === 'PASS' && /refused/.test(g.detail.deployWindow));
}

console.log(failures ? `[deploy] ${failures} FAILURE(S)` : '[deploy] clean - dev asked about its own build, local about its restarts');
process.exit(failures ? 1 : 0);
