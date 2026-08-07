/**
 * Is anything STUCK in the outbox?
 *
 * The storm's suspected amplifier is named in the outbox's own comment: "A delete that fails leaves
 * a SENT entry in the queue, so the next flush sends it again." The protection it claims - "the
 * receiver deduplicates on messageId" - does NOT cover a control event: `decrypt_failed` is
 * re-executed by `systemMessageHandler` on every arrival, and each execution asks the peer to
 * retransmit. One undeletable control entry is therefore an unbounded emitter.
 *
 * This reads `CanariDB_<userId>.outbox` on both browsers and reports the entries by kind, status
 * and age. It only READS - the entries are the evidence, and flushing or clearing them would
 * destroy it.
 */
import { listTargets, connect, evaluate } from './cdp.mjs';

async function attach(port) {
  const ts = await listTargets(port).catch(() => []);
  const t = ts.find((x) => String(x.url).includes('canari-emse.fr'));
  if (!t) return null;
  const cx = connect(t.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  return cx;
}

const READ = `
(async () => {
  const names = (await indexedDB.databases()).map(d => d.name).filter(n => n && n.startsWith('CanariDB_'));
  const out = { databases: names, outbox: [] };
  for (const name of names) {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains('outbox')) { db.close(); continue; }
    const rows = await new Promise((res, rej) => {
      const r = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    for (const row of rows) {
      out.outbox.push({
        db: name.slice(0, 20),
        id: String(row.id || '').slice(0, 8),
        kind: row.kind,
        status: row.status,
        attempts: row.attempts,
        ageMin: row.sentAt ? Math.round((Date.now() - row.sentAt) / 60000) : null,
        nextIn: row.nextAttemptAt ? Math.round((row.nextAttemptAt - Date.now()) / 1000) : null,
      });
    }
  }
  return JSON.stringify(out);
})()`;

for (const [name, port] of [
  ['W1', 9224],
  ['W2', 9223],
]) {
  const cx = await attach(port);
  if (!cx) {
    console.log(`${name}: not attached`);
    continue;
  }
  const res = await cx.send('Runtime.evaluate', {
    expression: READ,
    awaitPromise: true,
    returnByValue: true,
  });
  const val = res.result?.result?.value;
  if (!val) {
    console.log(`${name}: no result`, JSON.stringify(res.result).slice(0, 300));
  } else {
    const parsed = JSON.parse(val);
    console.log(`\n=== ${name} === databases: ${parsed.databases.join(', ')}`);
    console.log(`outbox entries: ${parsed.outbox.length}`);
    for (const e of parsed.outbox.slice(0, 40)) console.log('   ', JSON.stringify(e));
  }
  cx.close();
}
process.exit(0);
