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
import { evaluate } from './chat.mjs';
import { ORIGIN, SITE } from './names.mjs';

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
  if (!id) throw new Error(`the shell at ${SITE}/ carries no __sveltekit_<id> - this check is broken, not the client`);
  return id;
}

/** The build id a connected client is executing. `'none'` when the page has no SvelteKit shell. */
export const runningBundleId = (cx) => evaluate(cx, RUNNING_ID);

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
