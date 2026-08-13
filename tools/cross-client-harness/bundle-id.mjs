#!/usr/bin/env node
/**
 * Proves a browser is running the CURRENTLY DEPLOYED bundle, not a warm old one.
 *
 * "W1 and W2 must be RELOADED onto the current bundle before any repair check" has been a rule of
 * this campaign for days, and it has never had an assertion behind it - a reload that silently
 * served from cache is indistinguishable from one that did not, and the whole verdict then measures
 * the old code. SvelteKit's per-build id is the discriminator that already exists: the shell writes
 * `__sveltekit_<id>` as a GLOBAL, so the running page carries its build id in `window`, and the
 * origin serves the current one in the shell it renders.
 *
 *   node bundle-id.mjs             - compare 9224 and 9223 against https://canari-emse.fr/
 */
import { client, evaluate } from './chat.mjs';

const ORIGIN = 'https://canari-emse.fr';
const ID = /__sveltekit_[a-z0-9]+/;

const deployed = (await (await fetch(`${ORIGIN}/`, { redirect: 'follow' })).text()).match(ID)?.[0];
if (!deployed) {
  console.log('[bundle] the origin shell carries no __sveltekit_<id> - cannot compare, fix this check');
  process.exit(2);
}
console.log(`[bundle] deployed: ${deployed}`);

let allMatch = true;
for (const [port, label] of [
  [9224, 'W1'],
  [9223, 'W2'],
]) {
  const cx = await client(port, null, { focus: false });
  const running = await evaluate(
    cx,
    `(Object.keys(window).filter(function (k) { return k.indexOf('__sveltekit_') === 0 && k !== '__sveltekit_sw'; })[0] || 'none')`
  );
  const href = await evaluate(cx, 'location.href');
  const ok = running === deployed;
  allMatch &&= ok;
  console.log(`[bundle] ${label} (${port}): ${running} ${ok ? 'OK' : '<-- STALE, reload it'}  ${href}`);
}
console.log(`[bundle] ${allMatch ? 'both browsers are on the deployed bundle' : 'DO NOT MEASURE - a browser is stale'}`);
process.exit(allMatch ? 0 : 1);
