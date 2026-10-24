/**
 * WAS THE ESTATE REDEPLOYED OR RESTARTED WHILE THE CHECK WAS RUNNING? - the one cause of transport
 * failure that is OURS, and the only one a check cannot tell from a defect.
 *
 * **WHICH QUESTION DEPENDS ON THE CONFIGURED ESTATE (R4, 2026-10-24)** - the one `site.mjs`
 * registers ({@link configuredEstate}), never the origin a report happens to carry. Locally it is
 * "did a container of the compose project start inside the window" ({@link estateRestarts}). On DEV
 * it is "did dev's build change, did a pre-release run, did a dev container restart or did a seed
 * reset run inside the window" ({@link devWindowVerdict}), and a dev window that could not be read
 * is VACUOUS. The history below is why the question moved twice before.
 *
 * Prod IS the test server, and every push to `main` redeploys it: containers stop, nginx drops
 * whatever is in flight, and every client on the rig sees `net::ERR_CONNECTION_CLOSED` on the
 * requests it had open. Measured on 2026-08-21: COMM-22's fifth and sixth cycles died inside the CD
 * window of a commit that touched `tools/` and nothing else - the failures read `the salon never
 * appeared in the sidebar` and `the access panel is not open`, two sentences about the product, both
 * caused by the harness's own operator pushing mid-run.
 *
 * A REDEPLOY IS NOT A FAILING ANSWER, IT IS AN ABSENT ONE. The campaign's standing rule is that a
 * status code is an answer and a transport failure is not; a server that restarted under a check
 * never answered at all. So an overlap makes the run VACUOUS - "the instrument could not be held in
 * a state where the question is askable" - and never FAIL. It is recorded with the run ids so the
 * reader can see WHICH deploy, and so nobody has to re-derive the coincidence from timestamps.
 *
 * THE WHOLE RUN WINDOW COUNTS, NOT THE RESTART INSTANT. `gh` reports when a workflow run was created
 * and when it last moved, never the second the containers came down. Taking the whole window is
 * deliberately conservative: over-reporting a redeploy costs a re-run, and under-reporting one files
 * a Work Package against the product for something we did.
 *
 * AND THE SERVED BUNDLE'S STAMP IS NOT THE DISCRIMINATOR IT LOOKS LIKE. The obvious refinement -
 * read `/_app/version.json` before and after, and only call it a redeploy when the build changed -
 * is wrong, and measuring it is what showed why. `cd.yml` has a `detect-changed-services` job, so a
 * push that touches only `tools/` rebuilds no frontend: prod went on serving the bundle built for
 * `29b12fee` across `5a10f9a7`'s entire CD run, dated 03:14:21Z against a run created at 03:22:57Z.
 * That same run is the one whose window swallowed two COMM-22 cycles. An unchanged stamp therefore
 * proves the FRONTEND was not replaced, which is a different question from whether the origin
 * restarted - the containers behind it can come down for a service the bundle knows nothing about.
 * The run window stays the signal.
 *
 * IT CANNOT ALWAYS ANSWER, AND SAYS SO. `gh` may be absent, unauthenticated or rate-limited, and a
 * module that guessed "no deploy" in that case would be a silent blind spot. {@link estateWindow}
 * returns `asked: false` with the reason instead, which the record carries verbatim.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_SITE, estateOf, registeredAttachOrigin } from './estate-target.mjs';

/**
 * The workflow that restarts production - and since 2026-09-03 it is the RELEASE, not a deploy.
 *
 * The unification this file's previous comment anticipated has happened, and it went one step
 * further than expected: `cd.yml` is now `deploy.yml`, a `workflow_call` workflow that produces no
 * run of its own, so `gh run list --workflow deploy.yml` returns nothing at all. The run that
 * restarts an estate is `release.yml`, which carries the deploy and both store chains as jobs.
 *
 * THE RIG MUST THEREFORE READ WHICH ESTATE A RUN WAS FOR, because one workflow now covers both: a
 * `-alpha.N` release deploys dev and a stable deploys production, and only the run's version says
 * which. Until it does, treat every release run as a possible production restart - over-reporting
 * costs a re-run, under-reporting files a Work Package against the product for something we did.
 */
export const DEPLOY_WORKFLOW = 'release.yml';

/** The repository root - `gh` resolves the repo from the working directory, and the rig runs in `tools/`. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A run that has not finished. Both spellings GitHub uses, so a queued deploy counts as in flight. */
const RUNNING = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);

/**
 * The most recent production deploys, newest first.
 *
 * @returns {{ok: true, runs: Array<{id: number, sha: string, status: string, conclusion: string|null,
 *   startedMs: number, endedMs: number, title: string}>} | {ok: false, why: string}}
 */
export function deployRuns(limit = 15) {
  const r = ghJson(['run', 'list', '--workflow', DEPLOY_WORKFLOW, '--limit', String(limit), '--json', RUN_FIELDS]);
  return r.ok ? { ok: true, runs: r.value.map(runOf) } : r;
}

/** The `gh run list` fields every reader here takes, `headBranch` included: on a release run it is the TAG. */
const RUN_FIELDS = 'databaseId,headSha,headBranch,event,status,conclusion,createdAt,updatedAt,displayTitle';

/**
 * One `gh` call parsed as JSON, or the reason it could not be - never a guess.
 *
 * @param {string[]} args
 * @returns {{ok: true, value: any} | {ok: false, why: string}}
 */
function ghJson(args) {
  let raw;
  try {
    raw = execFileSync('gh', args, { cwd: REPO, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, why: `gh ${args.slice(0, 2).join(' ')} failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, why: `gh ${args.slice(0, 2).join(' ')} returned no JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A `gh run list` row in the one shape `describe` and every verdict read. */
const runOf = (r) => ({
  id: r.databaseId,
  sha: String(r.headSha ?? '').slice(0, 8),
  status: r.status,
  conclusion: r.conclusion ?? null,
  startedMs: Date.parse(r.createdAt),
  endedMs: RUNNING.has(r.status) ? Number.POSITIVE_INFINITY : Date.parse(r.updatedAt),
  title: r.displayTitle ?? '',
  tag: r.headBranch ?? '',
});

/**
 * THE SECOND THING THAT REWRITES DEV UNDER A ROW: `dev-reset` in `scheduled.yml` (R4 review).
 *
 * A dispatch-only job that puts dev's database back to the fictional seed - no new build, so the
 * build witness cannot see it, and no container need restart, so the restart witness may not either.
 * A row whose window it crossed measured an estate whose rows were replaced mid-run.
 *
 * `scheduled.yml` carries other jobs a dispatch may pick, so a dispatched run counts only when ITS
 * reset job did not skip - read per run, and only for runs that ended after `sinceMs` (a handful).
 *
 * @param {number} sinceMs the earliest window start
 * @returns {{ok: true, runs: object[]} | {ok: false, why: string}}
 */
export function devResetRuns(sinceMs, limit = 10) {
  const listed = ghJson(['run', 'list', '--workflow', DEV_RESET_WORKFLOW, '--event', 'workflow_dispatch', '--limit', String(limit), '--json', RUN_FIELDS]);
  if (!listed.ok) return listed;
  const runs = [];
  for (const run of listed.value.map(runOf).filter((x) => x.endedMs >= sinceMs)) {
    const view = ghJson(['run', 'view', String(run.id), '--json', 'jobs']);
    if (!view.ok) return view;
    const job = (view.value.jobs ?? []).find((j) => j.name === DEV_RESET_JOB);
    // A run whose jobs are not listed yet is still being scheduled: it may be a reset, so it counts.
    if (!job || job.conclusion !== 'skipped') runs.push({ ...run, title: `${DEV_RESET_JOB} (${run.title})` });
  }
  return { ok: true, runs };
}

/**
 * The workflow and the job name of dev's seed reset - the job's `name:` in `scheduled.yml`, which
 * names dev's host; built from `DEV_SITE` so the rig spells that host in one place.
 */
export const DEV_RESET_WORKFLOW = 'scheduled.yml';
export const DEV_RESET_JOB = `Reset ${new URL(DEV_SITE).hostname} to the fictional seed`;

/** The deploys that have not finished. `[]` means production is quiet; `null` means nobody could say. */
export function inFlight() {
  const r = deployRuns();
  if (!r.ok) return null;
  return r.runs.filter((x) => RUNNING.has(x.status));
}

/**
 * The COMPOSE PROJECT that serves the rig, named once. The Makefile owns this name
 * (`LOCAL_PROJECT ?= canari-local`) and says why it must be spelt out: without it `docker compose`
 * derives a project name from the compose file's DIRECTORY, and there is another project called
 * `local` on at least one workstation.
 */
const LOCAL_PROJECT = process.env.LOCAL_PROJECT || 'canari-local';

/**
 * Which containers of the local estate started AFTER `sinceMs` - the restart a running check cannot
 * tell from a defect.
 *
 * WHY THIS REPLACED A GITHUB QUESTION, WHICH IS THE WHOLE POINT. This guard was written when prod
 * WAS the test server and every push to `main` redeployed it, so "did a workflow run overlap this
 * check" and "did the estate under test restart" were the same question. **They stopped being the
 * same on 2026-09-03**, when the rig moved to `http://localhost:8081`: no GitHub run can reach a
 * container on this workstation, and this module's own docstring had already predicted the cost -
 * *"the rig must therefore read which estate a run was for"*.
 *
 * It was paid on 2026-09-05. PIN-11 measured all three of its gestures, all three failed, and the
 * gate turned the run VACUOUS because a `v0.16.4-alpha.1` release was in flight - a release that
 * deploys `dev.canari-emse.fr` and could not have touched the estate the row was measuring. **A
 * predicate that named the last incident is not the predicate that names the next one**, and a
 * guard that voids good measurements is worse than no guard: it is a FAIL that never gets read.
 *
 * WHAT CAN ACTUALLY BREAK A LOCAL RUN IS A RESTART, and it needs no pipeline at all - a
 * `make run-services`, a `docker compose up --build` of one service, a container that died. Each
 * drops what nginx had in flight and every client reports `ERR_CONNECTION_CLOSED` on whatever it was
 * doing, which is a transport failure and therefore not an answer. `State.StartedAt` is written by
 * the thing whose liveness it measures, which is the property the campaign's rules ask of a clock.
 *
 * IT CANNOT ALWAYS ANSWER, AND SAYS SO - `docker` may be absent or the daemon down, and a guard
 * that read that as "nothing restarted" would be a silent blind spot exactly when the estate is
 * already misbehaving. The reason is returned and the record carries it verbatim.
 *
 * **If the rig is ever pointed back at a deployed estate, this is the wrong question again** and
 * the run-window read below is the right one. The estate the rig targets is what decides, and it is
 * not knowable here: `names.mjs` holds it and is out of git, so a module the gated self-tests
 * import may not reach it (see `estate-origins.mjs` for the same constraint and the same answer).
 *
 * @returns {{asked: true, restarted: {id: string, sha: string, status: string, title: string}[]} | {asked: false, why: string}}
 */
export function estateRestarts(sinceMs) {
  let out;
  try {
    const ids = execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${LOCAL_PROJECT}`], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (ids.length === 0) return { asked: false, why: `no running container in the compose project "${LOCAL_PROJECT}"` };
    out = execFileSync('docker', ['inspect', '--format', '{{.Name}} {{.State.StartedAt}}', ...ids], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { asked: false, why: `docker could not be asked: ${String(e?.message ?? e).split('\n')[0]}` };
  }
  return { asked: true, restarted: restartsIn(out, sinceMs, 'local') };
}

/**
 * The containers of `<name> <StartedAt>` lines that started at or after `sinceMs`, shaped like a
 * deploy so `describe` and every reader of `redeployedMidRun` keep one vocabulary.
 *
 * @param {string} out `docker inspect --format '{{.Name}} {{.State.StartedAt}}'` output
 * @param {number} sinceMs
 * @param {'local' | 'dev'} estate
 */
export function restartsIn(out, sinceMs, estate) {
  const restarted = [];
  for (const line of out.split('\n')) {
    const m = /^\/?(\S+)\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const startedMs = Date.parse(m[2]);
    if (!Number.isFinite(startedMs) || startedMs < sinceMs) continue;
    restarted.push({ id: m[1], sha: estate, status: 'restarted', conclusion: '', title: new Date(startedMs).toISOString() });
  }
  return restarted;
}

/**
 * Which of DEV's containers started after `sinceMs` - the fourth witness of a dev window (R4 review).
 *
 * A container restarted by hand, by the host or by a `docker compose up` of one service drops what
 * nginx had in flight without changing the build or running any workflow. `State.StartedAt` is
 * written by the thing whose liveness it measures. The read goes over the rig's one ssh route to
 * dev (`devContainerStarts` in `estate.mjs`), which needs the machine-local host alias - so it runs
 * in a CHILD of this runtime, and this module stays importable on a fresh checkout.
 *
 * @returns {{asked: true, restarted: object[]} | {asked: false, why: string}}
 */
export function devRestartsSync(sinceMs, { timeoutMs = 60_000 } = {}) {
  const estateUrl = new URL('./estate.mjs', import.meta.url).href;
  // The answer is the LAST line: an import may print its own lines first.
  const script = `import(${JSON.stringify(estateUrl)}).then((m) => process.stdout.write('\\n' + JSON.stringify({ out: m.devContainerStarts() })))`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: timeoutMs });
  let out;
  try {
    ({ out } = JSON.parse(String(r.stdout).trim().split('\n').pop()));
  } catch {
    return { asked: false, why: `dev's containers could not be asked (status ${r.status}): ${String(r.stderr ?? '').trim().split('\n').pop()}` };
  }
  if (!String(out).trim()) return { asked: false, why: `no running container in dev's compose project` };
  return { asked: true, restarted: restartsIn(out, sinceMs, 'dev') };
}

/**
 * WHICH BUILD A DEPLOYED ESTATE IS SERVING, from its own `/api/version` (`{version, build, ...}`).
 *
 * THE DEV ESTATE IS REDEPLOYED BY EVERY PRE-RELEASE (R4 of the 1.4.1 campaign, 2026-10-24): a
 * `gh release create vX.Y.Z-alpha.N` restarts dev under whatever row is running, exactly as a push
 * to `main` once restarted production under COMM-22. The local docker read above cannot see dev at
 * all, so on dev the run asks dev itself: the build at the start of the window and at its end.
 *
 * Public HTTPS and no machine-local name, so this module stays importable on a fresh checkout.
 *
 * @param {string} origin the estate's origin, e.g. `https://dev.canari-emse.fr`
 * @returns {Promise<{origin: string, atMs: number, build: string, version: string} | {origin: string, atMs: number, error: string}>}
 */
export async function readEstateBuild(origin, { timeoutMs = 15_000 } = {}) {
  const atMs = Date.now();
  try {
    const res = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!res.ok) return { origin, atMs, error: `/api/version answered ${res.status}` };
    const body = await res.json();
    if (typeof body?.build !== 'string' || !body.build) return { origin, atMs, error: '/api/version carries no build' };
    return { origin, atMs, build: body.build, version: String(body.version ?? '') };
  } catch (e) {
    return { origin, atMs, error: `/api/version unreadable: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}

/**
 * {@link readEstateBuild}, synchronously - `gate()` is synchronous and is the one place every row
 * passes through. A child of THIS runtime (`process.execPath`, never a named one) does the fetch.
 */
export function readEstateBuildSync(origin, { timeoutMs = 20_000 } = {}) {
  const script =
    `import(${JSON.stringify(import.meta.url)}).then((m) => m.readEstateBuild(${JSON.stringify(origin)}))` +
    `.then((r) => process.stdout.write(JSON.stringify(r)))`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: timeoutMs });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { origin, atMs: Date.now(), error: `the build reader did not answer (status ${r.status}): ${String(r.stderr ?? '').split('\n')[0]}` };
  }
}

/**
 * A STABLE tag deploys production and nothing else; every other release run may deploy dev. A
 * hyphen IS a pre-release (`release_kind()`), and a run whose tag is not a version at all (a
 * dispatch from a branch) is counted too - over-reporting costs a re-run.
 *
 * READ FROM THE TAG (`headBranch` of a release run), NEVER FROM THE TITLE (R4 review): a title is
 * the release's NAME, which a human may type as anything, and the tag is what `release_kind()` reads.
 */
const STABLE_TAG = /^v?\d+\.\d+\.\d+$/;

/** Whether a `release.yml` run can have redeployed dev - exported for the self-test. */
export const mayDeployDev = (run) => !STABLE_TAG.test(String(run.tag ?? '').trim());

/**
 * Was the DEV estate redeployed under the window `[sinceMs, end.atMs]`? Pure - every input is read
 * elsewhere, so `archive/deploy-selftest.mjs` pins each answer.
 *
 * FIVE WITNESSES, because each misses a case the others see:
 * - the build every client's window STARTED on against the build at the END: a new pre-release
 *   changes it, and that is the case the plan names;
 * - two windows that started on DIFFERENT builds: the deploy landed between two `watch()` calls;
 * - a `release.yml` run whose TAG is not a stable version, intersecting the window: a rerun of the
 *   SAME tag redeploys dev without changing its build. A STABLE deploys production, which no row on
 *   dev reads, so it is not counted ({@link mayDeployDev});
 * - a dev container that STARTED inside the window ({@link devRestartsSync}): a restart by hand or
 *   by the host changes no build and runs no workflow;
 * - a `dev-reset` of `scheduled.yml` intersecting the window ({@link devResetRuns}): the seed is
 *   restored with no new build and possibly no restart.
 *
 * WHAT IT CANNOT ANSWER IT SAYS, and never guesses "quiet": an unreadable start or end build, an
 * unreadable `gh` or unreadable containers return `asked: false` with every reason - and on dev
 * `gate()` makes that VACUOUS, never PASS.
 *
 * @param {object} p
 * @param {Array<{build?: string, error?: string, atMs: number}>} p.starts each client window's start read
 * @param {{build?: string, error?: string, atMs: number}} p.end the read at gate time
 * @param {{ok: true, runs: object[]} | {ok: false, why: string}} p.runs `deployRuns()`
 * @param {{asked: true, restarted: object[]} | {asked: false, why: string}} p.restarts `devRestartsSync()`
 * @param {{ok: true, runs: object[]} | {ok: false, why: string}} p.resets `devResetRuns()`
 * @param {number} p.sinceMs the earliest window start
 * @returns {{asked: true, overlapped: object[], builds: {start: string[], end: string}} | {asked: false, why: string}}
 */
export function devWindowVerdict({ starts, end, runs, restarts, resets, sinceMs }) {
  const blind = [];
  const startBuilds = [...new Set(starts.filter((s) => s.build).map((s) => s.build))];
  for (const s of starts) if (!s.build) blind.push(`a window's start build: ${s.error ?? 'absent'}`);
  if (!starts.length) blind.push('no window recorded the build it started on');
  if (!end?.build) blind.push(`the end build: ${end?.error ?? 'absent'}`);
  const overlapped = [];
  if (startBuilds.length > 1) {
    overlapped.push({ id: 'dev', sha: startBuilds.join('->'), status: 'redeployed', conclusion: '', title: 'the windows of this run started on different builds' });
  }
  if (end?.build && startBuilds.some((b) => b !== end.build)) {
    overlapped.push({ id: 'dev', sha: `${startBuilds.join('|')}->${end.build}`, status: 'redeployed', conclusion: '', title: 'the build changed between the start and the end of the run' });
  }
  const until = end?.atMs ?? Date.now();
  const crosses = (run) => run.startedMs <= until && run.endedMs >= sinceMs;
  if (!runs.ok) blind.push(`release runs: ${runs.why}`);
  else for (const run of runs.runs) if (mayDeployDev(run) && crosses(run)) overlapped.push(run);
  if (!restarts?.asked) blind.push(`dev's containers: ${restarts?.why ?? 'not asked'}`);
  else overlapped.push(...restarts.restarted);
  if (!resets?.ok) blind.push(`dev resets: ${resets?.why ?? 'not asked'}`);
  else for (const run of resets.runs) if (crosses(run)) overlapped.push(run);
  // AN OVERLAP IS AN ANSWER EVEN WITH A BLIND WITNESS BESIDE IT: one witness proving a redeploy
  // settles it. Only "nothing seen" needs every witness to have been readable.
  if (overlapped.length) return { asked: true, overlapped, builds: { start: startBuilds, end: end?.build ?? null } };
  if (blind.length) return { asked: false, why: blind.join('; ') };
  return { asked: true, overlapped: [], builds: { start: startBuilds, end: end.build } };
}

/**
 * The estate this process is configured for, from the origin `site.mjs` registered (the only door to
 * `SITE`), or null when `site.mjs` was never evaluated here. Every row reaches it before `gate()`:
 * attaching a client goes through `listTargets`, which loads `site.mjs`.
 *
 * @returns {{estate: 'local' | 'dev', origin: string} | null}
 */
export function configuredEstate() {
  const origin = registeredAttachOrigin();
  return origin ? { estate: estateOf(origin), origin } : null;
}

/**
 * The window question for the CONFIGURED estate - the one `gate()` asks.
 *
 * THE ESTATE IS THE CONFIGURATION'S, NEVER A REPORT'S (R4 review). The first version picked dev when
 * a report carried a start build and local otherwise - so a dev run whose `watch()` could not record
 * one (a native client, whose page origin is a Tauri scheme) silently asked LOCAL docker and passed
 * on a question about the wrong machine. Now: on dev every window must have recorded its start, a
 * missing one is a blind witness, and local is never consulted.
 *
 * Every answer carries `estate`, so `gate()` can make a blind dev window VACUOUS.
 *
 * @param {object[]} reports the gated reports
 * @param {number} sinceMs the earliest window start
 * @param {{estate?: 'local' | 'dev' | null, readBuild?: (origin: string) => object, readRuns?: () => object,
 *   restarts?: (since: number) => object, devRestarts?: (since: number) => object, readResets?: (since: number) => object}} [io]
 *   injectable readers and estate, for the self-test
 */
export function estateWindow(reports, sinceMs, io = {}) {
  const {
    estate = configuredEstate()?.estate ?? null,
    readBuild = readEstateBuildSync,
    readRuns = deployRuns,
    restarts = estateRestarts,
    devRestarts = devRestartsSync,
    readResets = devResetRuns,
  } = io;
  if (estate === 'local') {
    const r = restarts(sinceMs);
    return r.asked ? { estate, asked: true, overlapped: r.restarted } : { estate, ...r };
  }
  if (estate !== 'dev') return { estate, asked: false, why: 'no estate is registered in this process (site.mjs was never evaluated)' };
  const starts = reports.map((r) =>
    !r?.estateBuild
      ? { atMs: r?.since ?? sinceMs, error: 'this window recorded no start build' }
      : r.estateBuild.origin === DEV_SITE
        ? r.estateBuild
        : { atMs: r.estateBuild.atMs, error: `this window read ${r.estateBuild.origin}, not ${DEV_SITE}` }
  );
  const verdict = devWindowVerdict({
    starts,
    end: readBuild(DEV_SITE),
    runs: readRuns(),
    restarts: devRestarts(sinceMs),
    resets: readResets(sinceMs),
    sinceMs,
  });
  return { estate, ...verdict };
}

/** One deploy, in the one form the record and the console both print. */
export const describe = (d) => `${d.id} ${d.sha} ${d.status}${d.conclusion ? `/${d.conclusion}` : ''} "${d.title}"`;

/**
 * Blocks until no production deploy is in flight, and reports what it waited for.
 *
 * A CHECK STARTED DURING A DEPLOY IS BORN VACUOUS, so the cheapest place to spend the wait is before
 * the first gesture. It waits rather than refusing because the campaign is a ladder run unattended:
 * a phase that aborted because a deploy was two minutes from finishing would cost the whole run.
 *
 * @returns {{waitedMs: number, waitedFor: string[]} | {unknown: string}}
 */
export async function awaitQuiet({ timeoutMs = 900_000, pollMs = 15_000, log = () => {} } = {}) {
  const t0 = Date.now();
  const waitedFor = new Set();
  for (;;) {
    // ONE READ PER PASS. Asking twice - once for the list and once for the reason it failed - can
    // get two different answers a second apart, and then the line printed does not describe the
    // decision taken.
    const seen = deployRuns();
    if (!seen.ok) return { unknown: seen.why };
    const running = seen.runs.filter((x) => RUNNING.has(x.status));
    if (running.length === 0) return { waitedMs: Date.now() - t0, waitedFor: [...waitedFor] };
    for (const d of running) {
      if (!waitedFor.has(describe(d))) log(`  wait production deploy in flight: ${describe(d)}`);
      waitedFor.add(describe(d));
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `a production deploy has been in flight for ${Math.round((Date.now() - t0) / 1000)} s: ` +
          running.map(describe).join('; ')
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
