#!/usr/bin/env node
/**
 * Reports which build each web client is running, and refuses the run when one is stale.
 *
 *   node bundle-id.mjs             - compare every client served by the deployment
 *
 * THE DETECTION AND THE REASONING BOTH LIVE IN `bundle.mjs`. This file is the operator's entry
 * point and nothing else; it existed with its own copy of the comparison until 2026-08-24, and
 * `reload.mjs` held a third - so the rule "W1 and W2 must be on the deployed bundle before any
 * measurement" had two implementations and no caller. The preflight now asks the same question
 * through the same function, which is what makes this command a diagnostic rather than the gate.
 */
import { client, evaluate } from './chat.mjs';
import { PORTS } from './names.mjs';
import { deployedBundleId, isOnTheDeployment, runningBundleId } from './bundle.mjs';

let deployed;
try {
  deployed = await deployedBundleId();
} catch (e) {
  console.log(`[bundle] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
console.log(`[bundle] deployed: ${deployed}`);

let allMatch = true;
for (const d of Object.keys(PORTS).filter(isOnTheDeployment)) {
  const cx = await client(PORTS[d], null, { focus: false });
  try {
    const running = await runningBundleId(cx);
    const href = await evaluate(cx, 'location.href');
    const ok = running === deployed;
    allMatch &&= ok;
    console.log(`[bundle] ${d} (${PORTS[d]}): ${running} ${ok ? 'OK' : '<-- STALE, reload it'}  ${href}`);
  } finally {
    // CLOSE IT. An open CDP socket keeps node alive for ever, so the process never exits and a
    // script that worked is indistinguishable from one that hung.
    cx.close();
  }
}
console.log(`[bundle] ${allMatch ? 'every web client is on the deployed bundle' : 'DO NOT MEASURE - a client is stale'}`);
process.exitCode = allMatch ? 0 : 1;
