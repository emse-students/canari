/**
 * THE ROWS ONLY A PERSON CAN PLAY, AND HOW THEIR WORD IS WRITTEN - `archive/handrow.mjs`'s pure half.
 *
 * Section 4.3 of `docs/wiki/cross-client-campaign-1-4-1.md` names the `O` rows: a gesture no tool
 * here performs (a reboot left unopened, the lock screen, CallKit). Their client side is a person's
 * observation, so it is recorded as exactly that - `unobservable`, never `clean` - and the one
 * observer the rig still has, the SERVER's window from the start the lead gives, is folded in the way
 * `recordObserved` folds it: a dirty window demotes a PASS. A person's observation is therefore never
 * written as a watched `PASS`.
 *
 * Pure, so `archive/handrow-selftest.mjs` pins it on a checkout with no rig and no `names.mjs`.
 */

/** The rows a person plays, and the gesture that makes each one a person's. TOK-3 is NOT here: it
 * needs only the clock, and `archive/settle.mjs --row TOK-3` runs it unattended. */
export const HAND_ROWS = {
  'LIFE-5': 'the phone rebooted and the app never opened - the passcode keeps the stores sealed until a person enters it',
  'CALL-12': 'a call answered from the lock screen - a gesture at the device',
  'CALL-13': 'a call answered through CallKit - a gesture at the device',
};

/** What a person may state. `PASS-DIRTY` is absent: whether the run was clean is the server window's to say. */
export const HAND_VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE', 'SKIPPED'];

/** Why the client side carries no gate - the `unobservable` every hand row records. */
export const HAND_UNOBSERVABLE =
  'the client side was observed by a person at the device, not watched by the rig - only the server window was read';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Reads `--row <id> --verdict <V> --what "<observed>" [--since <ISO>]`.
 *
 * `--since` is the row's start as the lead gives it, and the server window begins there; it is
 * required for every verdict but `SKIPPED`, which observed nothing, and must not lie in the future.
 *
 * @param {string[]} argv the arguments after the script
 * @param {number} now epoch ms, injected so the check is testable
 * @returns {{row: string, verdict: string, what: string, since: string|null} | {error: string}}
 */
export function parseHandArgs(argv, now) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const row = value('--row');
  const verdict = value('--verdict');
  const what = (value('--what') ?? '').trim();
  const since = value('--since');
  if (!row || !HAND_ROWS[row]) return { error: `--row must be one of ${Object.keys(HAND_ROWS).join(', ')} (got ${row ?? 'nothing'})` };
  if (!HAND_VERDICTS.includes(verdict)) return { error: `--verdict must be one of ${HAND_VERDICTS.join(', ')} (got ${verdict ?? 'nothing'})` };
  if (!what) return { error: '--what must say what the person observed' };
  if (verdict === 'SKIPPED') return { row, verdict, what, since: null };
  if (!since || !ISO.test(since)) return { error: `--since must be the row's start as an ISO instant in UTC (got ${since ?? 'nothing'})` };
  if (Date.parse(since) > now) return { error: `--since ${since} is in the future` };
  return { row, verdict, what, since };
}

/**
 * The verdict and detail a hand row is recorded with.
 *
 * `SKIPPED` carries the person's reason and no window. Anything else carries the observation, the
 * `unobservable` client side and the server window; a PASS over a window that is not clean - dirty
 * or unreadable - is `PASS-DIRTY`, the same fold as `serverwindow.mjs` `foldServerWindow`. No
 * `clean` key is written: no client was watched, so no client can be called clean.
 *
 * @param {object} p
 * @param {string} p.row
 * @param {string} p.verdict the person's verdict
 * @param {string} p.what what the person observed
 * @param {object|null} p.serverWindow a `takeServerWindow` result, null for `SKIPPED`
 * @returns {{verdict: string, detail: object}}
 */
export function handRecord({ row, verdict, what, serverWindow }) {
  if (verdict === 'SKIPPED') return { verdict, detail: { reason: what, handGesture: HAND_ROWS[row] } };
  const { dirt, ...window } = serverWindow ?? { clean: false, unreachable: 'no server window was taken' };
  const serverClean = window.clean === true;
  const detail = { handObserved: what, handGesture: HAND_ROWS[row], unobservable: HAND_UNOBSERVABLE, serverWindow: window, serverClean };
  if (!serverClean) detail.dirt_server = dirt ?? { unreachable: window.unreachable ?? 'no reason recorded' };
  return { verdict: verdict === 'PASS' && !serverClean ? 'PASS-DIRTY' : verdict, detail };
}
