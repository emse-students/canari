/**
 * WAS THE ESTATE REDEPLOYED OR RESTARTED WHILE THE CHECK WAS RUNNING? - the one cause of transport
 * failure that is OURS, and the only one a check cannot tell from a defect.
 *
 * **WHICH QUESTION DEPENDS ON THE ESTATE (R4, 2026-10-24).** Locally it is "did a container of the
 * compose project start inside the window" ({@link estateRestarts}). On DEV it is "did dev's build
 * change, or did a pre-release run, inside the window" ({@link devWindowVerdict}): `watch()` records
 * the build `/api/version` served when each window opened, and `gate()` reads it again at the end.
 * The history below is why the question moved twice before.
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
  let raw;
  try {
    raw = execFileSync(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        DEPLOY_WORKFLOW,
        '--limit',
        String(limit),
        '--json',
        'databaseId,headSha,status,conclusion,createdAt,updatedAt,displayTitle',
      ],
      { cwd: REPO, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    return { ok: false, why: `gh run list failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      ok: true,
      runs: parsed.map((r) => ({
        id: r.databaseId,
        sha: String(r.headSha ?? '').slice(0, 8),
        status: r.status,
        conclusion: r.conclusion ?? null,
        startedMs: Date.parse(r.createdAt),
        endedMs: RUNNING.has(r.status) ? Number.POSITIVE_INFINITY : Date.parse(r.updatedAt),
        title: r.displayTitle ?? '',
      })),
    };
  } catch (e) {
    return { ok: false, why: `gh run list returned no JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

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
  const restarted = [];
  for (const line of out.split('\n')) {
    const m = /^\/?(\S+)\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const startedMs = Date.parse(m[2]);
    if (!Number.isFinite(startedMs) || startedMs < sinceMs) continue;
    // Shaped like a deploy so `describe` and every reader of `redeployedMidRun` keep one vocabulary.
    restarted.push({ id: m[1], sha: 'local', status: 'restarted', conclusion: '', title: new Date(startedMs).toISOString() });
  }
  return { asked: true, restarted };
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

/** A hyphen in the version IS a pre-release (`release_kind()`), and a pre-release deploys DEV. */
const PRE_RELEASE = /\bv?\d+\.\d+\.\d+-/;

/**
 * Was the DEV estate redeployed under the window `[sinceMs, end.atMs]`? Pure - every input is read
 * elsewhere, so `archive/deploy-selftest.mjs` pins each answer.
 *
 * THREE WITNESSES, because each misses a case the others see:
 * - the build every client's window STARTED on against the build at the END: a new pre-release
 *   changes it, and that is the case the plan names;
 * - two windows that started on DIFFERENT builds: the deploy landed between two `watch()` calls;
 * - a `release.yml` run for a PRE-RELEASE (or one whose title cannot be read) intersecting the
 *   window: a rerun of the SAME tag redeploys dev without changing its build. A STABLE deploys
 *   production, which no row on dev reads, so it is not counted.
 *
 * WHAT IT CANNOT ANSWER IT SAYS, and never guesses "quiet": an unreadable start or end build, or an
 * unreadable `gh`, returns `asked: false` with every reason.
 *
 * @param {object} p
 * @param {Array<{build?: string, error?: string, atMs: number}>} p.starts each client window's start read
 * @param {{build?: string, error?: string, atMs: number}} p.end the read at gate time
 * @param {{ok: true, runs: object[]} | {ok: false, why: string}} p.runs `deployRuns()`
 * @param {number} p.sinceMs the earliest window start
 * @returns {{asked: true, overlapped: object[], builds: {start: string[], end: string}} | {asked: false, why: string}}
 */
export function devWindowVerdict({ starts, end, runs, sinceMs }) {
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
  if (!runs.ok) blind.push(`release runs: ${runs.why}`);
  else {
    const until = end?.atMs ?? Date.now();
    for (const run of runs.runs) {
      const forDev = PRE_RELEASE.test(run.title) || !/\bv?\d+\.\d+\.\d+\b/.test(run.title);
      if (forDev && run.startedMs <= until && run.endedMs >= sinceMs) overlapped.push(run);
    }
  }
  // AN OVERLAP IS AN ANSWER EVEN WITH A BLIND WITNESS BESIDE IT: one witness proving a redeploy
  // settles it. Only "nothing seen" needs every witness to have been readable.
  if (overlapped.length) return { asked: true, overlapped, builds: { start: startBuilds, end: end?.build ?? null } };
  if (blind.length) return { asked: false, why: blind.join('; ') };
  return { asked: true, overlapped: [], builds: { start: startBuilds, end: end.build } };
}

/**
 * The window question for whichever estate the reports were taken on - the one `gate()` asks.
 *
 * A report carries `estateBuild` when its client stood on a DEPLOYED estate (dev); then dev is asked.
 * Otherwise the estate is local and the question is {@link estateRestarts}, as before.
 *
 * @param {object[]} reports the gated reports
 * @param {number} sinceMs the earliest window start
 * @param {{readBuild?: (origin: string) => object, readRuns?: () => object, restarts?: (since: number) => object}} [io]
 *   injectable readers, for the self-test
 */
export function estateWindow(reports, sinceMs, io = {}) {
  const { readBuild = readEstateBuildSync, readRuns = deployRuns, restarts = estateRestarts } = io;
  const starts = reports.map((r) => r?.estateBuild).filter(Boolean);
  if (!starts.length) {
    const r = restarts(sinceMs);
    return r.asked ? { asked: true, overlapped: r.restarted } : r;
  }
  const origins = [...new Set(starts.map((s) => s.origin))];
  if (origins.length !== 1) return { asked: false, why: `the windows name ${origins.length} estates: ${origins.join(', ')}` };
  return devWindowVerdict({ starts, end: readBuild(origins[0]), runs: readRuns(), sinceMs });
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
