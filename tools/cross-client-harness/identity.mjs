#!/usr/bin/env node
/**
 * Fingerprints each client's IDENTITY - the pre-flight gate that says the two Chrome profiles are
 * still the devices the campaign enrolled.
 *
 *   node identity.mjs [--ports 9224,9223,9333]
 *
 * `chrome-w1` and `chrome-w2` ARE W1 and W2: their profile directory holds the MLS identity, the
 * history and the login, so a profile silently recreated (a crash, a wrong `--user-data-dir`, a
 * cleaner) gives a client that logs in, renders, and is a DIFFERENT DEVICE - which reads downstream
 * as history loss on every check at once. The cheapest way to notice is to fingerprint before the
 * run and compare with the line the last run printed.
 *
 * PREFIXES ONLY, NEVER THE WHOLE ID. This repository is public and the campaign's own rule is that
 * no device id, user id or group id lands in a file it can reach. Eight characters is enough to
 * compare two runs and useless to anyone else; it is also what is matched against the gateway's
 * `user:online:` presence keys.
 *
 * ON A TAURI CLIENT IT REFUSES the store questions rather than answering 0. The phone's real store
 * is SQLite behind the native layer, while a vestigial and permanently EMPTY `CanariDB_*` sits in
 * its WebView - reading through it reports a healthy phone as holding nothing at all, which is the
 * fault `recon.mjs` was rewritten to stop making.
 */
import { client, evaluate } from './chat.mjs';
import { PORTS } from './names.mjs';

const flag = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? f : process.argv[i + 1];
};
const wanted = flag('ports', null)
  ?.split(',')
  .map((p) => Number(p.trim()))
  .filter(Boolean);

/**
 * Everything is derived from what is ACTUALLY THERE - the saved user, then the databases the
 * browser enumerates - never from a name built out of the documented pattern. `indexedDB.open`
 * CREATES when the name is absent, so a constructed guess does not fail: it manufactures an empty
 * database inside the profile under test and then reports the real one missing.
 */
const PROBE = `(async function () {
  const tauri = !!window.__TAURI_INTERNALS__ || location.hostname === 'tauri.localhost';
  const cut = (s) => (typeof s === 'string' && s.length > 8 ? s.slice(0, 8) : s || null);

  const deviceKey = Object.keys(localStorage).find((k) => k.indexOf('mls_device_id_') === 0) || '';
  const userId = deviceKey.slice('mls_device_id_'.length) || null;
  const out = {
    runtime: tauri ? 'tauri' : 'web',
    user: cut(userId),
    device: cut(deviceKey ? localStorage.getItem(deviceKey) : null),
    mlsBytes: null,
    conversations: null,
    messages: null,
  };

  if (tauri || !userId || !indexedDB.databases) return JSON.stringify(out);

  const names = (await indexedDB.databases()).map((d) => d.name).filter(Boolean);
  const open = (name) =>
    new Promise((resolve) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    });
  const count = (db, store) =>
    new Promise((resolve) => {
      if (!db || !db.objectStoreNames.contains(store)) return resolve(null);
      const q = db.transaction(store, 'readonly').objectStore(store).count();
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => resolve(null);
    });

  const mlsName = names.find((n) => n.indexOf('CanariDBMls_') === 0);
  if (mlsName) {
    const db = await open(mlsName);
    const bytes = await new Promise((resolve) => {
      if (!db || !db.objectStoreNames.contains('state')) return resolve(null);
      const q = db.transaction('state', 'readonly').objectStore('state').getAll();
      q.onsuccess = () =>
        resolve(
          q.result.reduce((n, v) => {
            const blob = v && (v.state || v.value || v);
            return n + (blob && blob.byteLength ? blob.byteLength : 0);
          }, 0)
        );
      q.onerror = () => resolve(null);
    });
    out.mlsBytes = bytes;
    db?.close();
  }

  const storeName = names.find((n) => n.indexOf('CanariDB_') === 0);
  if (storeName) {
    const db = await open(storeName);
    out.conversations = await count(db, 'conversations');
    out.messages = await count(db, 'messages');
    db?.close();
  }
  return JSON.stringify(out);
})()`;

for (const [label, port] of Object.entries(PORTS)) {
  if (wanted && !wanted.includes(port)) continue;
  try {
    const cx = await client(port, null, { focus: false });
    const seen = JSON.parse(await evaluate(cx, PROBE));
    cx.close();
    const store =
      seen.runtime === 'tauri'
        ? 'store: NOT VISIBLE (SQLite behind the native layer)'
        : `mls=${seen.mlsBytes} bytes, ${seen.conversations} conversation(s), ${seen.messages} message(s)`;
    console.log(`${label} (${port}) ${seen.runtime} user=${seen.user} device=${seen.device} ${store}`);
  } catch (e) {
    console.log(`${label} (${port}) UNREACHABLE: ${e.message}`);
  }
}
