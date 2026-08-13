/**
 * Reads the tail of `results.ndjson` and prints the LAST record of each check whose name matches
 * the argument (default `MSG`), verdict first, then every field that is not `true`/`0`/empty.
 *
 * The point is not a summary - `run.mjs` already prints one. It is that the dirt is IN the record
 * (`senderSevere`, `receiverErrors`, ...) and a table hides exactly that, which is how a `PASS` with
 * three severe lines inside it survived two runs.
 */
import { readFileSync } from 'node:fs';

const prefix = process.argv[2] || 'MSG';
const rows = readFileSync(new URL('./results.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((r) => r && String(r.id || '').startsWith(prefix));

const last = new Map();
for (const r of rows) last.set(r.id, r);

const dirty = (v) =>
  Array.isArray(v) ? v.length > 0 : v !== null && v !== true && v !== 0 && v !== '' && v !== undefined;

for (const [check, r] of last) {
  console.log(`\n=== ${check}  ${r.verdict}   ${r.at || ''}`);
  for (const [k, v] of Object.entries(r)) {
    if (k === 'id' || k === 'verdict' || k === 'at') continue;
    if (/Clean$/.test(k) && v === true) continue;
    if (/Severe$|Errors$|Warnings$|unexplained/i.test(k) && Array.isArray(v) && v.length === 0) continue;
    if (!dirty(v)) continue;
    console.log(`  ${k}:`, typeof v === 'object' ? JSON.stringify(v) : v);
  }
}
