/**
 * WHICH BUNDLE A WEB CLIENT IS RUNNING, and the repair when it is not the deployed one.
 *
 * A browser left open across a deploy keeps executing the old bundle, and its console then reads
 * exactly like a browser that was reloaded - so a phase measures code that is no longer deployed and
 * every row still names the deployed build. That is not hypothetical: on 2026-08-24, two minutes
 * into `GRP --repeat 5`, GRP-3 came back `PASS-DIRTY` on an `[OUTBOX] … evicted from …` line whose
 * spelling had been REPLACED four commits earlier and appears nowhere in the served bundle. The fix
 * looked broken; the client was old.
 *
 * THE DISCRIMINATOR ALREADY EXISTED AND NOTHING ASKED IT. `results.mjs`'s `clientBuild()` reads a
 * client's build with a same-origin `fetch('/_app/version.json')`, which is genuinely the client's
 * own bundle for the PHONE - `ORIGIN.A1` is `tauri.localhost`, so the asset comes out of the APK -
 * and is a network round trip to production for a WEB client, which answers with what production
 * serves NOW whatever the tab is running. One function, two questions, and only the phone's is the
 * one its doc claims. `ORIGIN[device] === SITE` is exactly that distinction, already written down.
 *
 * SO THE WEB HALF NEEDS A DIFFERENT PROOF, and SvelteKit hands it over: the shell writes
 * `__sveltekit_<id>` as a GLOBAL, so a running page carries its own build id in `window` - baked in,
 * not fetched - and the origin serves the current one in the shell it renders. Comparing the two is
 * a property of the code that is actually executing, which is what rule 17 asks of evidence.
 *
 * AND STALENESS IS A PER-CHECK PROPERTY, NOT A PER-RUN ONE, which is why detecting it once is not
 * enough and the repair has to be deliberate. SvelteKit polls `version.json` and reloads on the next
 * navigation when it changed, so a client left open across a deploy is stale for an UNPREDICTABLE
 * PREFIX of a run and correct afterwards - W2 printed the old line at 15:22 and read as current when
 * asked by hand at 15:31, having healed itself in between. A run that heals halfway produces a
 * mixture of two builds under one stamp, and nothing in the row says which check got which.
 */
import { readSourceStamp, sourceStamp, staleReason } from '../../frontend/scripts/source-stamp.mjs';

import { pathToFileURL } from 'node:url';

import { APP_TAB, client, evaluate } from './chat.mjs';
import { LOCAL } from './estate.mjs';
import { ORIGIN, PORTS, SITE } from './names.mjs';

const ID = /__sveltekit_[a-z0-9]+/;

/**
 * The running page's own build id, read from `window` rather than from the network.
 *
 * `__sveltekit_sw` is excluded because it is the service worker's key and not a build id - it is
 * present on every build, so including it would make every client look like it matched every other.
 */
const RUNNING_ID = `(Object.keys(window).filter(function (k) { return k.indexOf('__sveltekit_') === 0 && k !== '__sveltekit_sw'; })[0] || 'none')`;

/**
 * Whether a device is served BY the deployment at all - the only devices this module can judge.
 *
 * Taken from `ORIGIN`, which already encodes it, rather than from a list of device names kept here:
 * a second copy of that distinction would be one more thing to forget when a device is added.
 *
 * @param {string} device - 'W1', 'W2' or 'A1'
 */
export const isOnTheDeployment = (device) => ORIGIN[device] === SITE;

/**
 * The build id production is serving right now, from the shell it renders.
 *
 * IT THROWS RATHER THAN RETURNING NOTHING. A missing id means this check can no longer tell a stale
 * client from a fresh one, and a comparison that silently passes because one side is absent is worse
 * than no comparison - it would report every browser as current for ever.
 */
export async function deployedBundleId() {
  const shell = await (await fetch(`${SITE}/`, { redirect: 'follow' })).text();
  const id = shell.match(ID)?.[0];
  if (!id)
    throw new Error(
      `the shell at ${SITE}/ carries no __sveltekit_<id> - this check is broken, not the client`
    );
  return id;
}

/** The build id a connected client is executing. `'none'` when the page has no SvelteKit shell. */
export const runningBundleId = (cx) => evaluate(cx, RUNNING_ID);

/**
 * WHETHER THE ESTATE IS SERVING THE SOURCE IN THIS TREE - the third question, and the one that was
 * missing.
 *
 * The two above prove a client runs what the origin serves, and `check-bundle-consistency.mjs`
 * proves an artefact can boot. NONE of them looks at the source. On 2026-09-07 a `vite build` running
 * in the background overlapped a `git switch`, so it read the tree at the moment the branch change
 * had reverted one component; the artefact was internally consistent, the deploy succeeded, both
 * browsers reloaded onto it, and GRP-3 and GRP-8 came back `FAIL` on a `data-remove-member` attribute
 * that was in the source and in no chunk. Every check the rig had passed, and the two verdicts
 * accused the product of the rig's own mistake.
 *
 * A CONTENT HASH, WRITTEN BY THE BUILD ITSELF (`frontend/scripts/source-stamp.mjs`), which is why
 * this asks two questions rather than one: `id` proves the deployment is that build, `sha` proves
 * that build is this source. Either half alone passes the case that cost the two rows.
 *
 * LOCAL ONLY, and that is not a limitation. Production legitimately lags the tree - a release is
 * older than `main` by construction - so the claim "deployed == source" is only meaningful on the
 * estate the campaign builds itself. `LOCAL` already encodes the distinction.
 *
 * @param {string} deployed - the id the origin is serving, from {@link deployedBundleId}
 * @returns {Promise<string|null>} the reason to refuse to measure, or `null` when the estate is
 *   serving this tree (or the question does not apply here)
 */
export async function sourceIsDeployed(deployed) {
  if (!LOCAL) return null;
  return staleReason(deployed, readSourceStamp(), sourceStamp());
}

/**
 * Puts a client onto `deployed`, and PROVES it took.
 *
 * `location.reload(true)` is not it - the boolean has been ignored by browsers for years. The cache
 * is bypassed through the Network domain's cache-disabled flag, which is a devtools capability
 * rather than a page one.
 *
 * The app is a SPA behind a service worker, so `load` fires long before the store is usable: what is
 * waited for is the build id CHANGING, which is the only observable that means "the new bundle
 * booted". A poll is honest here because no event reports it.
 *
 * IT DOES NOT ENTER THE PIN. A reload re-mounts the app and the encryption gate comes back, so the
 * caller owes an unlock straight after - `run.mjs`'s repair loop does it by construction, and
 * `reload.mjs` says so in its own output.
 *
 * @returns {Promise<{before: string, after: string, ok: boolean, tookMs: number}>} - `ok: false` is
 *   a client that did not move, which is a reason to refuse to measure rather than a warning.
 */
export async function reloadOntoBundle(cx, deployed, { timeoutMs = 60_000 } = {}) {
  const before = await runningBundleId(cx);
  const t0 = Date.now();
  if (before === deployed) return { before, after: before, ok: true, tookMs: 0 };

  await cx.send('Network.enable').catch(() => {});
  await cx.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  await cx.send('Page.enable').catch(() => {});
  await cx.send('Page.reload', { ignoreCache: true }).catch(() => {});

  let after = before;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    after = await runningBundleId(cx).catch(() => before);
    if (after === deployed) break;
  }
  await cx.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});

  return { before, after, ok: after === deployed, tookMs: Date.now() - t0 };
}

/**
 * RUN AS A COMMAND, this file answers the question its exports are for - and until 2026-09-08 it
 * answered nothing at all.
 *
 *   bun bundle.mjs                 # which web clients are stale, and whether the estate is this source
 *   bun bundle.mjs --repair        # ...and reload the stale ones onto the deployment
 *
 * **WHY THIS BLOCK EXISTS.** It was a pure library, so `bun bundle.mjs` executed the module, printed
 * nothing and exited 0 - and 0 was read, in this very repository on 2026-09-08, as "the browsers are
 * on the new build". They were not: W2 was three builds behind, its lazy chunks 404ed against the
 * rebuilt estate, `openChannel` could not load its page, and NOTIF-14's salon half recorded a `FAIL`
 * that was entirely the rig's. **A tool that exits 0 when asked a question it never heard is the same
 * defect this file was written to prevent**, one level up: the check that catches a stale client was
 * itself unrunnable, and its silence looked exactly like a pass.
 *
 * It refuses rather than reporting when it cannot compare, for the reason `deployedBundleId` throws:
 * a comparison one side of which is missing would call every browser current, for ever.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repair = process.argv.includes('--repair');
  const deployed = await deployedBundleId();
  const drift = await sourceIsDeployed(deployed);
  console.log(`[bundle] the estate at ${SITE} serves ${deployed}`);
  if (drift) console.log(`[bundle] ** the estate is NOT this source: ${drift} **`);

  let stale = 0;
  for (const device of ['W1', 'W2', 'W3']) {
    if (!isOnTheDeployment(device)) continue;
    let cx;
    try {
      cx = await client(PORTS[device], APP_TAB, { focus: false });
    } catch (e) {
      // NAMED, NEVER SKIPPED IN SILENCE: a client that cannot be attached is a client whose bundle
      // is unknown, which is the state this tool exists to make impossible to mistake for "fine".
      console.log(`  ${device}  UNREACHABLE - ${String(e).slice(0, 80)}`);
      stale++;
      continue;
    }
    const running = await runningBundleId(cx).catch(() => 'unknown');
    if (running === deployed) {
      console.log(`  ${device}  current (${running})`);
      continue;
    }
    if (!repair) {
      stale++;
      console.log(`  ${device}  STALE - running ${running}, deployment is ${deployed}`);
      continue;
    }
    // COUNTED ON THE OUTCOME, NEVER ON THE SYMPTOM. A first version incremented here and reported
    // "2 client(s) not on the deployment after the repair" about two clients it had just reloaded
    // successfully - a summary line contradicting the two lines above it, which is worse than no
    // summary. What the caller needs is the state it is left in, so a repaired client is not stale.
    const moved = await reloadOntoBundle(cx, deployed);
    if (!moved.ok) stale++;
    console.log(
      `  ${device}  ${moved.ok ? 'reloaded' : 'DID NOT MOVE'} ${moved.before} -> ${moved.after} in ${moved.tookMs}ms` +
        (moved.ok ? ' - it owes a PIN unlock, a reload re-mounts the gate' : '')
    );
    if (!moved.ok) console.log(`  ${device}  refuse to measure on this client until it moves`);
  }

  // EXIT CODE IS THE ANSWER, so a Makefile or a preflight can use it. Non-zero means at least one
  // client would measure code the estate is not serving.
  console.log(
    `[bundle] ${stale} client(s) not on the deployment${repair ? ' after the repair' : ''}`
  );
  process.exit(stale === 0 ? 0 : 1);
}
