// The member with the app open, for deploy-rolling.test.sh: sends POSTs through the edge, several at
// a time, from before the deploy starts until the file named by argv[3] appears, and prints what it
// got. A POST on purpose - it is the request nginx may NOT replay once a byte has been sent, so it is
// the one a careless replacement turns into a 502 ("Echec de l'envoi").
//
// Usage: bun client.mjs <url> <stop-file> [concurrency]
import { existsSync } from 'node:fs';

const [url, stopFile, concurrencyArg] = process.argv.slice(2);
const concurrency = Number(concurrencyArg ?? 4);
const statuses = new Map();
const versions = new Map();
let maxMs = 0;

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
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
console.log(
  JSON.stringify({
    statuses: Object.fromEntries(statuses),
    versions: Object.fromEntries(versions),
    maxMs,
  })
);
