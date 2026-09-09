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
 * Every account's LOGIN - for the LOGIN FORM, not for a member picker.
 *
 * **THE DOC HERE USED TO SAY "for the member pickers that search by it", AND IT WAS WRONG.** Measured
 * 2026-08-21 against the group member picker on production: NEITHER login in this file was offered
 * for any query. The picker renders and matches DISPLAY names, which live in `names.mjs` as
 * `OWNER_NAME` and `PEER_NAME` and are not in `test-accounts.json` at all.
 * READ-10 believed this sentence and had never produced a verdict.
 *
 * A caller that wants "who is the peer" wants those display names, tried in turn - the picker never
 * offers an existing member or yourself, so being accepted is what identifies them.
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

/**
 * One account's OIDC SUBJECT - the only key the SERVER decides identity by.
 *
 * THIS EXISTS BECAUSE A DISPLAY NAME WAS USED AS ONE, AND IT PRODUCED A FALSE P1 ON 2026-09-09.
 * An association grant was aimed at a user resolved by display name, landed on a different row,
 * and the coupling that followed - grant appears, client's answer moves; grant removed, answer
 * empties - read as "this client is acting as the other account". It was the grant that had moved,
 * not the identity. The claim stood long enough to declare every two-client measurement void.
 *
 * The trio is now complete and each key has exactly one use: `username` fills a LOGIN FORM,
 * `OWNER_NAME`/`PEER_NAME` in `names.mjs` match a MEMBER PICKER, and this fills a WHERE clause or
 * compares against a token. They are three different strings for one human and they are not
 * interchangeable - two of the three have already been used as the third.
 *
 * Authentik mints it as `hashed_user_id`, so it is stable across this install's providers (`Canari`,
 * `Canari Local`, `Canari Dev` are three client ids and one subject) and it is what
 * `findOrCreateFromOidc` stores as `users.id`. Recover it with
 * `ak shell -c "print(User.objects.get(username=...).uid)"` on the Authentik box.
 */
export function subjectFor(key) {
  const acct = accountFor(key);
  if (!acct.sub) {
    throw new Error(
      `account ${key} has no "sub" in test-accounts.json - add it rather than matching on a display name`
    );
  }
  return acct.sub;
}

/** Account key for a subject, or null - for naming a `sub` read off a token. */
export function roleForSubject(sub) {
  if (!sub) return null;
  for (const [key, acct] of Object.entries(accounts())) {
    if (acct.sub === sub) return key;
  }
  return null;
}
