/**
 * Reconciles what two clients hold for the conversations they SHARE, message id by message id.
 *
 * This is the campaign's only direct instrument for WP-LOSS-1, whose loss is silent by
 * construction: the sender keeps its optimistic echo, the server returned 201, and only the
 * receiver's store is short. Nothing in either UI says so, so the evidence has to be a set
 * difference between the two stores.
 *
 * WHY THE STORE AND NOT THE SCREEN. This read markers out of the rendered pane until 2026-08-11,
 * and every one of that design's problems came from the pane being a WINDOW onto the history rather
 * than the history: it had to scroll, scrolling paged 50 rows at a time, so it needed a time window
 * to stay honest, a coverage proof that the window had been reached, and a minute per side - and on
 * the test DM, 1804 messages long, it read 60 of them and called the empty difference a success.
 * The store answers the same question exactly, in one read, for a conversation of any length.
 *
 * The rows are CIPHERTEXT at rest (`iv` + `cipherText`); `id` and `conversationId` are plaintext.
 * So this cannot say a message decrypted - it says both clients hold the same set, which is
 * precisely the claim WP-LOSS-1 is about. Rendering and decryption are asserted per check, by the
 * marker each one sends.
 *
 * Ids stay on this machine: only counts and, when they differ, how many differ, are printed.
 *
 *   node recon.mjs [--left 9224] [--right 9223] [--leftName W1] [--rightName W2]
 *   node recon.mjs --right 9333 --rightName A1 --rightUrl tauri.localhost      # against the phone
 *
 * `--rightUrl` is not optional for the phone and was missing from this line until 2026-08-15, which
 * cost a run: the WebView serves the app from `tauri.localhost`, so the default `canari-emse.fr`
 * filter matches no target there and `client()` dies naming what it did find. The flag existed and
 * was documented eighty lines below, where nobody about to type a command is looking.
 */
import { APP_TAB, client, evaluate } from './chat.mjs';
import { logcatSince, logcatReport } from './watch.mjs';

/**
 * Everything one client knows: which conversations it lists, and which message ids it holds.
 *
 * Membership comes from the `conversations` store rather than from the message rows, and that is
 * load-bearing. Keyed off the messages alone, a conversation the client is in but has received
 * NOTHING for has no rows at all, so it looks like a conversation the client is not in - and a
 * total loss, the worst case, would be the one case that reconciles silently.
 */
/**
 * THE SAME QUESTION, ASKED OF THE PHONE'S REAL STORE - the SQLite reader this file used to say it
 * did not have.
 *
 * Getting here needed the route to be chosen for a reason rather than for convenience. `adb pull`
 * works and is wrong: `canari_<uid>.db` is a REAL account's conversations, including people who
 * never agreed to be in a test harness, and copying it to this machine would be the credential leak
 * `mlsdb.mjs` refuses in its own header. There is no `sqlite3` on the device to query it in place
 * either. So the app is asked instead: `@tauri-apps/plugin-sql` already holds the file open, and its
 * IPC surface answers a SELECT from CDP - **nothing leaves the device but ids and counts**, and
 * `cipher_text` is never named in the query (it would be ciphertext if it were).
 *
 * The database is keyed `sqlite:canari_<userId>.db`. The id comes from the page's OWN
 * `mls_send_ledger_<userId>` key, never from an argument, so no account identifier is typed on a
 * command line or committed.
 *
 * Shape-compatible with the web snapshot on purpose: the comparison below must not know which side
 * it is reading, or the two paths drift and only one of them stays correct.
 */
const nativeSnapshot = async (cx) =>
  JSON.parse(
    await evaluate(
      cx,
      `(async function () {
        const invoke = (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
        if (!invoke) return JSON.stringify({ err: 'Tauri runtime without an invoke bridge' });
        var uid = null;
        for (var k = 0; k < localStorage.length; k++) {
          var key = localStorage.key(k);
          if (key && key.indexOf('mls_send_ledger_') === 0) { uid = key.slice('mls_send_ledger_'.length); break; }
        }
        if (!uid) return JSON.stringify({ err: 'no send ledger key, so no user id to build the db path from' });
        try {
          const db = 'sqlite:canari_' + uid + '.db';
          const cs = await invoke('plugin:sql|select', { db: db, query: 'SELECT id, name, lifecycle FROM conversations', values: [] });
          const ms = await invoke('plugin:sql|select', { db: db, query: 'SELECT id, conversation_id FROM messages', values: [] });
          const convos = {};
          for (const c of cs) { const id = String(c.id || ''); if (id) convos[id] = { lifecycle: c.lifecycle || 'active', name: String(c.name || '').slice(0, 24) }; }
          const ids = {};
          for (const m of ms) { const q = String(m.conversation_id || ''); if (q) (ids[q] = ids[q] || []).push(String(m.id)); }
          return JSON.stringify({ convos: convos, ids: ids, runtime: 'tauri', onScreen: document.querySelectorAll('aside button, nav button').length });
        } catch (e) {
          return JSON.stringify({ err: 'sql plugin refused: ' + String(e).slice(0, 200) });
        }
      })()`
    )
  );

const webSnapshot = async (cx) =>
  JSON.parse(
    await evaluate(
      cx,
      `(async function () {
        const open = (n) => new Promise((res) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => res(null); setTimeout(() => res(null), 4000); });
        const d = (await indexedDB.databases()).filter((x) => x.name.indexOf('CanariDB_') === 0 && x.name.indexOf('Mls') === -1)[0];
        if (!d) return JSON.stringify({ err: 'no store' });
        const db = await open(d.name);
        if (!db) return JSON.stringify({ err: 'store did not open' });
        const getAll = (store) => new Promise((res) => {
          if (!db.objectStoreNames.contains(store)) return res([]);
          const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
          rq.onsuccess = () => res(rq.result || []);
          rq.onerror = () => res([]);
        });
        const convos = {};
        for (const c of await getAll('conversations')) {
          const id = String(c.groupId || c.id || '');
          if (id) convos[id] = { lifecycle: c.lifecycle || 'active', name: String(c.name || '').slice(0, 24) };
        }
        const ids = {};
        const at = {};
        for (const m of await getAll('messages')) {
          const k = String(m.conversationId || '');
          if (!k) continue;
          (ids[k] = ids[k] || []).push(String(m.id));
          // THE ONLY PLAINTEXT DISCRIMINATOR A ROW HAS. A message row is id, conversationId,
          // timestamp, iv, cipherText and nothing else - sender, status and type live inside the
          // ciphertext - so the age of a differing row is the single fact this instrument can offer
          // about WHICH difference it found. It separates "the same four stale rows" from "four new
          // ones", and without it every later run re-derives that by hand.
          //
          // NO BACKTICKS IN THIS COMMENT, and that is not style: it is inside an evaluated template
          // literal, so a quoted identifier would close the literal and leave valid JavaScript that
          // throws at runtime. Rule 6 of the methodology, re-learnt here on 2026-08-16.
          if (m.timestamp) at[String(m.id)] = Number(m.timestamp);
        }
        db.close();
        return JSON.stringify({
          convos: convos,
          ids: ids,
          at: at,
          // THE TAURI CLIENTS DO NOT KEEP THEIR MESSAGES HERE. A1 carries a CanariDB_* database that
          // is present, openable, correctly shaped and PERMANENTLY EMPTY - a vestige of the shared
          // web code path - while the real store is SQLite behind Tauri. Read through this snapshot
          // alone, a perfectly healthy phone showing nine conversations reports zero of everything.
          // That does not fabricate a LOSS (nothing is shared, so the verdict is VACUOUS), but
          // VACUOUS alone sends the reader to look for a missing conversation instead of at the
          // wrong store. So the discriminator travels with the data.
          runtime: (typeof window.__TAURI__ !== 'undefined' || typeof window.__TAURI_INTERNALS__ !== 'undefined' || location.hostname.indexOf('tauri') !== -1) ? 'tauri' : 'web',
          onScreen: document.querySelectorAll('aside button, nav button').length
        });
      })()`
    )
  );

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
// The URL filter differs per client and is NOT cosmetic: a browser tab is picked by
// `canari-emse.fr`, while the phone's WebView serves the app from `tauri.localhost`, so the browser
// filter matches nothing there and `client()` would attach to whatever it found first.
const sides = [
  { label: flag('leftName', 'W1'), port: Number(flag('left', 9224)), url: flag('leftUrl', APP_TAB) },
  { label: flag('rightName', 'W2'), port: Number(flag('right', 9223)), url: flag('rightUrl', APP_TAB) },
];

/**
 * Reads whichever store this client actually keeps its messages in.
 *
 * The RUNTIME decides, not the port or the label: a device is native because the page says so, so a
 * client moved to another port, or a web tab pointed at `tauri.localhost`, cannot silently take the
 * wrong reader. The web snapshot is taken first because it also carries the discriminator, and it is
 * cheap on a device that has nothing in IndexedDB - which every native client does.
 */
const snapshot = async (cx) => {
  const web = await webSnapshot(cx);
  if (web.runtime !== 'tauri') return web;
  return { ...(await nativeSnapshot(cx)), viaIndexedDb: Object.keys(web.ids).length };
};

const t0 = Date.now();
const [L, R] = [
  await snapshot(await client(sides[0].port, sides[0].url, { focus: false })),
  await snapshot(await client(sides[1].port, sides[1].url, { focus: false })),
];
for (const [i, s] of [L, R].entries()) {
  if (s.err) {
    console.log(JSON.stringify({ verdict: 'VACUOUS', why: `${sides[i].label}: ${s.err}` }));
    process.exit(1);
  }
  // A native client that reports nothing after the SQL reader has run is a different claim from the
  // empty IndexedDB vestige this used to refuse on: the store it lives in was asked and answered
  // nothing. That IS a device with no history, and it must not be reported as a reconciliation.
  if (
    s.runtime === 'tauri' &&
    Object.keys(s.convos).length === 0 &&
    Object.keys(s.ids).length === 0
  ) {
    console.log(
      JSON.stringify({
        verdict: 'EMPTY NATIVE STORE',
        why: `${sides[i].label} is a Tauri client and its SQLite store returned no conversations and no messages, while the app is showing ${s.onScreen} sidebar entries. That is not the IndexedDB vestige (which held ${s.viaIndexedDb ?? 0} conversations either way) - it is the real store answering empty.`,
      })
    );
    process.exit(2);
  }
}

const shared = [];
const oneSided = [];
for (const id of new Set([...Object.keys(L.convos), ...Object.keys(R.convos)])) {
  const l = L.convos[id];
  const r = R.convos[id];
  // A conversation one side has RETIRED is expected to diverge - that is what deleting it means.
  if (!l || !r || l.lifecycle === 'removed' || r.lifecycle === 'removed') {
    oneSided.push(`${id.slice(0, 8)} ${l ? `${sides[0].label}:${l.lifecycle}` : '-'} ${r ? `${sides[1].label}:${r.lifecycle}` : '-'}`);
    continue;
  }
  const A = new Set(L.ids[id] || []);
  const B = new Set(R.ids[id] || []);
  const onlyA = [...A].filter((x) => !B.has(x));
  const onlyB = [...B].filter((x) => !A.has(x));
  const row = {
    convo: id.slice(0, 8),
    [sides[0].label]: A.size,
    [sides[1].label]: B.size,
    [`only${sides[0].label}`]: onlyA.length,
    [`only${sides[1].label}`]: onlyB.length,
  };
  // WHEN it differs, never WHICH. Ids stay on this machine; an age does not identify anybody and is
  // the difference between a finding and a number. A native side supplies no `at` map, so the field
  // is absent rather than zero - "not measured" and "brand new" must not share a spelling.
  const ages = (list, snap) => {
    const ts = list.map((x) => (snap.at || {})[x]).filter((t) => typeof t === 'number' && t > 0);
    if (!ts.length) return undefined;
    const mins = (t) => Math.round((Date.now() - t) / 60000);
    return { newestMinOld: mins(Math.max(...ts)), oldestMinOld: mins(Math.min(...ts)), dated: ts.length };
  };
  const ageA = onlyA.length ? ages(onlyA, L) : undefined;
  const ageB = onlyB.length ? ages(onlyB, R) : undefined;
  if (ageA) row[`only${sides[0].label}Age`] = ageA;
  if (ageB) row[`only${sides[1].label}Age`] = ageB;
  shared.push(row);
}

const differing = shared.filter(
  (s) => s[`only${sides[0].label}`] > 0 || s[`only${sides[1].label}`] > 0
);
const verdict = shared.length === 0 ? 'VACUOUS' : differing.length ? 'LOSS' : 'RECONCILED';

console.log(
  JSON.stringify(
    {
      verdict,
      // VACUOUS means nothing was compared - no conversation appeared on both sides. It is not a
      // pass and it exits non-zero, because an empty difference over an empty set says nothing.
      shared,
      differing,
      oneSided,
      // CLASSIFIED, and deliberately NOT gating: this instrument's verdict is a comparison of two
      // stores, and a noisy phone does not make two matching stores differ. What the classifier adds
      // over the keyword grep it replaces is that a line here is now either NAMED or `unexplained` -
      // and an unexplained line beside a `LOSS` is the first place to look for why.
      phone: (({ clean, severe, errors, unexplained, notable }) => ({
        clean,
        severe,
        errors,
        unexplained,
        notable: notable.slice(0, 10),
      }))(logcatReport(await logcatSince(t0), 'A1')),
    },
    null,
    1
  )
);
process.exit(verdict === 'RECONCILED' ? 0 : 1);
