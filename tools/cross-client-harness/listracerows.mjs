/**
 * LIST-RACE-1 - A SALON HEARD OF LIVE WHILE ITS COMMUNITY'S LISTING IS IN FLIGHT (2026-10-26).
 *
 * BIG-3-noI1 lost a salon on A1: the client's in-session listing of a community it had just joined
 * was answered before W1 created the salon, the salon arrived live (`Joined channel ...`) while that
 * listing was still running, and the listing's clean-up (`pruneAfterLoad`) removed it, silently. The
 * timing is the whole defect, so these rows make it deterministic instead of waiting for a slow
 * phone to lose the race (`docs/wiki/backlog.md`, the P2 of that name):
 *
 *   1. the subject joins the community IN SESSION (a sibling seat accepts the link, or - on A1 - W1's
 *      first salon is how the phone hears of a community at all);
 *   2. the subject's per-community listing ANSWER is held (`hold-answer once`: the server has
 *      answered, before the salon exists - a `hold` of the REQUEST would send it on release and get a
 *      fresh answer, which is the rig mistake of the first run);
 *   3. W1 creates the salon, and the subject logs `Joined channel <id>` while the answer is held;
 *   4. the answer is released, the listing ends, and the salon is looked for, in rounds.
 *
 * The `-CTL` rows play the same steps with nothing held: the salon must be listed. RED is `FAIL` on a
 * build without the fix, GREEN is `PASS` on one with it.
 *
 * THE 20 S RULE. The client gives up on a GET with no answer after 20 s (`[CONNECTIVITY] ... had no
 * response after 20000 ms`) and retries it, unheld - so an answer held past that is answered FRESH
 * and the row measures nothing. A row whose hold outlived {@link HOLD_RELEASE_BOUND_MS} or whose
 * subject logged that stall is `INVALID`, never a `PASS`.
 */

/** A held answer is released before this, under the client's own 20 s stall. */
export const HOLD_RELEASE_BOUND_MS = 15_000;

/** Rounds (500 ms each) a fact is waited for; the salon is looked for in {@link LISTED_ROUNDS}. */
export const ROUND_MS = 500;
export const WAIT_ROUNDS = 60;
export const LISTED_ROUNDS = 20;

const WEB = {
  devices: ['W1', 'W4', 'W8'],
  joiner: 'W4',
  subject: 'W8',
  firstSalon: false,
};
const PHONE = {
  devices: ['W1', 'A1'],
  joiner: null,
  subject: 'A1',
  // A1 HEARS A NEW COMMUNITY ONLY WITH ITS FIRST SALON'S `member.joined` (measured 2026-10-26: W1's
  // creation alone left it silent for a minute), so a first salon is what starts its listing.
  firstSalon: true,
};

/** The rows `archive/listrace.mjs` plays. */
export const LIST_RACE_ROWS = {
  'LIST-RACE-1-W': {
    ...WEB,
    hold: true,
    what: "W4 joins W1's community by link; W8 (same account) lists it in session with its answer held; W1 creates a salon heard live while held - the salon is listed after the release",
  },
  'LIST-RACE-1-W-CTL': { ...WEB, hold: false, what: 'LIST-RACE-1-W with nothing held - the control' },
  'LIST-RACE-1-A1': {
    ...PHONE,
    hold: true,
    what: "W1 creates a community and a first salon; A1 (same account) lists it in session with its answer held; W1 creates a second salon heard live while held - it is listed after the release",
  },
  'LIST-RACE-1-A1-CTL': { ...PHONE, hold: false, what: 'LIST-RACE-1-A1 with nothing held - the control' },
};

/**
 * The row's verdict from what it measured. The premise first: a held row whose answer was not held
 * when the salon was heard, or was held past the client's stall, measured nothing.
 *
 * @param {{ hold: boolean, joinedInSession: number|null, heard: number|null, heldStill: number|null,
 *   heldForMs: number|null, stalled: boolean, listedRound: number|null }} m
 * @returns {{ verdict: 'PASS'|'FAIL'|'INVALID', failures: string[] }}
 */
export function listRaceOwn(m) {
  const premise = [];
  if (m.joinedInSession === null) premise.push('the subject never logged that it joined the community in session');
  if (m.heard === null) premise.push('the subject never heard of the salon live');
  if (m.hold) {
    if (m.heldStill !== 1) premise.push(`the listing answer was not held when the salon was heard (${m.heldStill ?? 'none'} held)`);
    if (m.heldForMs === null || m.heldForMs > HOLD_RELEASE_BOUND_MS) premise.push(`the answer was held ${m.heldForMs ?? '?'} ms, past the ${HOLD_RELEASE_BOUND_MS} ms bound`);
    if (m.stalled) premise.push('the subject stalled the held GET and retried it unheld');
  }
  if (premise.length) return { verdict: 'INVALID', failures: premise };
  if (m.listedRound === null) return { verdict: 'FAIL', failures: [`the salon was not listed within ${LISTED_ROUNDS} rounds of the listing's end`] };
  return { verdict: 'PASS', failures: [] };
}
