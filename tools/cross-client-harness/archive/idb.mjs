/**
 * Reading the app's OWN IndexedDB from outside it - one implementation of the awkward part.
 *
 * Eleven copies of the same six lines existed when this was written, across `del1.mjs`,
 * `dismiss.mjs`, `grainestore.mjs`, `grp.mjs`, `identity.mjs`, `mlsdb.mjs`, `mut.mjs` and
 * `recon.mjs`, and they did not all agree - `recon.mjs` takes the FIRST database matching the
 * prefix, `del1.mjs` iterates every one of them. That is not a style difference: a Chrome profile
 * that has ever held two accounts holds two databases, and the first one is then a coin toss. This
 * module iterates, always.
 *
 * THE PREFIX IS A TRAP AND IT IS WHY THE FILTER IS HERE RATHER THAN AT EIGHT CALL SITES. The app's
 * store is `CanariDB_<uid>`; the MLS store is `CanariDBMls<...>`, which ALSO starts with `CanariDB`.
 * A prefix test alone reaches into the MLS database, where `conversations` does not exist and an
 * `outbox` never will - so the answer is not an error, it is an empty result that reads exactly like
 * "nothing queued". Hence `CanariDB_` with the underscore, and `Mls` excluded explicitly.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decrypt. Sensitive columns are encrypted with the device key,
 * which belongs to the user. Every reader below returns CLEAR columns only, and each one names the
 * fields it copies out one by one instead of spreading the row - a spread would carry ciphertext
 * into `results.ndjson`, which is committed to a PUBLIC repository, and "it is encrypted" is not a
 * reason to publish it.
 *
 * The existing eight callers are NOT converted to this. They belong to phases that are green, and
 * rewriting a working store read underneath a verdict that already stands is how a campaign loses a
 * rung it had already paid for. The duplication is filed as P3 in `docs/wiki/backlog.md`, to be
 * collapsed when the ladder is no longer standing on those runners.
 */
import { evaluate } from '../cdp.mjs';

/**
 * The page-side preamble: `openDb(name)` and `appDatabases()`.
 *
 * Exported as SOURCE because the projection has to run in the page. Copying a whole store across
 * CDP and filtering here would work for `conversations` and is unacceptable for `outbox`, whose rows
 * carry an encrypted payload - so the shape is "one preamble, many projections", and the projection
 * is the caller's.
 */
export const PREAMBLE = `
  var openDb = function (n) { return new Promise(function (res) {
    var r = indexedDB.open(n);
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { res(null); };
    setTimeout(function () { res(null); }, 4000);
  }); };
  var appDatabases = async function () {
    return (await indexedDB.databases())
      .map(function (d) { return d.name; })
      .filter(function (n) { return n && n.indexOf('CanariDB_') === 0 && n.indexOf('Mls') === -1; });
  };
`;

/**
 * Every row of `store`, across every app database, projected in the page by `project`.
 *
 * @param cx a connected client
 * @param store the object store's name
 * @param project a JS EXPRESSION over `r` (one row) returning what to keep, or `null` to drop it
 * @returns `{ rows, dbs }` - `dbs` names the databases that actually carried the store, because
 *   "no rows" and "no such store" are different answers and a check that cannot tell them apart is
 *   measuring nothing at all
 */
export async function fromStore(cx, store, project) {
  return JSON.parse(
    await evaluate(
      cx,
      `(async function () {
        ${PREAMBLE}
        var names = await appDatabases();
        var rows = [];
        var carried = [];
        for (var i = 0; i < names.length; i++) {
          var db = await openDb(names[i]);
          if (!db) continue;
          if (db.objectStoreNames.contains(${JSON.stringify(store)})) {
            carried.push(names[i]);
            var all = await new Promise(function (res) {
              var rq = db.transaction(${JSON.stringify(store)}, 'readonly').objectStore(${JSON.stringify(store)}).getAll();
              rq.onsuccess = function () { res(rq.result || []); };
              rq.onerror = function () { res([]); };
            });
            for (var j = 0; j < all.length; j++) {
              var r = all[j];
              var kept = (${project});
              if (kept !== null && kept !== undefined) rows.push(kept);
            }
          }
          db.close();
        }
        return JSON.stringify({ rows: rows, dbs: carried });
      })()`
    )
  );
}

/**
 * The stored conversation rows, as their clear metadata - `lifecycle` above all.
 *
 * `lifecycle` is the field every DEL and HEAL row turns on, and it has THREE states worth telling
 * apart: `'removed'` (retired - the peer deleted it and the row deliberately survives so the UI can
 * explain the absence), absent (an ordinary live conversation), and NO ROW AT ALL (purged, which is
 * what "Supprimer localement" does). The second and third are the pair a check most often gets
 * wrong, because both render as "not in the sidebar" once the row is retired and hidden - so the
 * absent case is reported as the string `'live'` rather than as `null`, and a missing row is the
 * absence of an entry rather than an entry saying nothing.
 *
 * @param cx a connected client
 * @param filter `{ name }` or `{ groupId }`, or nothing for every row
 */
export async function conversationRows(cx, filter = {}) {
  const name = filter.name ?? null;
  const groupId = filter.groupId ?? null;
  return fromStore(
    cx,
    'conversations',
    `(function () {
      var wantName = ${JSON.stringify(name)};
      var wantId = ${JSON.stringify(groupId)};
      var rowName = String(r.name != null ? r.name : (r.title != null ? r.title : (r.displayName != null ? r.displayName : '')));
      var rowId = String(r.groupId != null ? r.groupId : (r.id != null ? r.id : ''));
      if (wantName !== null && rowName !== wantName) return null;
      if (wantId !== null && rowId !== wantId) return null;
      return {
        name: rowName,
        groupId: rowId.slice(0, 8),
        fullGroupId: rowId,
        lifecycle: r.lifecycle != null ? r.lifecycle : 'live',
      };
    })()`
  );
}

/**
 * The MLS group id of the conversation named `name`, or null.
 *
 * NOT FROM THE URL, and this is the third file to say so because it cost a check a silent pass: the
 * app routes every conversation to a bare `/chat` and keeps the selection in a store, so
 * `location.pathname` carries no id at all and a UUID matcher over it returns null for every
 * conversation, always. `heal-w2.mjs` scoped a marker lookup by an id it had never had.
 */
export async function groupIdByName(cx, name) {
  const { rows } = await conversationRows(cx, { name });
  return rows.length ? rows[0].fullGroupId : null;
}

/**
 * Every queued outbound entry this client holds, as CLEAR columns, optionally narrowed to one group.
 *
 * WHY A STORE READ AND NOT A LOG MATCH, which is the whole reason this function exists.
 * `[OUTBOX] … permanent failure` says the queue GAVE UP on an entry; it does not say the entry is
 * gone, and those are two different states behind one line. A queue that logs a permanent failure
 * and keeps the row will retry it on every later flush for ever - which is precisely the silent
 * permanent pending DEL-2 exists to refuse. Only the store can answer that, so only the store is
 * believed, and the log stays what it is: evidence about the DECISION, not about the result.
 *
 * `frontend/src/lib/db/outboxCodec.ts` is what makes this readable without the device key: `id`,
 * `conversationId`, `sentAt`, `kind`, `status`, `attempts`, `lastAttemptAt` and `nextAttemptAt` are
 * kept in the clear so the queue can be sorted and re-keyed without the PIN. The payload - text,
 * reply reference, media bytes - is the encrypted half and is never touched here.
 */
export async function outboxRows(cx, groupId = null) {
  return fromStore(
    cx,
    'outbox',
    `(function () {
      var want = ${JSON.stringify(groupId)};
      if (want !== null && r.conversationId !== want) return null;
      return {
        id: String(r.id || '').slice(0, 8),
        conversationId: String(r.conversationId || '').slice(0, 8),
        kind: r.kind,
        status: r.status,
        attempts: r.attempts,
        sentAt: r.sentAt,
        lastAttemptAt: r.lastAttemptAt != null ? r.lastAttemptAt : null,
        nextAttemptAt: r.nextAttemptAt != null ? r.nextAttemptAt : null,
      };
    })()`
  );
}

/**
 * Watches one group's queue until it is EMPTY, and reports what it saw either way.
 *
 * THE RETURN IS NOT A BOOLEAN, deliberately. "Still queued after 90 s" and "gone after 12 s" are
 * both answers a check has to record, and collapsing them into `ok` would throw away the `attempts`
 * count - which is the number separating an entry the queue is still working on from one it has
 * parked for ever. `attemptsGrew` makes that distinction explicit: a queue that gave up LOUDLY and
 * stopped is not the same state as one quietly retrying at full backoff, and DEL-2's verdict turns
 * on which of the two happened.
 */
export async function awaitOutboxDrained(cx, groupId, { timeoutMs = 90_000, everyMs = 2000 } = {}) {
  const t0 = Date.now();
  const first = await outboxRows(cx, groupId);
  let last = first;
  while (Date.now() - t0 < timeoutMs) {
    if (last.rows.length === 0) break;
    await new Promise((r) => setTimeout(r, everyMs));
    last = await outboxRows(cx, groupId);
  }
  const sum = (s) => s.rows.reduce((n, r) => n + (Number(r.attempts) || 0), 0);
  return {
    drained: last.rows.length === 0,
    tookMs: Date.now() - t0,
    first: first.rows,
    last: last.rows,
    attemptsGrew: sum(last) > sum(first),
  };
}
