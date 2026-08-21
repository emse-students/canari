/**
 * WAS PRODUCTION REDEPLOYED WHILE THE CHECK WAS RUNNING? - the one cause of transport failure that
 * is OURS, and the only one a check cannot tell from a defect.
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
 * module that guessed "no deploy" in that case would be a silent blind spot. {@link overlapping}
 * returns `asked: false` with the reason instead, which the record carries verbatim.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The workflow that restarts production. `cd-dev.yml` deploys elsewhere and is not this. */
export const DEPLOY_WORKFLOW = 'cd.yml';

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
 * The deploys whose window intersects `[sinceMs, now]` - i.e. the ones that could have restarted
 * production under a check that started at `sinceMs`.
 *
 * @param {number} sinceMs epoch ms the check began at, e.g. `watch()`'s `since`
 * @returns {{asked: true, overlapped: Array<object>} | {asked: false, why: string}}
 */
export function overlapping(sinceMs) {
  const r = deployRuns();
  if (!r.ok) return { asked: false, why: r.why };
  const now = Date.now();
  return { asked: true, overlapped: r.runs.filter((x) => x.endedMs >= sinceMs && x.startedMs <= now) };
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
