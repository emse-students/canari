/**
 * The ONE reader of `test-accounts.json`.
 *
 * Five scripts used to parse that file inline, in three different shapes, and one of them resolved
 * it against the CWD rather than against itself - so it worked from this directory and from nowhere
 * else, which is not a property anyone had chosen. Reading it in one place also keeps the file's
 * location a single fact: it lives outside the repository (see `STATE_DIR`), and nothing but this
 * module needs to know that.
 *
 * NO VALUE FROM HERE MAY REACH A COMMAND LINE. Logins and PINs are read here and handed straight to
 * `Input.insertText`, never to argv, so a captured shell or a run log never carries one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './names.mjs';

const FILE = join(STATE_DIR, 'test-accounts.json');

/** The whole `accounts` map, keyed as the file spells it. */
export function accounts() {
  return JSON.parse(readFileSync(FILE, 'utf8')).accounts;
}

/**
 * One account, or a throw naming the keys that DO exist.
 *
 * The old inline reads answered `undefined` for a wrong key, which surfaced later as "no PIN for
 * account X" or as a login typing nothing at all - both of which read as an application fault.
 */
export function accountFor(key) {
  const all = accounts();
  const acct = all[key];
  if (!acct) throw new Error(`unknown account ${key} - known: ${Object.keys(all).join(' ')}`);
  return acct;
}

/**
 * Every account's LOGIN, for the member pickers that search by it.
 *
 * A picker is searched with all of them in turn because which one is the peer depends on the group,
 * not on the file's order - the caller filters on the roster it actually observed.
 */
export function usernames() {
  return Object.values(accounts()).map((a) => a.username);
}

/**
 * Device label ("W1") -> the account key that owns it, from each account's own `clients` list.
 *
 * The mapping belongs to the file rather than to a constant in a script: a client is enrolled by a
 * human, and a rig that guesses which account owns a browser types the other one's PIN and then
 * reports "PIN incorrect" about a PIN that is perfectly correct.
 */
export function ownerByDevice() {
  const out = new Map();
  for (const [key, acct] of Object.entries(accounts())) {
    for (const c of acct.clients ?? []) {
      const label = String(c).trim().split(/[\s(]/)[0];
      if (label) out.set(label, key);
    }
  }
  return out;
}
