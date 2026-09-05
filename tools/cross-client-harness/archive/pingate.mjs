/**
 * The PIN gate as a library: enter the PIN, then PROVE the client came out the other side.
 *
 * WHY THIS IS NOT FIVE PRIVATE HELPERS. `comm22`, `life`, `notif`, `notif7` and `tab236` each held
 * a near-identical `unlock()` that spawned `pin.mjs` and returned ITS LAST LINE OF STDOUT. A string
 * is not a post-condition: `pin.mjs failed: ...` and `[pin] unlocked` are both truthy, both were
 * recorded next to the verdict rather than gating it, and the run carried on either way. A client
 * that never got past the gate does not fail honestly - it renders, it answers every probe, and it
 * reports on an empty store - so the next assertion reads zero of everything and the check blames
 * the application for the rig's own locked browser. That is `testing-methodology`'s "every action
 * asserts its own post-condition", and the five copies were the one place in the harness that did
 * not.
 *
 * THE PROOF IS A RACE BETWEEN TWO SIGHTINGS, NEVER AN ABSENCE. A booting client shows no gate
 * either: `document.readyState` reaches `complete` while the app is still deciding whether the
 * encryption key is available, so "no gate on screen" reported unlocked about a client one second
 * away from raising the prompt (measured 2026-08-13, on all three clients at once). So the verdict
 * is whichever proof lands first - the gate itself, or the chat having actually MOUNTED - and
 * neither within the deadline is `UNDECIDED`, a third answer that is never spelt "fine".
 *
 * IDEMPOTENT: an already-unlocked client is left alone and costs one sample.
 *
 *   import { unlockClient } from './pingate.mjs';
 *   const gate = await unlockClient(w2, PORTS.W2, ACCOUNT_OF.W2);
 *   if (gate.verdict !== 'unlocked') // the question is unaskable - do not produce a verdict
 */
import { execFileSync } from 'node:child_process';
import { evaluate } from '../chat.mjs';
import { GATE_EXPR } from '../gate-probe.mjs';
import { requireScript } from '../scriptpath.mjs';

/**
 * `pin.mjs`, BY ABSOLUTE PATH, RESOLVED THE WAY EVERY OTHER SPAWN IN THIS RIG RESOLVES A SCRIPT.
 *
 * This used to spawn the bare name `pin.mjs` with this file's own directory as the cwd - and this
 * file is in `archive/`, while `pin.mjs` is in the harness root one level up. So the child answered
 * `error: Module not found "pin.mjs"` on EVERY call, and had done since the helper was written: the
 * one thing `unlockClient` exists to do had never once happened. It looked like it worked, because
 * the early return below covers the common case - a client already past the gate - and because the
 * failure went into `said`, a string most callers drop.
 *
 * COMM-18 is where it finally showed, because that row FORCE-STOPS the app, so the gate is really up
 * and really has to be answered. It recorded `a1Gate: LOCKED` three times running - a phone reported
 * as refusing its PIN by a tool that had never reached it. `requireScript` is what this rig already
 * has for the problem, and its own docstring says why: a spawn given a name it cannot resolve fails
 * quietly, in the child, where the parent usually discards the message.
 */
const PIN_SCRIPT = requireScript('pin.mjs');

/**
 * The two things that can be PROVED about a client at the gate, read in one pass.
 *
 * `gate` is the prompt in either of its shapes - the desktop input and the mobile keypad, which
 * carries no `#encryption-pin` at all, so a probe keyed on the id alone reads "no modal" about a
 * phone plainly showing one. `mounted` is the chat having rendered. Neither alone is the answer,
 * and reading both is the whole point.
 */
const PROBE = `JSON.stringify({
  gate: ${GATE_EXPR},
  mounted: !!document.querySelector('.chat-composer-footer .chat-composer-editor') ||
    document.querySelectorAll('aside button, nav button').length > 0
})`;

/**
 * Watches a client until one of the two proofs lands.
 *
 * @param {object} cx an attached CDP client
 * @param {number} deadlineMs how long to wait for either proof
 * @returns {Promise<'LOCKED' | 'unlocked' | 'UNDECIDED'>}
 */
export async function settle(cx, deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const raw = await evaluate(cx, PROBE).catch(() => null);
    const seen = raw ? JSON.parse(raw) : null;
    if (seen?.gate) return 'LOCKED';
    if (seen?.mounted) return 'unlocked';
    if (Date.now() >= until) return 'UNDECIDED';
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Brings one client past the encryption PIN, and says whether it actually got there.
 *
 * NO CREDENTIAL CROSSES THIS BOUNDARY. `pin.mjs` reads the value from `test-accounts.json` by
 * account key, so nothing sensitive lands in a captured shell, a log or a tool-call transcript -
 * which is why this spawns the CLI rather than typing the digits itself.
 *
 * `said` is what `pin.mjs` reported, kept for the record and never for a decision: branching on it
 * would be branching on an error MESSAGE. The decision is `verdict`, and it comes from re-reading
 * the client afterwards.
 *
 * @param {object} cx an attached CDP client for `port` - the thing the proof is read from
 * @param {number} port the client's CDP port
 * @param {string} account the account key as spelt in `test-accounts.json`
 * @param {{match?: string, value?: string, timeoutMs?: number, deadlineMs?: number}} [opts]
 *   `match` picks the target by url when a client holds several - `tauri.localhost` for the phone.
 *   `value` sends that string INSTEAD of the account's PIN - see below.
 * @returns {Promise<{verdict: 'unlocked'|'LOCKED'|'UNDECIDED', said: string}>}
 */
export async function unlockClient(cx, port, account, opts = {}) {
  const { match = null, value = null, timeoutMs = 120_000, deadlineMs = 30_000 } = opts;

  // A DELIBERATELY WRONG PIN IS STILL AN UNLOCK ATTEMPT, and it needs the same post-condition.
  //
  // `pin.mjs --value` exists for the rows that send one (PIN-2, PIN-3, PIN-7), and before this they
  // had to spawn it themselves - which is the duplication this helper was written to end, and it
  // would have been the copy WITHOUT the proof: a wrong PIN leaves the client at the gate, which is
  // the state every caller of this function is careful to distinguish from a broken instrument.
  //
  // THE EARLY RETURN IS SKIPPED FOR ONE. An already-unlocked client is nothing to do when the point
  // is to get in; when the point is to be REFUSED, answering "already unlocked" would be a check
  // reporting on an attempt it never made. A caller passing `value` against an unlocked client has
  // a precondition problem, and the verdict below says so rather than hiding it.
  const before = await settle(cx, deadlineMs);
  if (before === 'unlocked' && !value) return { verdict: 'unlocked', said: 'already unlocked' };
  // UNDECIDED BEFORE THE PIN IS NOT A REASON TO SKIP IT. Neither proof landing means the page is not
  // rendering, and the gate is one of the two things that could be holding it - so it is still worth
  // trying, and the verdict below comes from the sample taken AFTER, never from this one.

  const args = [PIN_SCRIPT, '--port', String(port), '--account', account];
  if (match) args.push('--match', match);
  if (value) args.push('--value', value);

  let said;
  try {
    said = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: timeoutMs })
      .trim()
      .split('\n')
      .pop();
  } catch (e) {
    // Exit 2 is `pin.mjs` reporting no modal on screen, which is a STATE and not a failure: the
    // client was already past the gate, or has not raised it yet. Either way the proof below is what
    // settles it, so this is recorded and not thrown.
    if (e.status === 2) {
      said = 'no modal';
    } else {
      // AND IT IS PRINTED, NOT ONLY RETURNED. Any other exit code means the tool did not do its job,
      // which is a broken INSTRUMENT rather than a state of the client - and a caller that records
      // only the verdict, which is most of them, would otherwise show a locked phone with no reason.
      said = `pin.mjs failed: ${String(e.stdout || e.message).slice(0, 200)}`;
      console.error(`[pingate] ${said.replace(/\s+/g, ' ')}`);
    }
  }

  return { verdict: await settle(cx, deadlineMs), said };
}
