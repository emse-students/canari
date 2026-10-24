/**
 * THE KILL ROWS OF THE 1.4.1 CAMPAIGN - KILL-1..5 and RM-3 - their table and their judges.
 *
 * Pure, so `archive/kill-selftest.mjs` pins every judge on a checkout with no rig; the action is
 * `archive/kill.mjs`, the kill and the revival `archive/reopen.mjs`. `docs/wiki/cross-client-campaign-1-4-1.md`
 * section 4.2 is the plan. The question of every row is what a commit in flight leaves behind when the
 * process holding it dies: merged once, or cleared and caught up - never a fork, never a blocked group.
 *
 * THE WINDOW IS CHOSEN, NOT GAMBLED. "A random point between the stage and the answer" has two sides
 * that are different questions: the request never reached the server (`hold`, then the kill), or the
 * server accepted and the answer never came back (`hold-answer`, then the kill). Runs alternate the
 * two and draw only the delay inside the window, recorded per run - so twenty runs are ten of each,
 * never twenty of whichever the timing happened to favour.
 *
 * THE OUTCOME IS READ ON THE SERVER, never from the revived page's console: the settlement runs at the
 * connection, which is before any `watch()` can attach to the new document.
 */

/** The two sides of the server a kill can land on, and the fault that holds the commit there. */
export const WINDOWS = { 'before-server': 'hold once', 'after-accept': 'hold-answer once' };

/** The rows `archive/kill.mjs` plays. */
export const KILL_ROWS = {
  'KILL-1': {
    devices: ['W1', 'W2'],
    kill: 'tab',
    runs: 20,
    maxDelayMs: 800,
    what: "W1's tab closed (`Target.closeTarget`) with a leaf-refresh commit in flight, 20 runs: each ends merged once or cleared and caught up",
  },
  'KILL-2': {
    devices: ['W1', 'W2'],
    kill: 'browser',
    runs: 10,
    maxDelayMs: 800,
    what: "W1's whole browser killed (no unload handler runs) at the same point, then relaunched: as KILL-1",
    note: 'ten runs, not twenty: each is a browser relaunch and a PIN, and the two windows are covered five times each',
  },
  'KILL-3': {
    devices: ['A1', 'W2'],
    kill: 'swipe',
    runs: 10,
    maxDelayMs: 800,
    what: 'A1 swiped away from recents during a commit it is making, 10 runs: as KILL-1 on reopen',
  },
  'KILL-4': {
    devices: ['A1', 'W2'],
    kill: 'force-stop',
    fractions: [0.1, 0.25, 0.4, 0.55, 0.7, 0.85],
    what: 'A1 killed DURING the stage and its checkpoint, before the commit request leaves: the next load holds the old state or the new one, never a blocked group',
    note:
      'the plan times the kill on a `[CHECKPOINT]` start line the client does not write. The window is measured instead: one un-killed run gives the time from the send to the commit request being held (stage + checkpoint), and each kill lands at a fraction of it. `am force-stop`, not `am kill`: `am kill` only reaches a process in the background',
  },
  'KILL-5': {
    devices: ['W1', 'W2'],
    subject: 'W2',
    what: "W1's tab closed between the merge of its Add and the Welcome send (`POST /api/mls/welcome` held): after reopen the joiner gets ONE Welcome, a second copy read as a redelivery",
    note: "the plan's joiner is a new device W3; any joiner asks the question, and W2 needs no new device",
  },
  'RM-3': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    setup: ['W2', 'W4'],
    subject: 'W4',
    next: 'W5',
    boundMs: 300_000,
    what: "W1's tab closed after the roster delete of W4 and before the Remove commit: the row MEASURES how long until a later member commit (W2 Adds W5) or a repair takes W4's seat away",
    note: "the leaf surviving is the known P2 (backlog, #2358). The server's seat table is the proxy for the leaf: an active, unkicked seat of W4 is a leaf the server still routes to",
  },
};

/** The window run `i` plays: alternating, so the two sides are covered evenly. */
export const windowOf = (i) => Object.keys(WINDOWS)[i % 2];

/** The delay inside the window, drawn per run and recorded. */
export const delayOf = (spec, rand = Math.random) => Math.round(rand() * spec.maxDelayMs);

/**
 * One kill run's outcome, from the gate's decisions since the run began and the revived seat.
 *
 * @param {object} p
 * @param {'before-server'|'after-accept'} p.window
 * @param {{kind: string}[]} p.seq the gate's decisions on the group from the run's start to its settlement
 * @param {number} p.fromEpoch the server's epoch before the run's commit
 * @param {number} p.serverEpoch the server's epoch once the run settled
 * @param {number|null} p.caughtUpMs the revived seat reached `serverEpoch`
 * @param {number} p.outShown the revived seat's message, as W2 shows it
 * @param {number} p.inShown W2's message, as the revived seat shows it
 */
export function runOutcome({ window, seq, fromEpoch, serverEpoch, caughtUpMs, outShown, inShown }) {
  const accepts = seq.filter((d) => d.kind === 'ACCEPT').length;
  const duplicates = seq.filter((d) => d.kind === 'DUPLICATE').length;
  const moved = serverEpoch - fromEpoch;
  const outcome = accepts === 1 && moved === 1 ? 'merged' : accepts === 0 && moved === 0 ? 'cleared' : 'neither';
  return {
    outcome,
    accepts,
    duplicates,
    assertions: [
      { what: `merged once or cleared, never more (${accepts} accept(s), the epoch moved ${moved})`, ok: outcome !== 'neither' },
      // AFTER AN ACCEPT THE COMMIT EXISTS: clearing it would leave the device behind its own commit.
      { what: `a commit the server accepted before the kill stayed merged (${window})`, ok: window !== 'after-accept' || outcome === 'merged' },
      { what: `the revived seat caught up to the server (${caughtUpMs ?? 'never'} ms)`, ok: caughtUpMs !== null },
      { what: `the group is not blocked: its next message out shows once (${outShown}) and one in shows once (${inShown})`, ok: outShown === 1 && inShown === 1 },
    ],
  };
}

/**
 * A row of runs: every run's assertions, prefixed by its number and window, plus the coverage of both
 * windows (a kill row that played one side only did not ask its question).
 */
export function killRunsOwn(runs, { windows = true } = {}) {
  const out = [];
  if (windows) {
    const sides = new Set(runs.map((r) => r.window));
    out.push({ what: `both windows played (${[...sides].join(', ') || 'none'})`, ok: Object.keys(WINDOWS).every((w) => sides.has(w)) });
  }
  out.push({ what: `${runs.length} run(s) played`, ok: runs.length > 0 });
  for (const r of runs) for (const a of r.assertions) out.push({ what: `run ${r.run} (${r.window ?? `${r.fraction}`}): ${a.what}`, ok: a.ok });
  return out;
}

/**
 * KILL-4's coverage: the calibration measured a window, and at least one kill landed INSIDE it (the
 * commit request not yet held when the process died) - a row whose every kill came after the request
 * left asked KILL-1's question, not this one.
 */
export function stageKillsOwn({ windowMs, runs }) {
  const inside = runs.filter((r) => r.heldAtKill === 0).length;
  return [
    { what: `the stage and checkpoint window was measured (${windowMs ?? 'not'} ms)`, ok: Number.isFinite(windowMs) && windowMs > 0 },
    { what: `kills landed inside it, before the request left: ${inside} of ${runs.length}`, ok: inside > 0 },
  ];
}

/** The joiner's lines about `groupId`: joins, redeliveries ignored, failures. */
export function welcomeLines(lines, groupId) {
  const short = String(groupId).slice(0, 8);
  const about = lines.filter((l) => l.includes('[WELCOME]') && l.includes(short));
  return {
    joined: about.filter((l) => / ready\b/.test(l)).length,
    redelivered: about.filter((l) => /redelivered Welcome ignored/.test(l)).length,
    failed: about.filter((l) => /Erreur traitement|GroupAlreadyExists|EVICTED/.test(l)),
  };
}

/** KILL-5: the Add stood, the joiner joined ONCE, and any further copy was read as a redelivery. */
export function welcomeOnceOwn({ accepts, welcome, listed, caughtUpMs, heldWelcome }) {
  return [
    { what: `the kill landed between the merge and the Welcome send (the Welcome request was held: ${heldWelcome})`, ok: heldWelcome },
    { what: `the Add stood: one accept (${accepts})`, ok: accepts === 1 },
    { what: `the joiner joined ONCE (${welcome.joined} join line(s))`, ok: welcome.joined === 1 },
    { what: `no second copy was processed as a join (${welcome.redelivered} redelivery line(s), ${welcome.failed.length} failure(s))`, ok: welcome.failed.length === 0 },
    { what: `the joiner lists the group and is at the server's epoch (${listed ? 'listed' : 'NOT listed'}, ${caughtUpMs ?? 'never'} ms)`, ok: listed && caughtUpMs !== null },
  ];
}

/**
 * RM-3: the premise (the roster delete landed, the Remove commit did not) and the measurement (how
 * long until W4's last active seat went).
 */
export function removalBoundOwn({ rosterDropped, commitBeforeKill, seatsAtKill, goneAfterMs, boundMs }) {
  return [
    { what: `the roster delete landed before the kill (W4 ${rosterDropped ? 'off' : 'STILL ON'} the roster)`, ok: rosterDropped },
    { what: `no Remove commit was accepted before the kill (${commitBeforeKill})`, ok: commitBeforeKill === 0 },
    { what: `W4's seat survived the kill as the known P2 says (${seatsAtKill} active seat(s)) - recorded, not required`, ok: true },
    { what: `a later member commit or a repair took W4's seat within ${boundMs / 1000} s (${goneAfterMs === null ? 'it did not' : `${Math.round(goneAfterMs / 1000)} s`})`, ok: goneAfterMs !== null },
  ];
}
