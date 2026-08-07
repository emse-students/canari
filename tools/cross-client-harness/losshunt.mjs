/**
 * Sends N messages one at a time W1 -> W2 and reconciles sent against received, keeping the
 * receiver's console for the whole run.
 *
 * This is the reconciliation the plan asks for (section 3.1: "by count, asserted programmatically,
 * not by eye"). A single loss is the result; the console window around it is the evidence.
 *
 * node losshunt.mjs [count] [gapMs] [--reload-each]
 */
import { writeFileSync } from 'node:fs';
import { awaitMessage, client, countMessage, openConversation, send } from './chat.mjs';
import { evaluate } from './cdp.mjs';
import { mark, record } from './results.mjs';

const count = Number(process.argv[2] || 20);
const gapMs = Number(process.argv[3] || 1500);
const reloadEach = process.argv.includes('--reload-each');
const settleMs = Number((process.argv.find((a) => a.startsWith('--settle=')) || '--settle=4000').split('=')[1]);

const w1 = await client(9224);
const w2 = await client(9223);
await w2.send('Log.enable');
await w2.send('Runtime.enable');

await openConversation(w2, 'the owner');
await openConversation(w1, 'PEER DISPLAY NAME');

const rows = [];
const consoleOf = (cx) => {
  const out = [];
  while (cx.events.length) {
    const e = cx.events.shift();
    if (e.method === 'Runtime.consoleAPICalled') out.push(e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 240));
    else if (e.method === 'Log.entryAdded') out.push(`${e.params.entry.level}: ${e.params.entry.text.slice(0, 240)}`);
  }
  return out;
};

for (let i = 0; i < count; i++) {
  if (reloadEach) {
    await w2.send('Page.reload');
    await evaluate(w2, '1').catch(() => {});
    // `settleMs` is the whole experiment: 4000 gives the receiver time to finish bootstrapping MLS,
    // 0 sends into the window where the conversation is already clickable but the client may not yet
    // be able to decrypt. Both real losses happened in that window.
    await new Promise((r) => setTimeout(r, settleMs));
    await openConversation(w2, 'the owner');
  }
  consoleOf(w2);
  const marker = mark(`HUNT${String(i).padStart(2, '0')}`);
  const at = await send(w1, `hunt ${marker}`);
  let ms = null;
  try {
    ms = await awaitMessage(w2, marker, 8000);
  } catch {
    /* a miss is data */
  }
  const logs = consoleOf(w2);
  rows.push({ i, marker, ms, at, logs: ms === null ? logs : logs.filter((l) => /Secret|bounds|Duplicate|GAP|error|Error/.test(l)) });
  if (ms === null) console.log(`  LOSS #${i} ${marker}`);
  await new Promise((r) => setTimeout(r, gapMs));
}

// Second chance: anything still missing after a reload was never recoverable, not merely late.
await new Promise((r) => setTimeout(r, 4000));
const stillMissing = [];
for (const r of rows) if (r.ms === null && (await countMessage(w2, r.marker)) === 0) stillMissing.push(r.marker);

const out = { count, gapMs, reloadEach, lost: rows.filter((r) => r.ms === null).length, stillMissing, rows };
const file = `logs/losshunt-${Date.now()}.json`;
writeFileSync(new URL(`./${file}`, import.meta.url), JSON.stringify(out, null, 1));
record('LOSSHUNT', out.lost === 0 ? 'PASS' : 'LOSS', {
  sent: count,
  lost: out.lost,
  stillMissing: stillMissing.length,
  latencies: rows.map((r) => r.ms),
  log: file,
});
w1.close();
w2.close();
