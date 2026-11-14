// The member with the app open, for deploy-rolling.test.sh: sends POSTs through the edge, several at
// a time, from before the deploy starts until the file named by argv[3] appears, and prints what it
// got. A POST on purpose - it is the request nginx may NOT replay once a byte has been sent, so it is
// the one a careless replacement turns into a 502 ("Echec de l'envoi").
//
// Prints {statuses, versions, maxMs, failed}: `failed` holds the first 20 non-200 answers with the
// moment each was sent, so a failure can be placed in the deploy's timeline.
//
// Usage: bun client.mjs <url> <stop-file> [concurrency]
//
// IT ENDS WITH ITS TEST, WHICHEVER WAY THE TEST ENDS. The stop file is one ending; the stop file's
// DIRECTORY disappearing is the other - the test's cleanup removes it on every exit, a failure
// included, and a client that waited only for the file looped on for hours after a failed run,
// keeping every transport error it met (13 GB across three leaked clients, 2026-11-14). So the loop
// also ends when the directory is gone, and `failed` keeps only what it prints.
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, stopFile, concurrencyArg] = process.argv.slice(2);
const concurrency = Number(concurrencyArg ?? 4);
const statuses = new Map();
const versions = new Map();
let maxMs = 0;
const failed = [];
/** The first FAILED_KEPT failures are printed; the rest are counted, never held. */
const FAILED_KEPT = 20;
const testDir = dirname(stopFile);
/** The test is over: its stop file exists, or its directory - and so the test - is gone. */
const testOver = () => existsSync(stopFile) || !existsSync(testDir);

async function worker() {
  while (!testOver()) {
    const started = Date.now();
    let key;
    try {
      // ONE CONNECTION PER REQUEST, as the host's nginx opens them to the edge: its vhost proxies to
      // a literal address with no `upstream { keepalive }`, so it never reuses one (read on the
      // shared host, 2026-10-17). A reused connection would add the keep-alive close race of a
      // retiring nginx, which production's edge never sees.
      const res = await fetch(url, {
        method: 'POST',
        body: '{"text":"hello"}',
        headers: { connection: 'close' },
        keepalive: false,
      });
      const body = await res.text();
      key = String(res.status);
      if (res.ok) {
        const version = JSON.parse(body).version;
        versions.set(version, (versions.get(version) ?? 0) + 1);
      }
    } catch (e) {
      key = `transport:${e?.code ?? e?.message ?? e}`;
    }
    maxMs = Math.max(maxMs, Date.now() - started);
    if (key !== '200' && failed.length < FAILED_KEPT) {
      failed.push({ key, sent: new Date(started).toISOString(), ms: Date.now() - started });
    }
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
console.log(
  JSON.stringify({
    statuses: Object.fromEntries(statuses),
    versions: Object.fromEntries(versions),
    maxMs,
    failed,
  })
);
