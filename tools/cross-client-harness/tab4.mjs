/**
 * TAB-4 - two tabs of the SAME account, open at once.
 *
 * The risk is named in the ratchet-checkpoint fix itself: a ratchet that can go backwards means two
 * live tabs of one device can diverge. Both tabs share one IndexedDB and one MLS state, and the app
 * elects a leader over Web Locks (`[TAB] Leadership acquired`) so only one holds the WebSocket. The
 * questions are therefore:
 *   - does a message arrive in BOTH tabs, or only the leader's?
 *   - does sending from the FOLLOWER tab work at all, and exactly once?
 *   - does either tab log a duplicate / out-of-bounds, i.e. did the two of them fight over the
 *     ratchet?
 *
 * The second tab is opened BY THE PAGE (`window.open`), which is the only way to get a real sibling
 * tab in the same window and the same profile - see `tabs.mjs` for why the CDP routes do not.
 */
import { client, ensureChat, openConversation, countMessage, awaitMessage, send } from './chat.mjs';
import { listTargets, connect, evaluate } from './cdp.mjs';
import { watch, report } from './watch.mjs';
import { mark } from './results.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');

// Both clients are reloaded first, and this is not hygiene: a long-lived tab keeps the bundle it
// loaded, so a page opened before a deploy runs the OLD code while a tab opened by this script runs
// the new one. The first run after the WP-HIDDEN-1 deploy failed exactly that way.
for (const cx of [w1, w2]) await cx.send('Page.reload');
await sleep(10000);
await ensureChat(w1);
await openConversation(w1, 'PEER DISPLAY NAME');
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');
await sleep(1500);

const before = new Set((await listTargets(9224)).map((t) => t.id));
await evaluate(w1, `(function () { window.__t2 = window.open('https://canari-emse.fr/chat', '_blank'); return !!window.__t2; })()`);

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  target = (await listTargets(9224)).find((t) => !before.has(t.id) && t.url.includes('canari-emse.fr'));
}
if (!target) throw new Error('the second tab never appeared on 9224');

const w1b = connect(target.webSocketDebuggerUrl);
await w1b.ready;
await w1b.send('Runtime.enable');
w1b.port = 9224;
console.log(`second tab attached: ${target.url}`);

// A fresh tab needs its own load, PIN unlock included, before it can decrypt anything.
await sleep(12000);
await ensureChat(w1b);
await openConversation(w1b, 'PEER DISPLAY NAME');
await sleep(2000);

const rows = [];

/** TAB-4a - the peer sends; both tabs of the same account must show it, exactly once each. */
{
  const o = [await watch(w1, '4a-w1'), await watch(w1b, '4a-w1b')];
  const m = mark('TAB4A');
  await send(w2, `${m} from the peer, two tabs open`);
  await awaitMessage(w1, m, 25000).catch(() => null);
  await awaitMessage(w1b, m, 25000).catch(() => null);
  await sleep(2500);
  const [a, b] = [await countMessage(w1, m), await countMessage(w1b, m)];
  const [ra, rb] = [await report(o[0]), await report(o[1])];
  rows.push({ check: 'TAB-4a peer -> both tabs', marker: m, tab1: a, tab2: b, verdict: a === 1 && b === 1 ? 'PASS' : 'FAIL', tab1Notable: ra.notable, tab2Notable: rb.notable });
}

/** TAB-4b - the SECOND tab sends. It is very likely the follower, which is the interesting half. */
{
  const o = [await watch(w1, '4b-w1'), await watch(w1b, '4b-w1b'), await watch(w2, '4b-w2')];
  const m = mark('TAB4B');
  await send(w1b, `${m} sent from the second tab`);
  await awaitMessage(w2, m, 25000).catch(() => null);
  await sleep(2500);
  const [a, b, c] = [await countMessage(w1, m), await countMessage(w1b, m), await countMessage(w2, m)];
  const [ra, rb, rc] = [await report(o[0]), await report(o[1]), await report(o[2])];
  rows.push({ check: 'TAB-4b second tab sends', marker: m, tab1: a, tab2: b, peer: c, verdict: b === 1 && c === 1 ? 'PASS' : 'FAIL', tab1Notable: ra.notable, tab2Notable: rb.notable, peerNotable: rc.notable });
}

/** TAB-4c - the FIRST tab sends straight after, the case where a rewind between tabs would show. */
{
  const o = [await watch(w1b, '4c-w1b'), await watch(w2, '4c-w2')];
  const m = mark('TAB4C');
  await send(w1, `${m} sent from the first tab right after`);
  await awaitMessage(w2, m, 25000).catch(() => null);
  await sleep(2500);
  const [b, c] = [await countMessage(w1b, m), await countMessage(w2, m)];
  const [rb, rc] = [await report(o[0]), await report(o[1])];
  rows.push({ check: 'TAB-4c first tab sends after', marker: m, tab2: b, peer: c, verdict: c === 1 ? 'PASS' : 'FAIL', tab2Notable: rb.notable, peerNotable: rc.notable });
}

for (const r of rows) console.log(JSON.stringify(r));

await evaluate(w1, '(function () { if (window.__t2) { window.__t2.close(); window.__t2 = null; } return true; })()').catch(() => null);
const bad = rows.filter((r) => r.verdict !== 'PASS');
console.log(`\n${rows.length - bad.length}/${rows.length} TAB-4 checks pass`);
process.exit(bad.length ? 1 : 0);
