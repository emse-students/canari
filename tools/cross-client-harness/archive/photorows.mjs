#!/usr/bin/env node
/**
 * READS THE PHONE'S OWN MESSAGE TABLE, because the pane cannot be counted.
 *
 *   bun archive/photorows.mjs [--group <8-hex-prefix>]
 *
 * `photoprev.mjs` counts what the transcript RENDERS, and `ChatArea` keeps a sliding window - so
 * "six pictures and one caption" is a statement about a window, not about the device. The only place
 * the question "how many rows does this conversation hold, and which of them is a notification
 * caption" has an answer is the `messages` table, reached through the app's own SQL plugin in its
 * own WebView.
 *
 * THE BODIES ARE ENCRYPTED AT REST and this does not decrypt them - the device key lives in the
 * app's memory and nowhere this can reach. What it reads is the SHAPE: one row per id, its
 * conversation, its timestamp, and the size of its ciphertext. A notification caption is a handful
 * of bytes and a media envelope is hundreds, so the histogram alone separates them, and the row
 * COUNT against the number of sends settles the one question that matters - whether a stuck caption
 * is a row that was never upgraded or a SECOND row beside the picture.
 */
import { APP_TAB, client, evaluate } from '../chat.mjs';
import * as phone from '../phone.mjs';
import { PORTS } from '../names.mjs';

phone.useDevice('A1');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const groupPrefix = opt('group', null);
const port = Number(opt('port', PORTS.A1));
const match = port === PORTS.A1 ? 'tauri.localhost' : APP_TAB;

const cx = await client(port, match, { focus: false });

/**
 * One `SELECT` through the app's own loaded SQLite handle.
 *
 * `plugin:sql|select` is what `@tauri-apps/plugin-sql` calls under `Database.select`, and it takes
 * the SAME `db` string the app loaded - so this reads the live handle rather than opening a second
 * one, which on a WAL database would be a different view.
 */
async function select(db, query, values = []) {
  const raw = await evaluate(
    cx,
    `(async function () {
       try {
         var rows = await window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
           db: ${JSON.stringify(db)},
           query: ${JSON.stringify(query)},
           values: ${JSON.stringify(values)}
         });
         return JSON.stringify({ rows: rows });
       } catch (e) {
         return JSON.stringify({ threw: String(e) });
       }
     })()`,
    { awaitPromise: true }
  );
  const out = JSON.parse(raw);
  if (out.threw) throw new Error(`${query.slice(0, 60)}...: ${out.threw}`);
  return out.rows;
}

// THE DATABASE IS NAMED AFTER THE ACCOUNT, AND THE PHONE IS ASKED FOR THE NAME RATHER THAN THE
// ACCOUNT. Reading it from `/api/users/me` was tried first and cannot work here: this WebView keeps
// no refresh COOKIE - on `tauri://localhost` WKWebView and the Android engine drop it, and the
// client carries `X-Canari-Refresh` instead - so a credentialed fetch mints nothing and the estate
// answers 401. The file name on disk is the same fact, needs no session, and works offline.
const listed = phone
  .adb(['shell', 'run-as', phone.PKG, 'ls'], 30_000)
  .split(/\s+/)
  .map((l) => l.trim());
const dbFile = listed.find((l) => /^canari_[0-9a-f]{64}\.db$/.test(l));
if (!dbFile) {
  throw new Error(
    `no canari_<account>.db under the app's private directory - it holds: ${listed.filter(Boolean).join(' ')}`
  );
}
const db = `sqlite:${dbFile}`;
console.log(`[rows] ${db}`);

const convos = await select(
  db,
  'SELECT conversation_id, COUNT(*) AS n FROM messages GROUP BY conversation_id ORDER BY n DESC'
);
console.log('[rows] conversations by message count:');
for (const c of convos) console.log(`  ${String(c.conversation_id).slice(0, 8)}  ${c.n}`);

const target =
  groupPrefix ??
  String(convos.find((c) => !String(c.conversation_id).includes('::'))?.conversation_id ?? '');
const full = String(
  convos.find((c) => String(c.conversation_id).startsWith(target))?.conversation_id ?? target
);

const rows = await select(
  db,
  `SELECT id, conversation_id, timestamp, LENGTH(cipher_text) AS bytes
     FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC`,
  [full]
);
console.log(`\n[rows] ${rows.length} row(s) in ${full.slice(0, 8)} - id, time, ciphertext bytes`);
for (const r of rows) {
  const t = new Date(Number(r.timestamp)).toISOString().slice(11, 19);
  console.log(`  ${String(r.id).slice(0, 8)}  ${t}  ${String(r.bytes).padStart(5)}`);
}

cx.close();
process.exit(0);
