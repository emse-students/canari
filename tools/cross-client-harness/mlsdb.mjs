#!/usr/bin/env node
/**
 * Snapshot / restore of the browser's MLS state, which is what makes the HEAL phase possible at all.
 *
 * The break these checks need is a RATCHET REWIND done deliberately: restore an older copy of the
 * MLS store over the current one, exactly the state a reload used to leave behind (WP-LOSS-1). On
 * the web that state is IndexedDB, not `mls.bin`.
 *
 * Everything is done from INSIDE the page. The bytes never leave the browser except as a length and
 * a digest: this is live key material for a real account, and a harness that writes it to disk in
 * the scratchpad would be a credential leak wearing a debugging hat. The snapshot is kept in the
 * page, in a separate IndexedDB database - see the DURABLE block for why that home and not a tab.
 *
 *   node mlsdb.mjs --port 9224 list        - the databases and their stores
 *   node mlsdb.mjs --port 9224 snapshot    - take one (in-page)
 *   node mlsdb.mjs --port 9224 restore     - put it back
 *   node mlsdb.mjs --port 9224 digest      - what is there right now
 */
import { client, evaluate } from './chat.mjs';

const arg = (name, dflt) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt;
const port = Number(arg('--port', 9224));
const cmd = process.argv.find((a) => !a.startsWith('--') && !/node(\.exe)?$/.test(a) && !a.endsWith('mlsdb.mjs') && a !== String(port)) ?? 'list';

const cx = await client(port, 'canari-emse.fr', { focus: false });

/** Opens a database at its CURRENT version - never bump it, an upgrade would rewrite the schema. */
const OPEN = `function openDb(name) {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(name);
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
    r.onblocked = function () { rej(new Error('blocked')); };
  });
}`;

const READ_ALL = `function readAll(db, store) {
  return new Promise(function (res, rej) {
    var tx = db.transaction(store, 'readonly');
    var os = tx.objectStore(store);
    var keys = os.getAllKeys();
    var vals = os.getAll();
    tx.oncomplete = function () {
      res(keys.result.map(function (k, i) { return { key: k, value: vals.result[i] }; }));
    };
    tx.onerror = function () { rej(tx.error); };
  });
}`;

/** Byte length plus an FNV-1a digest: enough to tell two states apart, never enough to reveal one. */
const DIGEST = `function digest(v) {
  var bytes = null;
  if (v instanceof Uint8Array) bytes = v;
  else if (v instanceof ArrayBuffer) bytes = new Uint8Array(v);
  else if (v && v.buffer instanceof ArrayBuffer) bytes = new Uint8Array(v.buffer);
  else { try { bytes = new TextEncoder().encode(JSON.stringify(v)); } catch (e) { return { len: -1, hash: 'unserialisable' }; } }
  var h = 0x811c9dc5;
  for (var i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return { len: bytes.length, hash: (h >>> 0).toString(16) };
}`;

/**
 * The snapshot, kept somewhere a NAVIGATION does not destroy.
 *
 * It lived in `window.__mlsSnapshot`, which is a tab lifetime - so every check built on it had to
 * forbid the device under test from navigating between snapshot and restore. That constraint is
 * what broke HEAL-W2: W1 had to sit on a stale `/chat` for minutes, and a group row on that page
 * would not open however many times it was clicked, while the identical click on a freshly loaded
 * page opened it immediately. Forbidding navigation to protect the snapshot cost more than it saved.
 *
 * A separate IndexedDB database is the right home: it survives navigation and reload, and the
 * SECURITY POSTURE IS UNCHANGED - these bytes are already at rest in IndexedDB as `mls_autosave`,
 * this only copies them beside it. They still never leave the browser, and nothing is written to
 * the scratchpad, which would be a credential leak wearing a debugging hat.
 */
const DURABLE = `
var SNAP_DB = 'CanariHarnessSnapshot';
function openSnapDb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(SNAP_DB, 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('snap'); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
async function saveDurable(snap, at) {
  var db = await openSnapDb();
  await new Promise(function (res, rej) {
    var tx = db.transaction('snap', 'readwrite');
    tx.objectStore('snap').put({ snap: snap, at: at }, 'current');
    tx.oncomplete = function () { res(); };
    tx.onerror = function () { rej(tx.error); };
  });
  db.close();
}
async function loadDurable() {
  var db = await openSnapDb();
  var out = await new Promise(function (res, rej) {
    var tx = db.transaction('snap', 'readonly');
    var g = tx.objectStore('snap').get('current');
    tx.oncomplete = function () { res(g.result || null); };
    tx.onerror = function () { rej(tx.error); };
  });
  db.close();
  return out || { snap: null, at: null };
}`;

const run = (body) => evaluate(cx, `(async function () { ${OPEN} ${READ_ALL} ${DIGEST} ${DURABLE} ${body} })()`, true);

if (cmd === 'list') {
  console.log(
    await run(`
      var out = [];
      var list = await indexedDB.databases();
      for (var i = 0; i < list.length; i++) {
        var db = await openDb(list[i].name);
        out.push({ name: list[i].name, version: db.version, stores: [].slice.call(db.objectStoreNames) });
        db.close();
      }
      return JSON.stringify(out, null, 1);`)
  );
} else if (cmd === 'digest' || cmd === 'snapshot') {
  const take = cmd === 'snapshot';
  console.log(
    await run(`
      var list = (await indexedDB.databases()).filter(function (d) { return /^CanariDBMls/.test(d.name); });
      var report = [];
      var snap = {};
      for (var i = 0; i < list.length; i++) {
        var db = await openDb(list[i].name);
        var stores = [].slice.call(db.objectStoreNames);
        for (var s = 0; s < stores.length; s++) {
          var rows = await readAll(db, stores[s]);
          report.push({ db: list[i].name, store: stores[s], rows: rows.length,
                        entries: rows.map(function (r) { var d = digest(r.value); return { key: String(r.key).slice(0, 40), len: d.len, hash: d.hash }; }) });
          if (${take}) snap[list[i].name + '::' + stores[s]] = rows;
        }
        db.close();
      }
      if (${take}) {
        window.__mlsSnapshot = snap;
        window.__mlsSnapshotAt = new Date().toISOString();
        await saveDurable(snap, window.__mlsSnapshotAt);
      }
      var at = window.__mlsSnapshotAt || (await loadDurable()).at || null;
      return JSON.stringify({ takenAt: at, report: report }, null, 1);`)
  );
} else if (cmd === 'restore') {
  console.log(
    await run(`
      // Prefer the in-tab copy, fall back to the durable one - a reload or a navigation between
      // snapshot and restore is now allowed, and that is exactly when the window copy is gone.
      var durable = await loadDurable();
      var snapshot = window.__mlsSnapshot || durable.snap;
      var takenAt = window.__mlsSnapshotAt || durable.at;
      if (!snapshot) return JSON.stringify({ error: 'no snapshot in this tab or in durable storage' });
      var done = [];
      var keys = Object.keys(snapshot);
      for (var i = 0; i < keys.length; i++) {
        var parts = keys[i].split('::');
        var db = await openDb(parts[0]);
        var rows = snapshot[keys[i]];
        await new Promise(function (res, rej) {
          var tx = db.transaction(parts[1], 'readwrite');
          var os = tx.objectStore(parts[1]);
          os.clear();
          for (var r = 0; r < rows.length; r++) {
            if (os.keyPath === null || os.keyPath === undefined) os.put(rows[r].value, rows[r].key);
            else os.put(rows[r].value);
          }
          tx.oncomplete = function () { res(); };
          tx.onerror = function () { rej(tx.error); };
        });
        db.close();
        done.push({ target: keys[i], rows: rows.length });
      }
      return JSON.stringify({ restored: done, from: takenAt }, null, 1);`)
  );
} else {
  console.log(`unknown command: ${cmd}`);
  process.exit(2);
}
process.exit(0);
