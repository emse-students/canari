/**
 * Reloads the web clients onto the CURRENTLY DEPLOYED bundle, and proves it took.
 *
 *   node reload.mjs [--ports 9224,9223]
 *
 * A browser left open across a deploy keeps running the old bundle, and its console then reads
 * exactly like a browser that was reloaded - which is how a whole phase gets measured against code
 * that is no longer deployed. `bundle-id.mjs` DETECTS that; this is the other half, the repair, and
 * it asserts rather than assumes: a reload that silently served from cache leaves the same build id
 * in `window`, so the id is compared again afterwards and a client that did not move is reported.
 *
 * `location.reload(true)` is not it - the boolean has been ignored for years. The cache is bypassed
 * by going to the same URL through the Network domain's cache-disabled flag, which is a devtools
 * capability rather than a page one.
 *
 * It does NOT enter the PIN. A reload re-mounts the app and the encryption gate comes back, so
 * `pin.mjs` is owed straight after - see the campaign's standing rule about a locked client reading
 * as healthy on a route where the gate does not mount.
 */
import { client, evaluate } from './chat.mjs';

const flag = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? f : process.argv[i + 1];
};
const ports = String(flag('ports', '9224,9223'))
  .split(',')
  .map((p) => Number(p.trim()))
  .filter(Boolean);

const ORIGIN = 'https://canari-emse.fr';
const ID = /__sveltekit_[a-z0-9]+/;
const buildId = `(Object.keys(window).filter(function (k) { return k.indexOf('__sveltekit_') === 0 && k !== '__sveltekit_sw'; })[0] || 'none')`;

const deployed = (await (await fetch(`${ORIGIN}/`, { redirect: 'follow' })).text()).match(ID)?.[0];
if (!deployed) {
  console.log('[reload] the origin shell carries no build id - cannot verify, fix this check');
  process.exit(2);
}
console.log(`[reload] deployed: ${deployed}`);

let allOk = true;
for (const port of ports) {
  const cx = await client(port, null, { focus: false });
  const before = await evaluate(cx, buildId);
  const href = await evaluate(cx, 'location.href');

  if (before === deployed) {
    console.log(`[reload] ${port}: already on ${deployed} - not touched  ${href}`);
    cx.close();
    continue;
  }

  await cx.send('Network.enable').catch(() => {});
  await cx.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  await cx.send('Page.enable').catch(() => {});
  await cx.send('Page.reload', { ignoreCache: true }).catch(() => {});

  // The app is a SPA behind a service worker: `load` fires long before the store is usable, so wait
  // for the build id to CHANGE rather than for any lifecycle event. A poll is honest here - there is
  // no event for "the new bundle booted".
  const t0 = Date.now();
  let after = before;
  while (Date.now() - t0 < 60_000) {
    await new Promise((r) => setTimeout(r, 1000));
    after = await evaluate(cx, buildId).catch(() => before);
    if (after === deployed) break;
  }
  await cx.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});

  const ok = after === deployed;
  allOk &&= ok;
  console.log(
    `[reload] ${port}: ${before} -> ${after} ${ok ? `OK in ${Math.round((Date.now() - t0) / 1000)}s` : '<-- DID NOT MOVE'}`
  );
  // CLOSE IT. An open CDP socket keeps node alive for ever, so the process never exits, and
  // anything reading this through a pipe sees nothing at all until it is killed - a script that
  // worked and one that hung are then indistinguishable. Never `process.exit()` here either: closing
  // a socket and tearing down in the same tick trips a libuv assertion on Windows.
  cx.close();
}

console.log(
  `[reload] ${allOk ? 'every client is on the deployed bundle - run pin.mjs next' : 'A CLIENT IS STALE - do not measure'}`
);
process.exitCode = allOk ? 0 : 1;
