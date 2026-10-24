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
  'CC-1': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    setup: ['W2'],
    race: { W1: { add: 'W4' }, W2: { add: 'W5' } },
    members: ['W1', 'W2', 'W4', 'W5'],
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
export const CC5_PREMISE = 'CC-5 needs every seat to have committed once (a fifth campaign account), see the runners page';

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

const lower = (s) => String(s).toLowerCase();
const onRoster = (view, user) => (view.roster ?? []).some((r) => lower(r.userId) === lower(user) && r.awaitingAdmission !== true);
const activeSeats = (view, user) => (view.seats ?? []).filter((s) => lower(s.userId) === lower(user) && s.status === 'active' && !s.kicked);

/**
 * THE LOSER'S REFUSAL, as the plan names it: `epoch_mismatch`. A `concurrent_commit` (the gate's
 * Redis lock was held) is ALSO a refusal of the second commit, but it is not the one the plan's
 * `PASS` names - so it FAILS with its own words and goes to the lead as a question about the row,
 * rather than being folded into a pass.
 */
function oneEpochRefusal(rejects) {
  const kinds = rejects.map((r) => r.reason);
  if (rejects.length === 1 && kinds[0] === 'epoch_mismatch') return { what: 'exactly ONE refusal, epoch_mismatch', ok: true };
  if (rejects.length === 1 && kinds[0] === 'concurrent_commit') {
    return { what: 'the loser was refused by the commit LOCK (concurrent_commit), not the epoch gate the plan names - a question for the row', ok: false };
  }
  return { what: `exactly ONE refusal, epoch_mismatch (${rejects.length}: ${kinds.join(',') || 'none'})`, ok: false };
}

/** Both gestures reached their own post-condition (an Add's picker closed, a Remove's roster shrank, a send left). */
const gesturesEnded = (outcomes) =>
  Object.entries(outcomes ?? {}).map(([d, o]) => ({ what: `${d}'s gesture completed${o.ok ? '' : ` (${o.error})`}`, ok: !!o.ok }));

/**
 * CC-1 and CC-2: two commits at one epoch, one refused and REBUILT on the next.
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
  out.push({ what: `TWO commits accepted since the release (${parsed.accepts.length})`, ok: parsed.accepts.length === 2 });
  out.push(oneEpochRefusal(parsed.rejects));
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
  out.push(oneEpochRefusal(parsed.rejects));
  out.push({ what: `the active epoch moved by exactly one (${fromEpoch} -> ${view.activeEpoch})`, ok: view.activeEpoch === fromEpoch + 1 });
  out.push({ what: `${removed.slice(0, 8)} removed: off the roster, no active seat (no leaf)`, ok: !onRoster(view, removed) && activeSeats(view, removed).length === 0 });
  return out;
}

/**
 * CC-4: a due leaf refresh races a member's Add. Both land in some order (a refresh that loses is
 * asked again at the next send - the invariant's - and is not rebuilt in place), no Add is lost.
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
  out.push({ what: `the epoch moved by every accepted commit (${fromEpoch} -> ${view.activeEpoch}, ${parsed.accepts.length} accepted)`, ok: view.activeEpoch === fromEpoch + parsed.accepts.length });
  return out;
}
