/**
 * Reloads the web clients onto the CURRENTLY DEPLOYED bundle, and proves it took.
 *
 *   bun reload.mjs [--ports 9224,9223]
 *
 * THE REPAIR AND ITS REASONING LIVE IN `bundle.mjs`, shared with `bundle-id.mjs` and with the
 * preflight - this file is the operator's entry point for doing it by hand. It held its own copy of
 * both the comparison and the reload until 2026-08-24, which is how the rule it enforces ended up
 * with two implementations and no caller: the preflight, the one gate every phase goes through,
 * never asked.
 *
 * IT DOES NOT ENTER THE PIN. A reload re-mounts the app and the encryption gate comes back, so
 * `pin.mjs` is owed straight after - see the campaign's standing rule about a locked client reading
 * as healthy on a route where the gate does not mount. Run through `run.mjs`, the repair loop does
 * that unlock by construction and this warning does not apply.
 */
import { client } from './chat.mjs';
import { PORTS } from './names.mjs';
import { resolveDevices } from './device.mjs';
import { deployedBundleId, isOnTheDeployment, reloadOntoBundle } from './bundle.mjs';

// `--device W1,W2` is the spelling; `--ports 9224,9223` still resolves, through the same one
// implementation. The default is every client the deployment actually serves - a phone EMBEDS its
// frontend, so reloading it onto "the deployed bundle" is a category error, and `isOnTheDeployment`
// is what already knows the difference.
const ports = resolveDevices(process.argv.slice(2), {
  fallback: Object.keys(PORTS).filter(isOnTheDeployment),
}).map((t) => t.port);

let deployed;
try {
  deployed = await deployedBundleId();
} catch (e) {
  console.log(`[reload] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
console.log(`[reload] deployed: ${deployed}`);

let allOk = true;
for (const port of ports) {
  const cx = await client(port, null, { focus: false });
  try {
    const r = await reloadOntoBundle(cx, deployed);
    allOk &&= r.ok;
    if (r.tookMs === 0) console.log(`[reload] ${port}: already on ${deployed} - not touched`);
    else
      console.log(
        `[reload] ${port}: ${r.before} -> ${r.after} ${r.ok ? `OK in ${Math.round(r.tookMs / 1000)}s` : '<-- DID NOT MOVE'}`
      );
  } finally {
    // CLOSE IT. An open CDP socket keeps node alive for ever, so the process never exits, and
    // anything reading this through a pipe sees nothing at all until it is killed - a script that
    // worked and one that hung are then indistinguishable. Never `process.exit()` here either:
    // closing a socket and tearing down in the same tick trips a libuv assertion on Windows.
    cx.close();
  }
}

console.log(
  `[reload] ${allOk ? 'every client is on the deployed bundle - run pin.mjs next' : 'A CLIENT IS STALE - do not measure'}`
);
process.exitCode = allOk ? 0 : 1;
