#!/usr/bin/env node
/**
 * Clears the CLIENT-SIDE half of a deleted throwaway group: the conversation a member's device
 * keeps after the group is gone from the server.
 *
 *   node dismiss.mjs [--port 9223] [--dry] [--limit N]
 *
 * WHY THIS IS A SEPARATE ESTATE FROM `cleanup.mjs`. Deleting a group server-side does not remove it
 * from anybody's client, and that is deliberate: `initializeConnection.ts:171` forgets the WASM
 * state - so the member can no longer send - and then calls `onGroupDeletedRemotely` so the UI marks
 * the conversation `removed` "instead of removing it silently". A conversation marked `removed` is a
 * fact about what its owner was TOLD, and no later reconciliation may reach past it
 * (`decideAbsentGroupFate`'s first guard). The only exit is the owner clicking "Supprimer
 * localement". That is right for a person and wrong for a rig: the campaign's GRP phase alone left
 * 189 of them in W2's store by 2026-08-24, each emitting a `[DISCOVERY] ... kept` line on every load
 * of every later check. Debris that ACCUMULATES and TALKS is the worst kind - it trains its reader
 * to skip the lines the next defect will hide in.
 *
 * IT DECIDES FROM DURABLE STATE, NEVER FROM THE ROW'S CAPTION. The sidebar preview of one of these
 * announces a member ADDITION - the last MESSAGE, from before the deletion, which describes the
 * conversation's state no better than any other message would. `ConversationMeta.lifecycle` is
 * what the product itself branches on, so it is what this branches on. A sweep reading the prose
 * would have spared that row and taken its neighbour.
 *
 * TWO CONDITIONS, BOTH REQUIRED, AND THE ALLOWLIST IS SHARED (`debris.mjs`):
 *   - the name is one a RUNNER mints, so nothing a person could type is eligible;
 *   - the server row is TOMBSTONED, proven by query and not inferred from the client's own label.
 *
 * The second condition is the user's standing rule in code rather than in prose: "supprimer
 * localement est unilateral, il faut supprimer des deux cotes pour nettoyer". A local dismissal of a
 * group still ALIVE server-side hides it from this device while every other member keeps theirs - so
 * that case is REPORTED, never swept, and the fix is `cleanup.mjs` first.
 *
 * DELETED THROUGH THE PRODUCT, NEVER THROUGH THE STORE, for `cleanup.mjs`'s reason: dropping the
 * IndexedDB rows would leave whatever else `purgeConversation` forgets - the group-keyed
 * awaiting-history markers it was written to clear - orphaned and nameless. Driving the button is
 * also the only coverage that control has.
 */
import { client, evaluate } from './chat.mjs';
import { isGroupDebris } from './debris.mjs';
import { dismissLocally, openGroup } from './groupnav.mjs';
import { PORTS } from './names.mjs';
import { psql } from './ssh.mjs';

const arg = (name, dflt) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt;
const port = Number(arg('--port', PORTS.W2));
const dry = process.argv.includes('--dry');
const limit = Number(arg('--limit', Infinity));

/**
 * The conversation store, read from the page.
 *
 * IT REFUSES A PROFILE HOLDING TWO ACCOUNTS rather than picking one: the database is named
 * `CanariDB_<userId>`, so two of them means two identities in one profile and `[0]` would be a
 * position rather than a choice - the same fault `client()` documents for tabs. `CanariDBMls_<id>`
 * is the MLS store, and the underscore-anchored prefix is what separates the two.
 */
const READ_STORE = String.raw`(async function () {
  var names = (await indexedDB.databases()).map(function (d) { return d.name; });
  var mine = names.filter(function (n) { return /^CanariDB_/.test(n); });
  if (mine.length !== 1)
    return JSON.stringify({ error: mine.length + ' CanariDB_<user> database(s), so none can be chosen' });
  var db = await new Promise(function (res, rej) {
    var r = indexedDB.open(mine[0]);
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
  var rows = await new Promise(function (res, rej) {
    var tx = db.transaction('conversations', 'readonly');
    var g = tx.objectStore('conversations').getAll();
    tx.oncomplete = function () { res(g.result); };
    tx.onerror = function () { rej(tx.error); };
  });
  db.close();
  return JSON.stringify({
    rows: rows.map(function (r) { return { id: r.id, name: r.name, lifecycle: r.lifecycle }; }),
  });
})()`;

/** Every conversation row this client persists - id, name and the lifecycle the product branches on. */
const readStore = async (cx) => {
  const out = JSON.parse(await evaluate(cx, READ_STORE));
  if (out.error) throw new Error(`[dismiss] ${out.error}`);
  return out.rows;
};

console.log(`[dismiss] port=${port} dry=${dry}`);
const cx = await client(port, 'canari-emse.fr', { focus: false });

/**
 * A1 IS SWEPT WITHOUT NAVIGATING, and the check that it is already on `/chat` is the point.
 *
 * `goto` REFUSES A1 outright, for two reasons it documents: a reload re-locks the encryption PIN, so
 * the run hangs on a modal it never expected and prints nothing, and it replaces the document under
 * Tauri's own IPC. So the phone is taken as it was left, and a phone left somewhere else is said out
 * loud rather than navigated - which would be the same reload wearing a different name.
 */
const canNavigate = port !== PORTS.A1;
if (!canNavigate) {
  const here = await evaluate(cx, 'location.pathname');
  if (here !== '/chat')
    throw new Error(`[dismiss] A1 is on ${here} rather than /chat, and goto() there re-locks the PIN`);
}

const rows = await readStore(cx);
console.log(`[dismiss] ${rows.length} conversation(s) in the store`);

// The server's answer for EVERY group, fetched once. Asking about 189 ids by name would put 7 KB of
// them into a shell command for no gain: the whole table is under 500 rows, and a group the server
// has never heard of is a row MISSING from this map rather than a row a query has to ask about.
const tombstoned = new Map(
  psql(`SELECT id::text, ("deletedAt" IS NOT NULL) FROM dm_groups WHERE "isGroup" = true`)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [id, dead] = l.split('|');
      return [id, dead === 't'];
    })
);
console.log(`[dismiss] server knows ${tombstoned.size} group(s)`);

const eligible = [];
const liveServerSide = [];
const unknownToServer = [];
for (const r of rows) {
  if (!isGroupDebris(r.name)) continue;
  if (r.lifecycle !== 'removed') {
    // ALLOWLISTED BUT STILL LIVE ON THIS CLIENT: not this tool's estate. `cleanup.mjs` deletes it
    // through the product, which is what makes the other members' copies go too.
    liveServerSide.push(r);
    continue;
  }
  const dead = tombstoned.get(r.id);
  if (dead === undefined) unknownToServer.push(r);
  else if (dead) eligible.push(r);
  else liveServerSide.push(r);
}

// A group the server has never heard of cannot be orphaned by dismissing this client's copy, and
// leaving it would leave exactly the debris this exists to clear - so it is eligible, and counted
// out loud rather than folded silently into the total.
if (unknownToServer.length)
  console.log(
    `[dismiss] ${unknownToServer.length} allowlisted row(s) name a group the server does not have ` +
      `(reaped, or never created) - eligible, nothing server-side can be orphaned by them`
  );
eligible.push(...unknownToServer);

/**
 * LONGEST NAME FIRST, and this is correctness rather than taste.
 *
 * GRP-5 renames its group to `<name>-R`, so a store can hold `GRP5-x-R` while `GRP5-x` is still a
 * substring of it. Every predicate in play matches by `indexOf`: `openGroup` picks the shortest row
 * CONTAINING the name, `paneIs` asks whether the open pane CONTAINS it, and `dismissLocally` waits
 * for the body to stop containing it. Asking for `GRP5-x` while `GRP5-x-R` is listed could open the
 * wrong row, assert successfully on it and delete it - the exact wrong-row failure `groupnav.mjs`
 * exists to prevent. Taking the longer one first makes every one of those matches unique by the time
 * the shorter is asked for.
 */
eligible.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));

console.log(
  `[dismiss] ${eligible.length} eligible, ${liveServerSide.length} live (server-side delete owed), ` +
    `${rows.length - eligible.length - liveServerSide.length} spared`
);
for (const r of liveServerSide)
  console.log(`[dismiss] LIVE, not swept: ${r.name} (${r.lifecycle}) - run cleanup.mjs first`);

if (dry) {
  for (const r of eligible.slice(0, 12)) console.log(`[dismiss] --dry would dismiss ${r.name}`);
  if (eligible.length > 12) console.log(`[dismiss] --dry ... and ${eligible.length - 12} more`);
  console.log('[dismiss] --dry: nothing dismissed');
  process.exit(0);
}

const targets = eligible.slice(0, Number.isFinite(limit) ? limit : eligible.length);
if (targets.length < eligible.length)
  console.log(
    `[dismiss] --limit ${limit}: ${eligible.length - targets.length} eligible row(s) left for a later pass`
  );

let done = 0;
const failed = [];
for (const [i, r] of targets.entries()) {
  try {
    await openGroup(cx, r.name, { navigate: canNavigate && i === 0, label: 'dismiss' });
    await dismissLocally(cx, r.name);
    // THE STORE IS THE POST-CONDITION, not the sidebar: `dismissLocally` proves the name left the
    // screen, and only the row's absence BY ID proves the purge actually ran.
    const gone = !(await readStore(cx)).some((x) => x.id === r.id);
    if (!gone) throw new Error('row still in the store after the click');
    done++;
    console.log(`[dismiss] ${done}/${targets.length} ${r.name}`);
  } catch (e) {
    // PER ROW, because a sweep that stops on the first stubborn one is a sweep nobody runs twice.
    failed.push(r.name);
    console.log(`[dismiss] FAILED ${r.name}: ${e.message}`);
  }
}

// TERMINATION FROM A PROOF, not from the loop having run: the store is re-read, and what it still
// holds is what is still there. Under `--limit` a remainder is the point, so only failures decide.
const left = (await readStore(cx)).filter(
  (r) => r.lifecycle === 'removed' && isGroupDebris(r.name) && tombstoned.get(r.id) !== false
);
console.log(
  `[dismiss] dismissed ${done}, failed ${failed.length}, ${left.length} eligible row(s) remain`
);
if (failed.length) console.log(`[dismiss] failed: ${failed.join(', ')}`);
process.exit(failed.length || (Number.isFinite(limit) ? 0 : left.length) ? 1 : 0);
