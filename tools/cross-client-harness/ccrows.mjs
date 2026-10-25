/**
 * THE CC ROWS OF THE 1.4.1 CAMPAIGN (concurrent commits) - their table and their own judgements, pure.
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2, "CC - concurrent commits". The runner is
 * `archive/cc.mjs`; the race itself is `mlsrow.mjs` `raceCommits` (every seat's commit POST held
 * before the server, released together). This module holds what a checkout with no rig can test
 * (`archive/cc-selftest.mjs`): what each row sets up, and whether its own question was answered.
 *
 * THE SERVER'S OWN ACCOUNT IS THE EVIDENCE. The gate logs one `[COMMIT][<trace>]` line per decision
 * (`messaging.service.ts` `validateCommit`): `ACCEPT ... newEpoch=N`, `REJECT epoch_mismatch` (the
 * strict epoch gate, or the transaction that lost the advance), `REJECT concurrent_commit` (the
 * Redis lock was held). A refusal is answered `201 {accepted: false}`, never an HTTP error, so the
 * client's network log cannot tell a refusal from an acceptance - these lines can.
 */
import { commitsSince } from './rowkit.mjs';

/**
 * What each row needs. `setup` are the seats whose users the row's group holds before the race
 * (W1 creates it and adds the rest in one bulk Add); `race` is who does what at the same epoch;
 * `members` are the seats that must hold the group at the end (the invariant's members).
 */
export const CC_ROWS = {
  // `members` is the end state when NEITHER Add is refused; CC-1's runner drops the loser's joiner
  // (`lockRaceOwn`), whose Add the lock cancelled.
  'CC-1': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    setup: ['W2'],
    race: { W1: { add: 'W4' }, W2: { add: 'W5' } },
    members: ['W1', 'W2', 'W4', 'W5'],
    lockRace: true,
  },
  'CC-2': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    setup: ['W2', 'W4'],
    race: { W1: { remove: 'W4' }, W2: { add: 'W5' } },
    members: ['W1', 'W2', 'W5'],
  },
  'CC-3': {
    devices: ['W1', 'W2', 'W4'],
    setup: ['W2', 'W4'],
    race: { W1: { remove: 'W4' }, W2: { remove: 'W4' } },
    members: ['W1', 'W2'],
  },
  'CC-4': {
    devices: ['W1', 'W2', 'W4'],
    setup: ['W2'],
    race: { W1: { refresh: true }, W2: { add: 'W4' } },
    members: ['W1', 'W2', 'W4'],
  },
};

/**
 * CC-5 IS NOT PLAYED BY THIS RUNNER, and the reason is a premise, not a cost: four seats each
 * committing within 200 ms needs four commits nobody asked for or four membership changes. A
 * refresh can be armed only on a seat whose leaf its OWN commit produced (`armLeafRefresh`), and a
 * seat that joined by Welcome has a KeyPackage-dated leaf until it commits once - which takes a
 * membership change of someone not yet in, i.e. a FIFTH campaign account. Recorded on
 * `cross-client-campaign-1-4-1-runners.md`.
 */
export const CC5_PREMISE = 'BLOCKED-ON-ACCOUNT: CC-5 needs every seat to have committed once (a fifth campaign account), see the runners page';

/**
 * The `[COMMIT]` decisions among server lines, in order.
 *
 * @param {string[]} lines `commitLines(group, since)` output
 * @returns {{accepts: {trace: string, newEpoch: number}[], rejects: {trace: string, reason: string}[], duplicates: string[]}}
 */
export function parseCommitLines(lines) {
  const accepts = [];
  const rejects = [];
  const duplicates = [];
  for (const l of lines ?? []) {
    const m = /\[COMMIT\]\[([^\]]+)\] (ACCEPT|REJECT|DUPLICATE)\b(?: (\S+))?(.*)$/.exec(l);
    if (!m) continue;
    const [, trace, kind, word, rest] = m;
    if (kind === 'ACCEPT') accepts.push({ trace, newEpoch: Number(/newEpoch=(\d+)/.exec(`${word ?? ''}${rest}`)?.[1] ?? NaN) });
    else if (kind === 'REJECT') rejects.push({ trace, reason: word ?? '' });
    else duplicates.push(trace);
  }
  return { accepts, rejects, duplicates };
}

/**
 * The `[ADD_LOCK]` decisions among server lines, in order: which device asked for a group's add lock
 * and whether it got it (`locks.controller.ts`).
 *
 * @param {string[]} lines delivery-service lines
 * @param {string} group the group id the lines must name
 * @returns {{device: string, acquired: boolean}[]}
 */
export function parseLockLines(lines, group) {
  const out = [];
  for (const l of lines ?? []) {
    const m = /\[ADD_LOCK\] group=(\S+) owner=[^:\s]+:(\S+) acquired=(true|false)\b/.exec(l);
    if (m && m[1] === group) out.push({ device: m[2], acquired: m[3] === 'true' });
  }
  return out;
}

/**
 * CC-1 (redefined 2026-10-25): TWO BULK ADDS AT ONCE MEET THE ADD LOCK, NOT THE COMMIT GATE.
 *
 * The Add takes the group's add lock BEFORE it builds a commit (`groupCreation.ts`), and a busy lock
 * cancels it up front (`notAdded('add-lock-busy')`). So two concurrent Adds never reach the same
 * epoch: the first holds the lock while its commit is held by the race, the second is refused at
 * the LOCK and commits nothing. Measured on the first live draw: W2 `acquired=true`, W1
 * `acquired=false` one ms later, and W1's hold never fired. The plan's question is unchanged - one
 * winner, one typed refusal, no Add half-done - and this is where the product answers it.
 *
 * NOT ARMED IS NOT AN ANSWER: a draw in which no racer was refused the lock measured no contention,
 * and {@link lockRaceLoser} returns null for it - the runner records INCONCLUSIVE.
 *
 * @param {{device: string, acquired: boolean}[]} locks `parseLockLines` since the release
 * @param {Record<string, string>} racers seat -> its device id
 * @returns {string|null} the seat refused the lock, when exactly one racer was and one was not
 */
export function lockRaceLoser(locks, racers) {
  const seatOf = (device) => Object.keys(racers).find((s) => racers[s] === device) ?? null;
  const refused = [...new Set(locks.filter((l) => !l.acquired).map((l) => seatOf(l.device)).filter(Boolean))];
  const granted = [...new Set(locks.filter((l) => l.acquired).map((l) => seatOf(l.device)).filter(Boolean))];
  if (refused.length !== 1 || granted.length < 1 || granted.includes(refused[0])) return null;
  return refused[0];
}

/**
 * THE CONSOLE LINES EACH SEAT OF A CC RACE PROVOKED, as `forgiveLogs` - and it is per GESTURE, not
 * per seat name. Until 2026-10-25 only W1 was forgiven the Add narration, so a racer that is not W1
 * and Adds (CC-2's and CC-4's W2, CC-1's winner when it is W2) emitted it as dirt, and CC-1's W2 lock
 * loser was not forgiven the block question it asks BEFORE the lock refuses it (alpha.4).
 *
 *   W1 always: the creation narration - it created the group and added the setup in one bulk Add.
 *   A racer whose action is an Add: the same narration, because it made that Add.
 *   The lock loser: the block question and the lock refusal only - it built no commit, so a commit
 *     line from it stays dirt.
 *
 * Pure: the lists are passed in, so `cc-selftest` reads this without the rig.
 *
 * @param {Record<string, {add?: string, remove?: string, refresh?: boolean}>} race `CC_ROWS[id].race`
 * @param {string|null} lockLoser from {@link lockRaceLoser}
 * @param {{creation: unknown[], blockQuestion: unknown, lockRefused: unknown[]}} n the narration lists
 * @returns {Record<string, unknown[]>}
 */
export function raceForgiveness(race, lockLoser, n) {
  const out = { W1: [...n.creation] };
  for (const [seat, action] of Object.entries(race)) {
    if (!action.add) continue;
    const provoked = seat === lockLoser ? [n.blockQuestion, ...n.lockRefused] : n.creation;
    out[seat] = [...new Set([...(out[seat] ?? []), ...provoked])];
  }
  return out;
}

/**
 * CC-1's own judgement, once {@link lockRaceLoser} named a loser.
 *
 * @param {object} p
 * @param {number} p.fromEpoch the server's epoch when the race was released
 * @param {object} p.view the server's view after (`serverView`)
 * @param {ReturnType<typeof parseCommitLines>} p.parsed the gate's decisions since the release
 * @param {string} p.winnerAdded the user the lock holder added
 * @param {string} p.loserAdded the user the refused Add named
 * @param {object} p.outcomes `raceCommits` outcomes
 * @param {string} p.winner the seat that held the lock
 */
export function lockRaceOwn({ fromEpoch, view, parsed, winnerAdded, loserAdded, outcomes, winner }) {
  const out = gesturesEnded({ [winner]: outcomes?.[winner] ?? { ok: false, error: 'no outcome' } });
  out.push({ what: `exactly ONE commit accepted since the release, the lock holder's (${parsed.accepts.length})`, ok: parsed.accepts.length === 1 });
  out.push({ what: `no commit refused - the loser built none (${refusalCodes(parsed).join(',') || 'none'})`, ok: parsed.rejects.length === 0 });
  out.push({ what: `the active epoch moved by exactly one (${fromEpoch} -> ${view.activeEpoch})`, ok: view.activeEpoch === fromEpoch + 1 });
  out.push({ what: `${winnerAdded.slice(0, 8)} added: on the roster, admitted, with an active seat`, ok: onRoster(view, winnerAdded) && activeSeats(view, winnerAdded).length > 0 });
  out.push({ what: `${loserAdded.slice(0, 8)} NOT added: off the roster, no seat (the refused Add left nothing half-done)`, ok: !onRoster(view, loserAdded) && activeSeats(view, loserAdded).length === 0 });
  return out;
}

const lower = (s) => String(s).toLowerCase();
/** Whether `user` is on the server's roster and admitted (not awaiting admission). */
export const onRoster = (view, user) => (view.roster ?? []).some((r) => lower(r.userId) === lower(user) && r.awaitingAdmission !== true);
/** `user`'s ACTIVE, unkicked device seats in the server's view - a leaf, as the server knows it. */
export const activeSeats = (view, user) => (view.seats ?? []).filter((s) => lower(s.userId) === lower(user) && s.status === 'active' && !s.kicked);

/**
 * The refusals that are the gate's NORMAL answer to the losing commit of a same-epoch race:
 * `epoch_mismatch` (the strict epoch gate, or the transaction that lost the advance) and
 * `concurrent_commit` (the gate's Redis lock was held while the winner was validated). Which one the
 * loser meets depends on how close the two arrivals were, not on the product being right or wrong.
 */
export const RACE_REFUSALS = ['epoch_mismatch', 'concurrent_commit'];

/** The refusal codes the gate returned, in order - recorded in the row's detail. */
export const refusalCodes = (parsed) => parsed.rejects.map((r) => r.reason);

/**
 * THE ROW'S CONTRACT IS THE OUTCOME, NOT THE REFUSAL CODE (lead, 2026-10-24): exactly ONE winner of
 * the shared epoch, and the loser refused with a TYPED race refusal - which of the two codes is
 * named in the detail. A refusal of any other kind (`commit_malformed`, `device_revoked`...) is not
 * the race and fails. The plan's CC rows say so.
 */
function oneWinnerLoserRefused(parsed, fromEpoch) {
  const first = parsed.accepts.filter((a) => a.newEpoch === fromEpoch + 1);
  const codes = refusalCodes(parsed);
  const untyped = codes.filter((c) => !RACE_REFUSALS.includes(c));
  return [
    { what: `exactly ONE winner of epoch ${fromEpoch} (${first.length} accepted to ${fromEpoch + 1})`, ok: first.length === 1 },
    {
      what: `the loser refused with a typed race refusal (${codes.join(',') || 'none'})`,
      ok: codes.length >= 1 && untyped.length === 0,
    },
  ];
}

/** Both gestures reached their own post-condition (an Add's picker closed, a Remove's roster shrank, a send left). */
export const gesturesEnded = (outcomes) =>
  Object.entries(outcomes ?? {}).map(([d, o]) => ({ what: `${d}'s gesture completed${o.ok ? '' : ` (${o.error})`}`, ok: !!o.ok }));

/**
 * CC-2: two commits at one epoch, one refused and REBUILT on the next (CC-1 meets the add lock first - {@link lockRaceOwn}).
 *
 * @param {object} p
 * @param {number} p.fromEpoch the server's epoch when the race was released
 * @param {object} p.view the server's view after (`serverView`)
 * @param {ReturnType<typeof parseCommitLines>} p.parsed the gate's decisions since the release
 * @param {string[]} p.added users that must be on the roster, each with an active seat
 * @param {string[]} [p.removed] users that must be gone, with no active seat (CC-2)
 * @param {object} p.outcomes `raceCommits` outcomes
 */
export function rebuiltRaceOwn({ fromEpoch, view, parsed, added, removed = [], outcomes }) {
  const out = [...gesturesEnded(outcomes)];
  out.push({ what: `TWO commits accepted since the release - the loser's rebuilt one landed (${parsed.accepts.length})`, ok: parsed.accepts.length === 2 });
  out.push(...oneWinnerLoserRefused(parsed, fromEpoch));
  out.push({ what: `the active epoch moved by exactly two (${fromEpoch} -> ${view.activeEpoch})`, ok: view.activeEpoch === fromEpoch + 2 });
  const moved = commitsSince(view.commitEpochs, fromEpoch);
  out.push({ what: `the commit log holds two rows since ${fromEpoch} (${moved.join(',') || 'none'})`, ok: moved.length === 2 });
  for (const u of added) {
    out.push({ what: `${u.slice(0, 8)} added: on the roster, admitted, with an active seat`, ok: onRoster(view, u) && activeSeats(view, u).length > 0 });
  }
  for (const u of removed) {
    out.push({ what: `${u.slice(0, 8)} removed: off the roster, no active seat (no leaf)`, ok: !onRoster(view, u) && activeSeats(view, u).length === 0 });
  }
  return out;
}

/**
 * CC-3: two Removes of the SAME member. One lands; the other is refused and is NOT rebuilt into a
 * second Remove of a leaf already gone. Judged on decisions read AFTER the invariant, whose sends
 * and reload are the window in which a rebuilt Remove would have been submitted.
 */
export function doubleRemoveOwn({ fromEpoch, view, parsed, removed, outcomes }) {
  const out = [...gesturesEnded(outcomes)];
  out.push({ what: `ONE commit accepted, and no rebuilt second Remove (${parsed.accepts.length})`, ok: parsed.accepts.length === 1 });
  out.push(...oneWinnerLoserRefused(parsed, fromEpoch));
  out.push({ what: `the active epoch moved by exactly one (${fromEpoch} -> ${view.activeEpoch})`, ok: view.activeEpoch === fromEpoch + 1 });
  out.push({ what: `${removed.slice(0, 8)} removed: off the roster, no active seat (no leaf)`, ok: !onRoster(view, removed) && activeSeats(view, removed).length === 0 });
  return out;
}

/**
 * CC-4: a due leaf refresh races a member's Add. Both land in some order (a refresh that loses is
 * asked again at the next send, and is not rebuilt in place), no Add is lost.
 *
 * THE RUNNER OWNS THAT NEXT SEND (2026-10-25). The first live draw left it to the invariant, whose
 * own send then fired the deferred refresh WHILE the invariant was reading epochs - a mid-flight
 * read, not a fork. `archive/cc.mjs` now sends a retry trigger itself and waits for the server's
 * epoch to reach `fromEpoch + 2` before the invariant starts.
 *
 * @param {object} p
 * @param {{at: number}} p.armed the ledger entry as armed (backdated)
 * @param {{at: number}|null} p.ledgerAfter the refresher's ledger entry after the invariant
 */
export function refreshRaceOwn({ fromEpoch, view, parsed, added, armed, ledgerAfter, outcomes }) {
  const out = [...gesturesEnded(outcomes)];
  out.push({ what: `${added.slice(0, 8)} added: on the roster, admitted, with an active seat (no Add lost)`, ok: onRoster(view, added) && activeSeats(view, added).length > 0 });
  out.push({
    what: `the refresh landed: the refresher's ledger was re-dated by its own accepted commit (${armed?.at ?? '?'} -> ${ledgerAfter?.at ?? 'none'})`,
    ok: !!ledgerAfter && !ledgerAfter.observed && ledgerAfter.at > (armed?.at ?? Infinity),
  });
  out.push({ what: `at least two commits accepted since the release (${parsed.accepts.length})`, ok: parsed.accepts.length >= 2 });
  out.push(...oneWinnerLoserRefused(parsed, fromEpoch));
  out.push({ what: `the epoch moved by every accepted commit (${fromEpoch} -> ${view.activeEpoch}, ${parsed.accepts.length} accepted)`, ok: view.activeEpoch === fromEpoch + parsed.accepts.length });
  return out;
}
