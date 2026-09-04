/**
 * The Graine seed store as the CLIENT holds it, read from the browser's own IndexedDB.
 *
 * THE COUNTERPART OF `grainedb.mjs`, AND THE ANSWER TO A DIFFERENT QUESTION. `grainedb.mjs` reads
 * the SERVER: who the server would fan a seed frame out to, which is an intent. This reads what a
 * device actually kept, which is what "they can still read what they already had" is made of - and
 * no screen can show it. A member removed from a private salon loses the salon from their sidebar,
 * so counting messages in a pane after a removal measures the purge, not the seeds: COMM-10 spent
 * every run asserting the wrong noun and calling the product wrong for it.
 *
 * NOTHING HERE DECRYPTS, and nothing here needs to. A row is written under `sessionId` with
 * `channelId` and `workspaceId` as plain indexes - they have to be plain, an index cannot be sealed -
 * while the seed itself stays encrypted under the device key. Retention is a question about rows;
 * READING one is a question for the app, which the transcript already answers.
 *
 * READ-ONLY, deliberately: the store holds the only key material the server cannot re-serve, and a
 * harness that can write it could destroy history no peer still has.
 *
 *   import { seedRows, seedsForChannel } from './grainestore.mjs';
 *   const before = await seedsForChannel(w2, channelId);
 */
import { evaluate } from '../chat.mjs';

/**
 * The name of the Canari database this client holds, or null when there is none.
 *
 * RESOLVED, NEVER BUILT. The name carries the user id (`CanariDB_<userId>`), and a check that spelt
 * one would be asserting which account a browser profile is logged into - a fact that belongs in
 * `names.mjs` and would be wrong the first time a profile is re-enrolled. `indexedDB.databases()`
 * says what is actually there.
 *
 * More than one is an ERROR rather than a choice: two Canari databases in one profile means two
 * accounts have used it, and picking either would silently answer for the wrong one.
 */
const DB_NAME = `(async function () {
  if (!indexedDB.databases) return { error: 'this browser cannot enumerate databases' };
  var all = await indexedDB.databases();
  var mine = all.map(function (d) { return d.name; }).filter(function (n) {
    return typeof n === 'string' && n.indexOf('CanariDB_') === 0;
  });
  if (mine.length === 0) return { error: 'no CanariDB in this profile' };
  if (mine.length > 1) return { error: 'several CanariDB in this profile: ' + mine.join(', ') };
  return { name: mine[0], userId: mine[0].slice('CanariDB_'.length) };
})()`;

/**
 * Every Graine row this device holds, as facts about retention only.
 *
 * The sealed seed is reported as a LENGTH, never as its bytes: a run's log and its `results.ndjson`
 * are read by people and one of them lives in a public repository. A length separates "a row with a
 * seed in it" from "a row whose seed was blanked", which is the whole distinction retention turns
 * on, and it carries nothing that could open a message.
 *
 * @param {object} cx the client to read
 * @param {{ channelId?: string, workspaceId?: string }} [filter] narrow to one salon or community
 * @returns {Promise<Array<{sessionId: string, channelId: string, workspaceId: string, senderId: string, firstIndex: number, createdAt: number, seedBytes: number, mine: boolean}>>}
 */
export async function seedRows(cx, filter = {}) {
  const out = await evaluate(
    cx,
    `(async function () {
      var db = await ${DB_NAME};
      if (db.error) return JSON.stringify({ error: db.error });
      var open = indexedDB.open(db.name);
      var handle = await new Promise(function (resolve, reject) {
        open.onsuccess = function () { resolve(open.result); };
        open.onerror = function () { reject(open.error); };
        // OPENED WITHOUT A VERSION, so this never triggers an upgrade. Naming the app's version here
        // would make the harness the thing that migrates the user's database, and naming a lower one
        // fails outright - both are the reader changing what it reads.
        open.onupgradeneeded = function () { reject(new Error('the store is not there to read yet')); };
      });
      if (!handle.objectStoreNames.contains('graine')) {
        handle.close();
        return JSON.stringify({ error: 'this database has no graine store' });
      }
      var rows = await new Promise(function (resolve, reject) {
        var req = handle.transaction('graine', 'readonly').objectStore('graine').getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
      handle.close();
      var me = String(db.userId || '').toLowerCase();
      return JSON.stringify({ rows: rows.map(function (r) {
        // THE SEED IS SEALED AT REST and there is no seedB64 on disk - the row is clear columns
        // plus a cipherText/iv pair under the device key. Reading a length off the field the
        // decoded object has, rather than the one the ROW has, reported 0 bytes for every row and
        // turned COMM-10 VACUOUS on a device that was holding exactly what it should.
        var sealed = r.cipherText;
        var bytes = 0;
        if (typeof sealed === 'string') bytes = sealed.length;
        else if (sealed && typeof sealed.byteLength === 'number') bytes = sealed.byteLength;
        else if (sealed && typeof sealed.length === 'number') bytes = sealed.length;
        var sender = String(r.senderId || '').toLowerCase();
        return {
          sessionId: String(r.sessionId || ''),
          channelId: String(r.channelId || ''),
          workspaceId: String(r.workspaceId || ''),
          senderId: sender,
          firstIndex: typeof r.firstIndex === 'number' ? r.firstIndex : null,
          createdAt: typeof r.createdAt === 'number' ? r.createdAt : null,
          sealedBytes: bytes,
          // A session this device MINTED, which is a different thing to have kept than one it was
          // GIVEN. Two independent marks, because each has a hole: sentCount is what makes a
          // session outbound but is absent on rows written before the column existed, and the
          // sender is authoritative but only because the database name carries whose it is.
          mine: (r.sentCount !== undefined && r.sentCount !== null) || (!!me && sender === me)
        };
      }) });
    })()`
  );
  const parsed = JSON.parse(out);
  if (parsed.error) throw new Error(`grainestore: ${parsed.error}`);
  return parsed.rows.filter(
    (r) =>
      (!filter.channelId || r.channelId === filter.channelId) &&
      (!filter.workspaceId || r.workspaceId === filter.workspaceId)
  );
}

/**
 * The seeds this device holds for one salon, and whether any of them were GIVEN to it.
 *
 * `received` is the figure COMM-10 turns on: a device that minted every session it holds has kept
 * nothing it was sent, and a retention claim built on the raw count would pass on a salon the peer
 * had only ever written to.
 *
 * @param {object} cx the client to read
 * @param {string} channelId the salon
 * @returns {Promise<{held: number, received: number, sessions: string[]}>}
 */
export async function seedsForChannel(cx, channelId) {
  if (!channelId) throw new Error('seedsForChannel needs a channel id');
  const rows = await seedRows(cx, { channelId });
  return {
    held: rows.length,
    received: rows.filter((r) => !r.mine && r.sealedBytes > 0).length,
    sessions: rows.map((r) => r.sessionId.slice(0, 8)),
  };
}
