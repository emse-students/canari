/**
 * Is the "Synchronisation des messages..." banner a genuinely long catch-up, or is it STUCK?
 *
 * The banner is `session.isMessagingInitializing || messaging.isMessageCatchupActive`.
 * `isMessageCatchupActive` is a DEPTH counter raised by every drain that has >1 pending frame and
 * lowered by the UI bulk-ingest observer. That observer is the SECOND subscriber in
 * `BaseMlsService.endBulkIngest`, which awaits them in one unguarded loop - so if the FIRST one
 * (the encrypted-checkpoint persister, which rethrows on failure) rejects, the UI observer is never
 * called and the depth never comes back down. The banner is then permanent, and worse,
 * `bulkIngestActive` stays raised so every inbound message is buffered and eventually discarded.
 *
 * Two hypotheses, and the log tells them apart:
 *   H1 normal - the banner is up because drains keep arriving; it goes down when they stop.
 *   H2 stuck  - `[MLS] Encrypted state checkpoint failed` / `[QUEUE] onDrainEnd failed` in the log,
 *               and the banner never goes down even with no traffic.
 *
 * This only OBSERVES: no send, no reload, nothing that could clear the very state being measured.
 */
import { listTargets, connect, evaluate } from './cdp.mjs';

const SAMPLES = 20;
const EVERY_MS = 1_500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BANNER = 'Synchronisation des messages';
const SUSPECT = [
  '[MLS] Encrypted state checkpoint failed',
  '[QUEUE] onDrainEnd failed',
  'endBulkIngest without a matching beginBulkIngest',
  'discarding', // warnIfDiscardingBuffered
];

async function attach(port, urlPart) {
  const ts = await listTargets(port).catch(() => []);
  const t = ts.find((x) => String(x.url).includes(urlPart));
  if (!t) return null;
  const cx = connect(t.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  return cx;
}

function lines(cx) {
  return cx.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
}

const targets = [
  { name: 'W1', port: 9224, urlPart: 'canari-emse.fr' },
  { name: 'W2', port: 9223, urlPart: 'canari-emse.fr' },
  { name: 'A1', port: 9222, urlPart: 'tauri.localhost' },
];

const out = {};
for (const t of targets) {
  const cx = await attach(t.port, t.urlPart);
  if (!cx) {
    out[t.name] = { attached: false };
    console.log(`${t.name}: not attached`);
    continue;
  }
  const rec = { attached: true, banner: [], drains: 0, suspects: [] };
  for (let i = 0; i < SAMPLES; i++) {
    const seen = await evaluate(cx, `(document.body.innerText || '').indexOf('${BANNER}') !== -1`);
    rec.banner.push(seen === true || seen === 'true');
    await sleep(EVERY_MS);
  }
  const ls = lines(cx);
  rec.drains = ls.filter((l) => /\[QUEUE\] Drain start/.test(l)).length;
  rec.drainEnds = ls.filter((l) => /\[QUEUE\] Drain complete/.test(l)).length;
  rec.suspects = ls.filter((l) => SUSPECT.some((s) => l.includes(s))).slice(0, 20);
  rec.alwaysUp = rec.banner.every(Boolean);
  rec.everUp = rec.banner.some(Boolean);
  out[t.name] = rec;
  console.log(
    `${t.name}: banner ${rec.banner.map((b) => (b ? '#' : '.')).join('')}  drains ${rec.drains}/${rec.drainEnds}  suspects ${rec.suspects.length}`
  );
  for (const s of rec.suspects) console.log(`   ! ${s.slice(0, 160)}`);
  cx.close();
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
