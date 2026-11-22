/**
 * WHAT A BROWSER KILL MAY TAKE FROM A PROFILE, AND HOW TO CHECK BEFORE AND AFTER - the helpers the KILL
 * rows (`archive/kill.mjs`, `archive/reopen.mjs`) and TAB-3b (`archive/tab3b.mjs`) share.
 *
 * A hard kill (`killBrowser`) is a crash: Chrome commits its cookie store lazily (~30 s), so a kill
 * right after a rotation relaunches without the newest `canari_refresh`, and a kill can take the
 * profile's storage with it. A row that relaunches after a kill must therefore (1) wait out the
 * cookie commit window (`awaitCookieCommitted`, a clock bound, not a proof; the proof is the post-kill read), (2) read the jar before the kill and the file after it
 * (`refreshInMemory`, `refreshOnDisk`, judged by `refreshCookieAtKill`), and (3) probe the revived
 * page's storage (`quotaDbOf`, `STORAGE_PROBE`, `siteCookies`, judged by `storageLost`). A signed-out
 * seat after a kill that fails any of these is a RIG casualty, never a product FAIL.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { chromeExpiresToUnixS, cookieCommitWaitMs } from './killrows.mjs';
import { BROWSERS } from './launch.mjs';
import { SITE } from './site.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when the browser profile still holds its quota database - without it Chrome serves no storage. */
export const quotaDbOf = (device) => existsSync(join(BROWSERS[device.toLowerCase()].profile, 'Default', 'WebStorage', 'QuotaManager'));

/** The error each storage call throws on this page, or null for each that answers. */
export const STORAGE_PROBE = `(async () => {
  const err = async (f) => { try { await f(); return null; } catch (e) { return String(e).slice(0, 120); } };
  return { idb: await err(() => indexedDB.databases()), estimate: await err(() => navigator.storage.estimate()) };
})()`;

/** How many cookies the browser holds for the site - read from the browser's jar, not the page. */
export const siteCookies = async (cx) => (await cx.send('Network.getCookies', { urls: [SITE] })).cookies?.length ?? null;

/** The refresh cookie's expiry in the browser's MEMORY (Unix seconds), or null when it holds none. */
export async function refreshInMemory(cx) {
  const host = new URL(SITE).hostname;
  const { cookies } = await cx.send('Network.getAllCookies');
  return cookies.find((c) => c.name === 'canari_refresh' && c.domain === host)?.expires ?? null;
}

/**
 * The refresh cookie's expiry in the profile's cookie FILE (Unix seconds), or null when the file
 * holds none. Read only while the browser is dead: Chrome keeps the file locked while it runs. It is
 * read from a copy so that nothing this rig opens is ever the browser's own file.
 */
export function refreshOnDisk(device) {
  const host = new URL(SITE).hostname;
  const dir = mkdtempSync(join(tmpdir(), 'canari-jar-'));
  try {
    const copy = join(dir, 'Cookies');
    copyFileSync(join(BROWSERS[device.toLowerCase()].profile, 'Default', 'Network', 'Cookies'), copy);
    const db = new Database(copy, { readonly: true });
    try {
      const row = db.query("SELECT expires_utc FROM cookies WHERE name = 'canari_refresh' AND host_key = ?").get(host);
      return chromeExpiresToUnixS(row?.expires_utc ?? null);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Waits out Chrome's cookie commit window (`cookieCommitWaitMs`) after the newest rotation, so a
 * browser kill SHOULD relaunch on the CURRENT token. A clock bound, not a proof: `refreshOnDisk` read
 * after the kill is the proof. Returns how long it waited; throws when the browser holds no refresh
 * cookie, a premise the row cannot play without.
 *
 * @param {object} cx the seat's CDP session
 * @param {string} label the run's name in the log and the error
 * @param {string} tag the row's name for the log line
 */
export async function awaitCookieCommitted(cx, label, tag) {
  const host = new URL(SITE).hostname;
  let waitedMs = 0;
  for (;;) {
    const { cookies } = await cx.send('Network.getAllCookies');
    const refresh = cookies.find((c) => c.name === 'canari_refresh' && c.domain === host);
    const waitMs = cookieCommitWaitMs({ expiresSec: refresh?.expires ?? null, nowMs: Date.now() });
    if (waitMs === null) throw new Error(`${label}: no refresh cookie for ${host} before the kill - the seat is not signed in`);
    if (waitMs === 0) return waitedMs;
    console.log(`[${tag}] ${label}: waiting ${waitMs} ms for the newest refresh cookie to reach disk`);
    await sleep(waitMs);
    waitedMs += waitMs;
  }
}
