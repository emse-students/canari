// The member with the app open, for deploy-rolling.test.sh: sends POSTs through the edge, several at
// a time, from before the deploy starts until the file named by argv[3] appears, and prints what it
// got. A POST on purpose - it is the request nginx may NOT replay once a byte has been sent, so it is
// the one a careless replacement turns into a 502 ("Echec de l'envoi").
//
// Prints {statuses, versions, maxMs, failed, lastFailedSent}: `failed` holds the first 20 non-200
// answers with the moment each was sent, so a failure can be placed in the deploy's timeline, and
// `lastFailedSent` the moment the LAST failing one was sent (null when none failed).
//
// ALSO ONE SERVICE CALLING ANOTHER (2026-11-07): run inside the fixture's `caller` container, against
// the mesh or the API's own name. With `keepalive` it pools its connections as a service's `fetch`
// does, rather than opening one per request.
//
// Usage: bun client.mjs <url> <stop-file> [concurrency] [keepalive|close] [bound-ms]
import { existsSync } from 'node:fs';

const [url, stopFile, concurrencyArg, mode, boundArg] = process.argv.slice(2);
const concurrency = Number(concurrencyArg ?? 4);
const keepAlive = mode === 'keepalive';
// A request that never ends would hold the stop forever: a connection to the address of a replica
// already removed is not refused on a Docker bridge, it times out. Bounds the FAILURE case only - the
// longest request a passing run sees is ~200 ms - and it is counted as one. A case that counts how long
// failures last passes a shorter one, so a worker stuck on a dead address sends again sooner.
const REQUEST_BOUND_MS = Number(boundArg ?? 10_000);
const statuses = new Map();
const versions = new Map();
let maxMs = 0;
const failed = [];
let lastFailedSent = null;

async function worker() {
  while (!existsSync(stopFile)) {
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
        headers: keepAlive ? {} : { connection: 'close' },
        keepalive: keepAlive,
        signal: AbortSignal.timeout(REQUEST_BOUND_MS),
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
    if (key !== '200') {
      const sent = new Date(started).toISOString();
      failed.push({ key, sent, ms: Date.now() - started });
      if (lastFailedSent === null || sent > lastFailedSent) lastFailedSent = sent;
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
    failed: failed.slice(0, 20),
    lastFailedSent,
  })
);
