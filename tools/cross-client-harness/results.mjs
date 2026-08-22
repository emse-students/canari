/**
 * Append-only result log for the campaign.
 *
 * A check that passes earns a row in section 10 of the wiki page and nothing else; a check that
 * fails earns a Work Package with its captured log. Both need the raw record to have survived the
 * session, so every runner writes here rather than only to stdout.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:https';
import { SITE, STATE_DIR } from './names.mjs';
import { gate, report } from './watch.mjs';

/**
 * Outside the repository, with the rest of the machine-local state: a verdict row carries the
 * condensed dirt of the run, which quotes captured console lines, and those name real conversations.
 */
const FILE = join(STATE_DIR, 'results.ndjson');

/**
 * THE BUILD EVERY ROW OF THIS PROCESS RAN AGAINST - read from the DEPLOYMENT, never from git alone.
 *
 * The board's own convention is "the verdict with the commit it ran on", and until 2026-08-20 no
 * runner could satisfy it: nothing the web client prints names its build, so every COMM verdict was
 * dated by hand from commit timestamps afterwards. `versionName` and `platform_config.version` are
 * both constants somebody edits at release time and read `0.14.0` across a week of deploys, so
 * neither separates two builds of the same release.
 *
 * `/_app/version.json` is the one stamp the running deployment hands over for free: SvelteKit writes
 * the build's own millisecond timestamp into it, and it changes with every build. That is the
 * evidence, in the sense of rule 17 - a property of the code that is actually serving.
 *
 * THE COMMIT IS DERIVED FROM IT, and the derivation is stated rather than assumed: the newest commit
 * on the history THAT CONTAINS THE BUNDLE, at or before the build's timestamp. CD builds a pushed
 * commit and finishes minutes later, so this is exact unless a SECOND commit lands inside that
 * window - in which case it names the later one, which is why `builtAt` is recorded beside it and
 * is the figure to trust.
 *
 * IT THROWS RATHER THAN DEGRADING. A check that cannot date its build produces a verdict nobody can
 * attribute, which is the fault this exists to close; failing at import costs a run that had not
 * started and leaves no debris.
 */
/** The repository this harness lives in - the only place a build stamp can be dated against. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A SvelteKit build stamp turned into the commit that produced it, ON A NAMED HISTORY.
 *
 * Shared by the deployment and by any CLIENT that serves its own bundle - the phone does, which is
 * the whole reason this is not inlined in `deployedBuild` any more.
 *
 * `ref` IS REQUIRED, AND IT IS THE WHOLE CORRECTNESS ARGUMENT. A timestamp names a commit only
 * against a history that actually contains the bundle, and the two callers do not share one:
 *
 *   - the DEPLOYMENT is built by CD from a commit that is on `origin/main` by definition;
 *   - the PHONE's APK is built HERE, from the working tree, so its commit may not be pushed yet.
 *
 * Resolving a locally built bundle against `origin/main` therefore names the newest commit that
 * happened to be PUSHED when the question was asked - and answers differently later, once the real
 * one lands. Seen 2026-08-22: A1's bundle (built 01:36:04.345Z from `a7981206`, committed 03:12
 * local and pushed at 05:27) was read as `6748f6b8` by 207 MUT rows and as `a7981206` by the NOTIF
 * rows after it - ONE bundle, one `builtAt`, two names, and the board carried both. `a7981206` was
 * docs-only so no behavioural claim moved, which is luck and not a property of the mechanism.
 */
export function resolveStamp(stamp, where, ref) {
  if (!ref) throw new Error(`resolveStamp(${where}) was not told which history contains the bundle`);
  if (!Number.isFinite(stamp)) throw new Error(`${where} carries no build stamp`);
  const builtAt = new Date(stamp).toISOString();
  const commit = execFileSync(
    'git',
    ['-C', REPO, 'log', '-1', '--format=%h', `--before=${builtAt}`, ref],
    { encoding: 'utf8' }
  ).trim();
  if (!commit) throw new Error(`no commit on ${ref} at or before ${builtAt} - fetch first`);
  return { builtAt, commit };
}

/**
 * The commit date of a named commit, as the threshold a build has to clear.
 *
 * DERIVED FROM THE REPOSITORY, never written as a literal date: a check that needs a mechanism
 * names the COMMIT that introduced it, and the date follows. A literal would go on being true
 * after a rebase or a re-dating and nobody would ever look at it again.
 */
export function commitDate(commit) {
  const iso = execFileSync(
    'git',
    ['-C', REPO, 'log', '-1', '--format=%cI', commit],
    { encoding: 'utf8' }
  ).trim();
  if (!iso) throw new Error(`no such commit: ${commit}`);
  return iso;
}

/**
 * ONE GET, ON `node:https` RATHER THAN `fetch`, BECAUSE THIS ONE RUNS DURING MODULE INIT.
 *
 * A failure here has to end the process, and `process.exit()` after a `fetch` aborts on node 24 for
 * Windows - libuv trips `!(handle->flags & UV_HANDLE_CLOSING)` tearing undici down, which maps the
 * exit to 0xC0000409 and prints two lines AFTER the real error. Measured 2026-08-21 on the identical
 * script: `fetch` aborts, `node:https` exits 1. Closing the global dispatcher first does NOT help,
 * so the transport is the fix rather than the teardown. `agent: false` keeps no socket alive.
 */
function getText(url) {
  return new Promise((resolve, reject) => {
    const call = request(url, { agent: false }, (answer) => {
      let body = '';
      answer.setEncoding('utf8');
      answer.on('data', (chunk) => (body += chunk));
      answer.on('end', () => resolve({ status: answer.statusCode, body }));
    });
    call.on('error', reject);
    call.end();
  });
}

async function deployedBuild() {
  const answer = await getText(`${SITE}/_app/version.json`);
  // A GATEWAY STATUS IS THE EDGE SAYING IT HAS NO ANSWER, NOT THE DEPLOYMENT STATING ITS VERSION,
  // and the two send a reader to different places. Seen 2026-08-20T22:39Z: a run started three
  // minutes into a deploy and read `answered 502`, which names the version endpoint - the endpoint
  // was fine and the origin was restarting. Still a throw, because a verdict nobody can attribute
  // to a build is worth less than no verdict; only the sentence changes, and it says WAIT.
  if (answer.status >= 502 && answer.status <= 504) {
    throw new Error(
      `${SITE} is not reachable through its edge (${answer.status}) - the origin is down or ` +
        `mid-deploy. No verdict can be attributed to a build until it answers.`
    );
  }
  if (answer.status !== 200) {
    throw new Error(`${SITE}/_app/version.json answered ${answer.status}`);
  }
  return resolveStamp(Number(JSON.parse(answer.body)?.version), `${SITE}/_app/version.json`, 'origin/main');
}

/**
 * The build a CLIENT is actually running, read from ITS OWN bundle.
 *
 * THE PHONE IS NOT ON THE DEPLOYMENT AND NEVER WILL BE. `frontendDist` is `../build`, so the app
 * serves what was packaged into its APK and a deploy does not reach it - which is a real
 * mixed-fleet state rather than an oversight, and a verdict that does not say which side it read
 * is unattributable. COMM-25 came back `FAIL` on 2026-08-20 against a phone whose APK was NINE
 * DAYS older than the mechanism under test: the device could not have exhibited it, and the
 * failure said nothing about the product.
 *
 * A same-origin fetch of a static asset, and callers do it while ARMING - before the object under
 * test exists. That is what keeps it compatible with a check whose claim is that no gesture was
 * needed: nothing can be repaired that has not been created.
 */
export async function clientBuild(cx) {
  const { evaluate } = await import('./cdp.mjs');
  const raw = await evaluate(
    cx,
    `fetch('/_app/version.json').then(function (r) { return r.text(); })`
  );
  let stamp = NaN;
  try {
    stamp = Number(JSON.parse(String(raw))?.version);
  } catch {
    throw new Error(`this client's /_app/version.json is not JSON: ${String(raw).slice(0, 80)}`);
  }
  // `HEAD`, NOT `origin/main`: this bundle was built from the working tree, and dating it against a
  // remote ref renames it every time a push lands. See `resolveStamp`.
  return resolveStamp(stamp, "the client's own /_app/version.json", 'HEAD');
}

/**
 * A MODULE-INIT FAILURE EXITS, IT DOES NOT ABORT.
 *
 * Everything below this line is computed while the module loads, so a failure here is a THROW OUT OF
 * TOP LEVEL - and node 24 on Windows answers that by tearing down an undici handle it has already
 * begun closing, which makes libuv abort:
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`. The
 * abort maps the exit to 0xC0000409 and prints two lines AFTER the real error, so `run.mjs`, which
 * echoes the last four of a crashed script, showed the assertion in `async.c` and hid the cause.
 * Seen 2026-08-20 on a COMM-25 run that had simply started three minutes into a deploy.
 *
 * Nothing is swallowed: the same sentence is printed, on the same stream. Only the exit is honest.
 */
function initFailed(what, message) {
  console.error(`
[${what}] ${message}
`);
  process.exit(1);
}

let BUILD;
try {
  BUILD = await deployedBuild();
} catch (e) {
  initFailed('BUILD', e.message);
}

/**
 * THE CHECK A VERDICT RAN AS, hashed from the runner's own source.
 *
 * A verdict is only evidence for the assertions that produced it, and a check gets tightened. COMM-5
 * is the case that made this necessary: it was recorded `PASS` on 2026-08-20, and its own row says
 * `liveWithoutReload: false` - because at that moment the row asked only that the capability arrive
 * eventually. `capabilityIsLive` was added to its expectations afterwards, and the board went on
 * showing a `PASS` earned under the older, weaker question. The evidence for the defect found later
 * that day was sitting in that recorded `false`, under a green verdict, for fifteen hours.
 *
 * So a row now names the check it ran as, exactly as it already names the build it ran against, and
 * "this verdict predates the current runner" is computed rather than remembered.
 *
 * ITS LIMIT IS STATED RATHER THAN PAPERED OVER: this hashes the ENTRY script, where a check's own
 * assertions live. A change to a shared gesture in `comm.mjs` or `chat.mjs` can change what a check
 * measures and will NOT move this hash. Hashing the whole harness instead would retire every verdict
 * on every edit, which is a different way of saying nothing.
 */
const CHECK = (() => {
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) {
    initFailed('CHECK', `results.mjs cannot identify the running check (argv[1]=${entry ?? 'unset'})`);
  }
  return {
    file: basename(entry),
    sha: createHash('sha256').update(readFileSync(entry)).digest('hex').slice(0, 12),
  };
})();

/**
 * THE BUILD THE PHONE IS RUNNING, handed down by the preflight rather than asked for by each check.
 *
 * A1's APK deliberately predates the deployment - `frontendDist` is `../build`, so the phone serves
 * what was packaged into it and a deploy never reaches it. A verdict from a phase that read the phone
 * and does not say which side it read is unattributable, and the board's convention already demands
 * it. **Only four runners out of thirty ever recorded it**, all in COMM, and the wiki claimed every
 * A1 row did. Measured 2026-08-21 while MSG was running: `msg2`, `msg5`, `msg8` and `msg8b` all
 * drive the phone, and all four landed rows with no `a1Build` at all.
 *
 * A rule saying "record it" would be the rule that was already implied and forgotten the same way,
 * so it is not a call any check makes. `run.mjs` reads the phone ONCE per phase, while arming it, and
 * puts the stamp here; every row of every script it spawns then carries it, and a phase with no phone
 * carries nothing rather than a null that reads as "the phone was there and answered nothing".
 *
 * IT IS THE ARMING-TIME STAMP, which is what a reader wants: a reinstall mid-phase would make it
 * stale, and by the campaign's own rule a rebuild restarts the phase anyway.
 */
const A1_BUILD = (() => {
  const raw = process.env.CANARI_A1_BUILD;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    // NOT SWALLOWED. Garbage here means the preflight wrote something it should not have, and
    // continuing would drop the phone's build from every row of the phase - the exact fault this
    // exists to close, restored silently.
    initFailed('A1_BUILD', `CANARI_A1_BUILD is not JSON (${String(e)}): ${raw.slice(0, 120)}`);
  }
})();

/** Every verdict THIS process has recorded, so the exit code can be derived rather than remembered. */
const recorded = [];

/**
 * Did this verdict look at anything? `gate()` is the ONLY producer of `clean`, so its presence is
 * the proof an observation happened; `unobservable` is the explicit, written-down alternative.
 */
const observed = (detail) =>
  !!detail && (typeof detail.clean === 'boolean' || typeof detail.unobservable === 'string');

export function record(id, verdict, detail) {
  // A PASS THAT LOOKED AT NOTHING IS NOT A PASS, AND THIS IS THE ONLY PLACE THAT CAN KNOW IT.
  //
  // The campaign's rule has two halves - the assertions hold AND the run is clean - and half of the
  // scripts implemented the first one only. They were not silent about it: they printed a full
  // `report()` UNDER the verdict, where it could be read but never contradict anything. Measured
  // 2026-08-16 across the whole harness: MSG, TYPE, READ, MUT and FWD-345 gate; NOTIF, NOTIF7, LIFE,
  // TAB, FWD-1/2, FWD-5 and HEAL print; SEARCH, MENTION and GRP - the three phases queued to run
  // next - had no observer at all, `watch=0` and `report=0`. Twenty-odd verdicts rested on nobody
  // looking, which is precisely the fault READ shipped eight PASSes on and `mut.mjs` was rewritten
  // for. A rule stating "gate every check" would have been the same rule that was already stated,
  // and forgotten the same way, so the refusal lives HERE - one place, no call to remember.
  //
  // DEMOTED, NEVER DROPPED, and only from PASS: PASS is the sole verdict that CLAIMS the run was
  // clean, so it is the sole one whose claim can be unfounded. FAIL, SLOW, INVALID and the rest are
  // already work owed and already exit non-zero; rewriting them would destroy evidence to say
  // something the row already says. `UNOBSERVED` is distinct from `PASS-DIRTY` on purpose - "nobody
  // looked" and "someone looked and it was dirty" send their reader to different places.
  const owedObservation = verdict === 'PASS' && !observed(detail);
  const stated = owedObservation ? 'UNOBSERVED' : verdict;
  const row = {
    id,
    verdict: stated,
    at: new Date().toISOString(),
    build: BUILD.commit,
    builtAt: BUILD.builtAt,
    check: CHECK.file,
    checkSha: CHECK.sha,
    // BEFORE `detail`, so a runner that read the phone at its OWN arming moment overrides this one.
    // Four COMM checks do, and theirs is the more precise of the two.
    ...(A1_BUILD ? { a1Build: A1_BUILD.commit, a1BuiltAt: A1_BUILD.builtAt } : {}),
    ...detail,
    ...(owedObservation
      ? { claimedVerdict: verdict, unobserved: 'no report was gated into this verdict - see gate() in watch.mjs' }
      : {}),
  };
  appendFileSync(FILE, `${JSON.stringify(row)}\n`);
  console.log(`[${stated}] ${id} ${JSON.stringify(detail)}`);
  recorded.push(row);
  return row;
}

/**
 * THE EXIT CODE IS DERIVED FROM THE VERDICTS, so no script can record a failure and exit 0.
 *
 * `finish` below states the two-consumer contract and enforces it perfectly - for the six scripts
 * that call it. The other twenty-four record with `record` and then simply reach their last line, so
 * `run.mjs` printed `done` beside a recorded `FAIL` in the same table. Adding a `finishAll` for them
 * would have moved the problem rather than solved it: the omission being fixed is one of FORGETTING,
 * and a second function to remember is a second thing to forget.
 *
 * So it is not a call at all. `beforeExit` fires when a script runs off its end - exactly the path
 * that was silent - and cannot fire on `process.exit` (which `finish` already codes correctly) or on
 * an uncaught throw (which is non-zero anyway). Nothing to add to any script, nothing to omit.
 *
 * Scoped to processes that recorded SOMETHING. Many one-shot probes import `mark` from here and
 * record nothing by design, and failing those would be inventing verdicts for scripts that never
 * claimed one. A phase script that records nothing is a real fault, but a different one, and
 * `run.mjs` already shows it as a job with no row rather than as a pass.
 */
process.on('beforeExit', () => {
  if (!recorded.length || process.exitCode) return;
  const owed = recorded.filter((r) => r.verdict !== 'PASS');
  if (!owed.length) return;
  console.log(`\n  ${owed.length} verdict(s) other than PASS - exiting non-zero: ${owed.map((r) => `${r.id}=${r.verdict}`).join(', ')}`);
  process.exitCode = 1;
});

/**
 * RECORD THE VERDICT AND EXIT ON IT - the whole contract, in the one place that cannot be half done.
 *
 * A check owes its verdict to TWO consumers: `results.ndjson`, which is the campaign's record and
 * the only thing the dashboard may be written from, and the EXIT CODE, which is what `run.mjs`
 * prints a failure tail for. Every script implemented one half or the other, never both, and each
 * omission is invisible in its own way:
 *
 *   - `msg2.mjs` recorded and never exited, so a run printed `msg2.mjs  done` beside a recorded
 *     `FAIL MSG-2` - the two halves of the same run contradicting each other in one table;
 *   - `msg8.mjs`, `msg8b.mjs`, `msg9.mjs` and `msg10.mjs` exited and never recorded, so the phase
 *     table showed 9 verdicts for 12 scripts and the four silent ones read as passes. A script that
 *     records nothing is indistinguishable from one that passed, which is the worse direction.
 *
 * Exit 0 for a clean PASS only. `PASS-DIRTY`, `INCONCLUSIVE`, `VACUOUS`, `INVALID` and `FAIL` all
 * exit non-zero, because the campaign's own rule is that a verdict counts as passed only when the
 * assertions hold AND the run is clean - so anything else is work still owed, and the runner must
 * not be able to report it as done.
 */
export function finish(id, verdict, detail) {
  record(id, verdict, detail);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

/**
 * RECORD A VERDICT ON WHAT WAS WATCHED - one call, so obeying the rule is shorter than breaking it.
 *
 * `record` above REFUSES an unobserved PASS; this is the affordance that makes the refusal easy to
 * satisfy, and the two were written together on purpose. A refusal with no affordance beside it does
 * not get obeyed, it gets worked around - and `unobservable: '...'` is one string away.
 *
 * The three lines it replaces (`await report` per client, `gate`, spread the detail) were the whole
 * reason twelve verdicts across SEARCH and MENTION had no observer: not disagreement with the rule,
 * just three lines nobody wrote at check number two and every check after it copied.
 *
 * VALUES MAY BE EITHER a handle from {@link watch} or a report already computed - the phone's
 * {@link logcatReport} is never a handle, and neither is a window a check had to close early. A
 * report is recognised by carrying `clean`; anything else is reported here.
 *
 * @param {string} id the check id, as the dashboard spells it
 * @param {string} verdict the ASSERTION outcome - the observation is applied on top, never under
 * @param {object} detail what the check measured
 * @param {Record<string, object>} observers label -> `watch()` handle or a finished report
 */
export async function recordObserved(id, verdict, detail, observers) {
  const reports = {};
  for (const [label, o] of Object.entries(observers))
    if (o) reports[label] = typeof o.clean === 'boolean' ? o : await report(o);
  const gated = gate(verdict, reports);
  return record(id, gated.verdict, { ...gated.detail, ...detail });
}

/**
 * {@link recordObserved} and then {@link finish}'s exit - for a check that must not fall off its end.
 *
 * Most scripts can simply reach their last line and let `beforeExit` derive the code. The ones that
 * cannot are the ones holding a CDP socket or an adb forward open: nothing closes those, so the
 * process never idles and `beforeExit` never fires. `life.mjs` is exactly that shape, which is why
 * it had a `process.exit` - and why the fix is to keep the exit and gate what it exits ON.
 */
export async function finishObserved(id, verdict, detail, observers) {
  const row = await recordObserved(id, verdict, detail, observers);
  process.exit(row.verdict === 'PASS' ? 0 : 1);
}

export function all() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A short unique marker, so two runs of the same check never collide in the history. */
export const mark = (id) => `${id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * The same marker with a sequence number, for a check that sends a RUN of messages.
 *
 * It exists because hand-rolled sequenced markers kept being written at the call site, and they
 * drifted from what `mark` produces in the one way that matters: `PEND-mson9mr-1041`, several
 * hundred of which are sitting in the test DM, carries a stamp `recon.mjs` cannot decode, so the
 * reconciliation excluded every one of them and reported success over an empty set. Producing the
 * sequence here keeps the stamp intact and the ordinal readable.
 */
export const markSeq = (id, n) => `${mark(id)}-${String(n).padStart(4, '0')}`;

/**
 * Recognises a campaign marker in rendered text - THE ONLY definition, imported by `recon.mjs`.
 *
 * Deliberately looser than what `mark` emits, because the history holds markers from checks written
 * before it existed (`NOTIF10-0-msi3g44rb9u`, `LIFE5B-abcde`, `PEND-<stamp>-1041`). Over-matching is
 * safe and under-matching is not: a token that is not really a marker appears in BOTH clients' text
 * and reconciles away, while a marker the pattern misses is a loss that cannot be seen. Anything
 * whose stamp will not decode is dropped from the comparison by `markerStamp` rather than reported.
 */
export const MARKER_RE = /\b[A-Z][A-Z0-9]{1,11}(?:-[0-9a-z]+){1,3}\b/g;

/** Wall time a marker was minted, or null when no segment of it decodes to a plausible one. */
export function markerStamp(marker) {
  for (const segment of marker.split('-').slice(1)) {
    // Either the whole segment (`mark` before the random suffix was added) or the segment with the
    // three random characters removed. Both are tried; the plausibility bound is what decides.
    for (const candidate of [segment, segment.slice(0, -3)]) {
      const t = parseInt(candidate, 36);
      if (Number.isFinite(t) && t > 1_700_000_000_000 && t < Date.now() + 60_000) return t;
    }
  }
  return null;
}
