#!/usr/bin/env node
/**
 * WHAT A WEB CLIENT REMEMBERS HAVING ALREADY READ - the seen-ciphertext ledger, read off the client.
 *
 *   bun seenset.mjs --device W1                         # every group, one line each
 *   bun seenset.mjs --device W1 --group 2bd5add9        # one group, in detail
 *   bun seenset.mjs --device W1 --group 2bd5add9 --has 7e:1kk0lis,5p:1xc4y4j
 *
 * **WHY THIS IS AN ATOM.** `docs/wiki/backlog.md` has an entry whose next step is precisely this
 * read, and it is written there as blocked: *"A CDP probe of W1's localStorage HUNG twice while
 * trying to settle this - so the read needs a route that is not `evaluate` on a live client. That is
 * the next step, and no further code should be written for this row until it answers."* The read is
 * what tells a false accusation of loss from a real one: `[History] frame never read here and
 * unreadable for good` fires when a generation is spent and this ledger does not know it, so the
 * ledger's contents are the difference between "the mark was never written" and "the mark was
 * written and lost".
 *
 * **THE ROUTE THAT WORKS, AND WHY THE OTHER ONE HANGS.** Two things, both of which matter:
 *
 * 1. **It returns a STRING, not an object.** `Runtime.evaluate` without `returnByValue` hands back a
 *    remote object handle for anything structured, and reading a 4 800-entry array through one is
 *    where the wait came from. `JSON.stringify` inside the page makes the answer a primitive, which
 *    comes back whole in the first reply.
 * 2. **It attaches with `focus: false`.** Raising a window mid-run is a gesture on the subject, and
 *    this read has to be safe to take WHILE something else is being measured - which is the only
 *    time its answer is interesting.
 *
 * Proven on 2026-09-08 against a group holding 4 835 entries: three reads, no hang.
 *
 * **THE KEY SHAPE IS THE FULL GROUP ID, NOT A PREFIX** - `history_seen_cipher:<userId>:<groupId>`
 * (`seenHistoryKey` in `frontend/src/lib/utils/chat/history.ts`). A first version of this read
 * matched on a five-character prefix, found nothing, and would have reported an ABSENT ledger for a
 * group that has one - a check that cannot see what it asserts the absence of does not fail, it
 * lies. `--group` is therefore a SUBSTRING match against the whole key and the count of matched
 * groups is always printed, so "no such group" and "one group" are different answers on the page.
 *
 * **THE SET MIXES TWO NAMESPACES UNDER ONE CAP**, which is why the breakdown is printed rather than
 * the total. `frames` are ciphertext fingerprints (`<2 chars>:<base36>`) and say *"I consumed this
 * generation"*; the rest are message ids and say *"I walked this row"*. Both are written into the
 * same array, `saveSeenCipherHashes` caps it at 5 000 and keeps the LAST 5 000 - so message ids
 * evict fingerprints, and a fingerprint evicted is an accusation that will fire again.
 */
import { APP_TAB, client, evaluate } from './chat.mjs';
import { PORTS } from './names.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const device = flag('device', 'W1');
const group = flag('group');
const has = (flag('has') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const port = PORTS[device];
if (!port) throw new Error(`unknown device ${device} - one of ${Object.keys(PORTS).join(', ')}`);

const page = await client(port, APP_TAB, { focus: false });

/**
 * The whole read, executed in the page and returned as one JSON string.
 *
 * `MAX_HASHES` is duplicated from the product deliberately: this tool reports how close a set is to
 * the cap, and a tool that imported the constant would silently start reporting a different question
 * the day the product changed it. It is asserted against the observed maximum instead.
 */
const raw = await evaluate(
  page,
  `(() => {
     const CAP = 5000;
     const PREFIX = 'history_seen_cipher:';
     const needles = ${JSON.stringify(has)};
     const wanted = ${JSON.stringify(group)};
     const groups = [];
     const hits = {};
     for (const key of Object.keys(localStorage)) {
       if (!key.startsWith(PREFIX)) continue;
       let entries;
       try { entries = JSON.parse(localStorage.getItem(key)); } catch { continue; }
       if (!Array.isArray(entries)) continue;
       // A fingerprint is "<2 chars>:<base36>"; everything else in here is a message id.
       const frames = entries.filter((e) => typeof e === 'string' && /^[a-z0-9]{2}:/.test(e));
       for (const n of needles) if (entries.includes(n)) (hits[n] ||= []).push(key);
       if (wanted && !key.includes(wanted)) continue;
       groups.push({
         group: key.slice(PREFIX.length).split(':').slice(1).join(':'),
         entries: entries.length,
         frames: frames.length,
         rows: entries.length - frames.length,
         pctOfCap: Math.round((entries.length / CAP) * 1000) / 10,
         evicting: entries.length >= CAP,
         newestFrames: frames.slice(-3),
       });
     }
     groups.sort((a, b) => b.entries - a.entries);
     // THE CAP IS PER GROUP AND NOTHING BOUNDS THE NUMBER OF GROUPS, so the total is a different
     // question from any row above it. Exceeding the origin quota is not loud: the product catches
     // the write failure and warns that "this replay is repeated in full next time", which is a
     // permanent, silent regression to re-walking history on every boot.
     let bytes = 0, ledgers = 0;
     for (const key of Object.keys(localStorage)) {
       if (!key.startsWith(PREFIX)) continue;
       ledgers++;
       bytes += key.length + (localStorage.getItem(key) || '').length;
     }
     return JSON.stringify({ matched: groups.length, groups, hits, bytes, ledgers });
   })()`
);

const report = JSON.parse(raw);
console.log(
  `[seenset] ${device}: ${report.matched} group(s)${group ? ` matching "${group}"` : ''} hold a seen-ciphertext ledger`
);
for (const g of report.groups) {
  console.log(
    `  ${g.group.slice(0, 8)}  ${String(g.entries).padStart(5)} entries ` +
      `(${g.frames} frames + ${g.rows} rows) = ${g.pctOfCap}% of the 5000 cap` +
      (g.evicting ? '  ** AT THE CAP - the OLDEST marks are being dropped **' : '')
  );
}
console.log(
  `[seenset] ${report.ledgers} ledger(s) on this client, ${(report.bytes / 1024).toFixed(1)} kB of ` +
    'localStorage - the 5000 cap is PER GROUP and nothing bounds the number of groups'
);
if (has.length > 0) {
  // NAMED EITHER WAY. An absent needle is the interesting answer - it means nothing recorded having
  // consumed that frame - and an absence printed as silence is indistinguishable from a read that
  // did not run.
  for (const needle of has) {
    const where = report.hits[needle];
    console.log(
      `  needle ${needle}: ${where ? `FOUND in ${where.length} ledger(s)` : 'ABSENT from every ledger on this client'}`
    );
  }
}

process.exit(0);
