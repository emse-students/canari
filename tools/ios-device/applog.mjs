#!/usr/bin/env bun
/**
 * Reads the in-app log of the iPhone's Canari install FROM THE WORKSTATION, console lines included.
 *
 *   bun tools/ios-device/applog.mjs <out.txt> [--keep <dir>] [--db <hash>]
 *
 * WHY: a store (TestFlight) build's WebView is not inspectable and the syslog carries no page
 * console, so a reading that needs a `[CALL_REPORT]`, `[JOIN_PUSH]` or `[WS]` line had no way out
 * but the Settings > About export, whose Files Quick Look hangs on a 2 MB text. The log is ALSO
 * persisted by `appLog.ts` in IndexedDB (`CanariDBLog`, a ring bounded at 2 MB of text), which lives
 * in the app container that `house_arrest` serves: this pulls the sqlite file with its WAL, and
 * decodes the chunks. Read 2026-11-16, 1.7.0-alpha.2 on the iPhone 12.
 *
 * LIMITS: the ring is written in batches, so the NEWEST few minutes may not have reached the disk
 * yet (a send loop of 34 messages left 4 of them in the file); lines are stamped in the PHONE's
 * local time. Nothing here sends the log anywhere. Needs `python -m pymobiledevice3` on the PATH.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const bundle = 'fr.emse.canari';
const py = process.env.PYMOBILEDEVICE3 ? [process.env.PYMOBILEDEVICE3] : ['python', '-W', 'ignore', '-m', 'pymobiledevice3'];
const out = process.argv[2];
if (!out) throw new Error('usage: applog.mjs <out.txt> [--keep <dir>] [--db <hash>]');
const keep = process.argv.includes('--keep') ? process.argv[process.argv.indexOf('--keep') + 1] : null;
const dir = keep ?? mkdtempSync(join(tmpdir(), 'canari-applog-'));
mkdirSync(dir, { recursive: true });

/** Runs one pymobiledevice3 command and returns its stdout. */
const run = (...args) => {
  const r = Bun.spawnSync([...py, ...args], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  return { ok: r.exitCode === 0, out: new TextDecoder().decode(r.stdout) };
};

// The container paths are hashed: find the website-data root, then the origin directory whose
// database is named CanariDBLog (one sqlite file per IndexedDB database).
const shell = (cmds) => {
  const r = Bun.spawnSync([...py, 'apps', 'afc', bundle], { stdin: new TextEncoder().encode(cmds + '\nexit\n'), env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  return new TextDecoder().decode(r.stdout);
};
const ls = (p) => shell(`ls ${p}`).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9_-]{20,}$/.test(l));
const root = 'Library/WebKit/WebsiteData/Default';
const [h1] = ls(root);
const [h2] = ls(`${root}/${h1}`);
const idb = `${root}/${h1}/${h2}/IndexedDB`;
let found = null;
const pull = (h, f) => {
  mkdirSync(join(dir, h), { recursive: true });
  run('apps', 'pull', bundle, `${idb}/${h}/${f}`, join(dir, h, f));
};
/** True when this directory's database is the log's (named in its IDBDatabaseInfo, UTF-16). */
const isLog = (h) => {
  try {
    const db = new Database(join(dir, h, 'IndexedDB.sqlite3'), { readonly: true });
    const name = db.query("select value from IDBDatabaseInfo where key='DatabaseName'").get()?.value;
    db.close();
    return Buffer.from(name).toString('utf16le') === 'CanariDBLog';
  } catch {
    return false; // not a readable database, try the next one
  }
};
// `--db <hash>` skips the scan: the directory name is stable for an install (about 3 s per candidate otherwise).
const given = process.argv.includes('--db') ? process.argv[process.argv.indexOf('--db') + 1] : null;
for (const h of given ? [given] : ls(idb)) {
  pull(h, 'IndexedDB.sqlite3');
  if (isLog(h)) {
    found = h;
    pull(h, 'IndexedDB.sqlite3-wal');
    pull(h, 'IndexedDB.sqlite3-shm');
    console.log(`log database: ${h} (pass --db ${h} next time)`);
    break;
  }
}
if (!found) throw new Error('CanariDBLog not found in the app container');

const stamp = /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [LIWE] /g;
const count = (s) => (s.match(stamp) ?? []).length;
const db = new Database(join(dir, found, 'IndexedDB.sqlite3'), { readonly: true });
const lines = [];
for (const { value } of db.query('select value from Records order by rowid').all()) {
  const v = Buffer.from(value);
  let best = '';
  for (const p of [0, 1]) {
    const t = v.subarray(p, v.length - ((v.length - p) % 2)).toString('utf16le');
    if (count(t) > count(best)) best = t;
  }
  if (count(best) < 5) { const t = v.toString('latin1'); if (count(t) > count(best)) best = t; }
  for (const l of best.split('\n')) if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [LIWE] /.test(l)) lines.push(l);
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`${lines.length} lines -> ${out}`);
