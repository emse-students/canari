/**
 * Unlocks a PHONE's encryption PIN by spawning `pin.mjs` - the one implementation both phone modules
 * call (`phone.mjs` for Android, `phone-ios.mjs` for the iPhone), which differ only in the account,
 * the port and the WebView origin they pass.
 *
 * SPAWNED RATHER THAN IMPORTED, deliberately: the PIN is read by `pin.mjs` from `test-accounts.json`
 * and must never become an argument that a check could log, print or record.
 *
 * NOTIF-10 needed this and did not have it: cutting the radios for ten minutes restarts the app when
 * they come back, and a restarted app re-locks the PIN. The whole chat then sits behind the modal,
 * so `openConversation` cannot find anything and the check refused a verdict. EVERY PHASE THAT
 * RELAUNCHES THE APP MUST UNLOCK BEFORE IT NAVIGATES.
 *
 * A FAILURE CARRIES THE REASON IT FAILED FOR, and this used to carry the 200 first characters of
 * STDOUT - the one stream that says nothing about why. `pin.mjs` has three distinct failures and
 * writes all three to stderr: exit 1 = the product REFUSED the PIN (and names which refusal), a
 * throw out of `assertLocalEstate` = the app is pointing at an estate that is not the local one,
 * and anything else = the CDP context died mid-answer. DEL-7 recorded
 * `pin.mjs failed: ...[pin] after:` on 2026-09-05 - a truncation ending on an EMPTY `after:`, which
 * is the most interesting line in the run and the one thing the record could not explain. Exit code
 * and stderr are what separate the three, so both are reported and the stdout TAIL keeps its place
 * as context rather than as the message.
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireScript } from './scriptpath.mjs';

/** This directory - `pin.mjs` is spawned from here. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @param {{ port: number, account: string, match: string }} target the devtools port, the account
 *   key in `test-accounts.json`, and a substring of the WebView's URL that picks its target
 * @returns {string} the last line `pin.mjs` printed, `'no modal'`, or `pin.mjs failed (...)` - never throws
 */
export function spawnPin({ port, account, match }) {
  try {
    return execFileSync(
      process.execPath,
      [requireScript('pin.mjs'), '--port', String(port), '--account', account, '--match', match],
      { cwd: HERE, encoding: 'utf8', timeout: 120_000 },
    )
      .trim()
      .split('\n')
      .pop();
  } catch (e) {
    if (e.status === 2) return 'no modal';
    const why = String(e.stderr || e.message)
      .trim()
      .replace(/\s+/g, ' ');
    const lastOut = String(e.stdout || '')
      .trim()
      .split('\n')
      .pop();
    return `pin.mjs failed (exit ${e.status ?? 'none'}): ${why.slice(0, 300)} [last stdout: ${lastOut}]`;
  }
}
