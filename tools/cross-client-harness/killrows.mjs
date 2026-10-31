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

import { TAURI_HTTP_BLOCKED } from './rowkit.mjs';

/** KILL-4 holds A1's commit POST, which the Tauri app sends below the WebView: refused, `pending` on the board. */
export const KILL_BLOCKED = { 'KILL-4': TAURI_HTTP_BLOCKED };

/**
 * KILL-3's four windows, each a different durable write a crash can outrun.
 *
 * - `send-before-server`: the message POST is held, so it never reaches the server.
 * - `send-after-accept`: the server stored the message, and the answer never came back.
 * - `after-send`: the send answered, and the browser dies inside the lazy checkpoint. Only the send
 *   ledger (`sendRatchetLedger`, a synchronous localStorage write) covers the generation spent.
 * - `after-receive`: W2's message was decrypted and shown, and the browser dies before the checkpoint
 *   that makes its seen-mark durable (`markHistoryFrameConsumed`).
 */
export const KILL3_WINDOWS = {
  'send-before-server': 'hold once',
  'send-after-accept': 'hold-answer once',
  'after-send': null,
  'after-receive': null,
};

/**
 * THE UNSENT STATES W1's OWN BUBBLE MAY SHOW, as the French interface prints them
 * (`MessageMetadata.svelte`, `messages/fr.json`):
 * - `msg_en_attente` (queued in the outbox);
 * - `common_sending_label` (in flight);
 * - `msg_echec` (failed);
 * - `msg_non_confirme` (no answer).
 * Read on the bubble before any later send: the queued and in-flight states show on the LAST own
 * message only.
 */
export const UNSENT_LABELS = ['En attente\u2026', 'Envoi\u2026', '\u00c9chec', 'Non confirm\u00e9'];

/** The window run `i` of KILL-3 plays, in rotation, so twelve runs are three of each. */
export const kill3WindowOf = (i) => Object.keys(KILL3_WINDOWS)[i % 4];

/**
 * One KILL-3 run, judged on the two seats after the revival.
 *
 * - `killedShown`: the killed message, counted where it should land. For a send window that is W2.
 *   For `after-receive` it is the revived W1.
 * - `outShown` / `inShown`: the next message each way, which is what a rolled-back ratchet loses.
 *   A rolled-back sender re-uses a generation, and the peer drops that frame as a duplicate.
 * - `accepts` / `moved`: what the gate decided in the run. A plain send commits nothing, so a commit
 *   here is a heal, and a heal on the normal path is a defect.
 *
 * WHEN THE MESSAGE NEVER REACHED THE SERVER (`send-before-server`), the outbox holds it, and the
 * revived page either resends it once or shows it unsent (`unsentLabel`: one of
 * {@link UNSENT_LABELS} on W1's own bubble). A message that neither arrives nor says it did not is a
 * silent loss, and it fails. A second copy is never acceptable.
 *
 * @param {object} p
 * @param {keyof typeof KILL3_WINDOWS} p.window
 * @param {number} p.killedShown
 * @param {number} p.outShown
 * @param {number} p.inShown
 * @param {number} p.accepts
 * @param {number} p.moved
 * @param {number|null} p.caughtUpMs
 * @param {string|null} [p.unsentLabel] the unsent state W1's own bubble showed, read before any later send
 */
export function kill3Outcome({ window, killedShown, outShown, inShown, accepts, moved, caughtUpMs, unsentLabel = null }) {
  const mustLand = window !== 'send-before-server';
  return {
    outcome: killedShown === 1 ? 'delivered once' : killedShown === 0 ? (unsentLabel ? `shown unsent (${unsentLabel})` : 'silently lost') : 'duplicated',
    assertions: [
      ...(mustLand
        ? []
        : [
            {
              what: `delivered, or shown unsent on W1 - never silently lost (${killedShown === 1 ? 'delivered' : unsentLabel ? `unsent: ${unsentLabel}` : 'NEITHER'})`,
              ok: killedShown === 1 || (killedShown === 0 && unsentLabel !== null),
            },
          ]),
      {
        what: `the killed message shows ${mustLand ? 'exactly once' : 'at most once'} (${killedShown})`,
        ok: mustLand ? killedShown === 1 : killedShown <= 1,
      },
      { what: `the revived seat caught up to the server (${caughtUpMs ?? 'never'} ms)`, ok: caughtUpMs !== null },
      {
        what: `no commit came of a plain send and a kill (${accepts} accept(s), the epoch moved ${moved})`,
        ok: accepts === 0 && moved === 0,
      },
      {
        what: `the ratchet survived: the next message out shows once (${outShown}) and one in shows once (${inShown})`,
        ok: outShown === 1 && inShown === 1,
      },
    ],
  };
}

/** KILL-3's coverage: every window played at least once. */
export function kill3WindowsOwn(runs) {
  const sides = new Set(runs.map((r) => r.window));
  return [
    {
      what: `every window played (${[...sides].join(', ') || 'none'})`,
      ok: Object.keys(KILL3_WINDOWS).every((w) => sides.has(w)),
    },
  ];
}

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
    note:
      'ten runs, not twenty: each is a browser relaunch and a PIN, and the two windows are covered five times each. ' +
      'THE BROWSER, NOT THE RENDERER, because the subject is the browser crashing under the user - which is also what ' +
      'can take the PROFILE with it: on 2026-10-25 a kill left W1 with no quota database, every storage call failed ' +
      'and the gate read as LOCKED. The other profiles surviving the same kill does not make it safe, so `killSeat` ' +
      'asserts the quota database and the cookie jar before the kill and `reviveSeat` probes both before the PIN (`storageLost`). ' +
      'A casualty is replayed on a fresh profile; two in a row on one build mark the row BLOCKED-ON-RIG for the campaign. ' +
      "EACH KILL WAITS UNTIL W1's NEWEST REFRESH COOKIE IS ON DISK (`cookieCommitWaitMs`): Chrome commits its cookie store " +
      'lazily (~30 s), every revival rotates the token, and a kill inside that window relaunched on a superseded token and ' +
      'signed W1 out (2026-10-25) - a product P2 of its own, not this row\'s subject',
  },
  'KILL-3': {
    devices: ['W1', 'W2'],
    kill: 'browser',
    runs: 12,
    maxDelayMs: 800,
    what:
      "W1's whole browser killed a short time after a SEND, or after a RECEIVE, 12 runs over four windows (`KILL3_WINDOWS`). " +
      'Pass conditions after the relaunch:\n' +
      '- the killed message shows once (one that never reached the server is resent once or shown unsent on W1 - never silently lost);\n' +
      '- no commit comes of it;\n' +
      '- the next message each way arrives.',
    note:
      'Moved from A1 to a web seat on 2026-10-26 (coordinator). The swipe needed a hold on the Tauri commit POST, which no rig tool can make. ' +
      'The hazard under study is web-side anyway: the send ratchet and the seen-marks live in localStorage, and the checkpoint is lazy. ' +
      'Prod, 2026-08-06: a reload 300 ms after a send lost the next message (`SecretReuseError`); the send ledger is the fix that closes that window. ' +
      'Each kill waits for the refresh cookie to reach disk first, as KILL-2 does. ' +
      'The draw is 0..800 ms, inside the ~1.7 s checkpoint the persister docblock gives. ' +
      'Each relaunch is a PIN, so twelve runs, three per window',
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
/**
 * THE COMMITS NO RUN MADE: accepts whose new epoch is not past the run's `fromEpoch`, so they landed
 * before the run read the server - between two runs, from nothing a run armed.
 *
 * WHY BY EPOCH, NOT BY CLOCK. A run's window opens BEFORE it reads `fromEpoch` (so nothing of its own
 * is missed), and a commit landing in between would otherwise be counted as the run's while the
 * epoch it moved is not: "2 accepts, the epoch moved 1" on KILL-2 run 2 (alpha.4) was that, not a
 * double apply. The epoch each ACCEPT names settles which side of the read it fell on.
 *
 * @param {{kind: string, newEpoch?: number}[]} seq the gate's decisions since the window opened
 * @param {number} fromEpoch the server's epoch the run read before its commit
 */
export function strayCommits(seq, fromEpoch) {
  return (seq ?? []).filter((d) => d.kind === 'ACCEPT' && Number.isFinite(d.newEpoch) && d.newEpoch <= fromEpoch);
}

/**
 * A run's own decisions: everything the gate decided since the run's window opened, minus the
 * {@link strayCommits} that moved the epoch before `fromEpoch` was read.
 */
export function runCommits(seq, fromEpoch) {
  const stray = new Set(strayCommits(seq, fromEpoch));
  return (seq ?? []).filter((d) => !stray.has(d));
}

/**
 * The assertion a stray commit fails: an own commit no run armed is the product doing work on the
 * normal path (KILL-2 on alpha.4: two extra leaf refreshes, between runs 1-2 and 2-3).
 *
 * @param {{kind: string, trace: string, newEpoch: number}[]} strays
 * @param {string} where which gap they landed in
 */
export function strayCommitsOwn(strays, where) {
  const traces = strays.map((d) => `${d.trace}->${d.newEpoch}`).join(', ');
  return { what: `no commit landed ${where} (${strays.length}${traces ? `: ${traces}` : ''})`, ok: strays.length === 0 };
}

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
 * The invitees W1's member panel does NOT offer to remove - RM-3's premise, read before the click.
 * Ids compared case-insensitively: the panel carries the server's id, the rig the account's.
 *
 * @param {{buttons: string[]}} panel what the panel shows (`data-remove-member` values)
 * @param {string[]} userIds every invitee of the setup's one bulk Add
 */
export function panelMissing(panel, userIds) {
  const shown = new Set((panel?.buttons ?? []).map((u) => String(u).toLowerCase()));
  return userIds.filter((u) => !shown.has(String(u).toLowerCase()));
}

/**
 * A browser kill that took the PROFILE'S STORAGE with it, read from the revived page before its PIN.
 * Chrome came back without its quota database (2026-10-25, W1): `indexedDB.databases()` threw
 * "Internal error", `localStorage` was an empty in-memory store, and the page could only show its
 * gate - which the row recorded as a product LOCKED. The data was intact on disk and a clean restart
 * read it back, so this is the RIG's casualty and is named as one, never judged.
 *
 * THE COOKIE JAR IS THE SAME CASUALTY (KILL-2 replay, 2026-10-25): the revived browser sent NO cookie
 * at all - the server logged `no canari_refresh cookie. cookies=[]` - while the profile's cookie file
 * still held them, so the page fell to the sign-in screen. Zero cookies for the site, not a missing
 * refresh cookie alone: a product sign-out clears ITS cookie and leaves the others (`cf_clearance`).
 *
 * @param {{quotaDb: boolean, idb: string|null, estimate: string|null, cookies?: number|null}} probe
 *   `quotaDb`: the profile's quota database exists on disk; `idb` / `estimate`: the error each storage
 *   call threw, or null; `cookies`: how many cookies the browser holds for the site (null: not read)
 * @returns {string|null} why the storage is lost, or null when it answers
 */
export function storageLost({ quotaDb, idb, estimate, cookies = null }) {
  const failed = [
    !quotaDb && 'no quota database in the profile',
    idb && `indexedDB: ${idb}`,
    estimate && `storage estimate: ${estimate}`,
    cookies === 0 && 'no cookie at all for the site (the cookie jar)',
  ].filter(Boolean);
  return failed.length ? failed.join('; ') : null;
}

/** Seconds between Chrome's cookie epoch (1601-01-01) and the Unix epoch. */
const CHROME_EPOCH_OFFSET_S = 11_644_473_600;

/** A Chrome cookie-file `expires_utc` (microseconds since 1601) as Unix seconds; null when absent. */
export const chromeExpiresToUnixS = (expiresUtc) => (expiresUtc === null || expiresUtc === undefined ? null : Number(expiresUtc) / 1e6 - CHROME_EPOCH_OFFSET_S);

/**
 * WHERE THE REFRESH COOKIE WAS WHEN THE BROWSER DIED - read without a clock (coordinator,
 * 2026-10-26). The browser's MEMORY is read over CDP just before the kill, and the profile's cookie
 * FILE once the process is dead, before the relaunch. Chrome holds the file locked while it runs.
 *
 * - `not-signed-in`: memory held no refresh cookie, so the run's premise is unmet and it is INVALID.
 * - `on-disk`: the file holds the rotation memory held (expiries within 2 s), so the kill cannot
 *   have taken the session.
 * - `not-on-disk` / `older-on-disk`: memory held a cookie the file does not, or holds only an
 *   earlier rotation of. The kill took the jar's newest state. That is the product's known P2
 *   (an HttpOnly cookie is not durable across an unclean kill), never a rig fault.
 *
 * @param {{memoryExpiresS: number|null, diskExpiresS: number|null}} p Unix seconds, null when absent
 * @returns {'not-signed-in'|'on-disk'|'not-on-disk'|'older-on-disk'}
 */
export function refreshCookieAtKill({ memoryExpiresS, diskExpiresS }) {
  if (memoryExpiresS === null || memoryExpiresS === undefined) return 'not-signed-in';
  if (diskExpiresS === null || diskExpiresS === undefined) return 'not-on-disk';
  return Math.abs(diskExpiresS - memoryExpiresS) <= 2 ? 'on-disk' : diskExpiresS < memoryExpiresS ? 'older-on-disk' : 'on-disk';
}

/**
 * The refresh cookie's lifetime the server sets (`SESSION_TTL_SECONDS`, auth-sessions.service.ts), so
 * a cookie's expiry minus this is the moment the browser received its last rotation.
 */
export const REFRESH_COOKIE_TTL_S = 7 * 24 * 60 * 60;

/** How long after a Set-Cookie Chrome's cookie store is taken to have committed it to disk. */
export const COOKIE_COMMIT_MS = 35_000;

/**
 * How long a browser kill must still wait so the profile's cookie file holds the CURRENT refresh
 * cookie: 0 when it does, null when the browser holds no refresh cookie at all (the premise is unmet).
 *
 * CHROME COMMITS ITS COOKIE STORE LAZILY, ABOUT EVERY 30 S (KILL-2, 2026-10-25). Every revival is a
 * refresh and every refresh rotates, so a kill inside that window relaunches on the token BEFORE the
 * rotation - and two rotations inside it put the client two generations behind, which the server
 * reads as a replay and answers by revoking the session: the row was ending on the sign-in screen,
 * a product P2 filed apart ([backlog](../../docs/wiki/backlog.md)). KILL-2's subject is a commit in
 * flight, not the cookie store, so it kills only once the newest rotation is on disk.
 *
 * @param {{expiresSec: number|null, nowMs: number, ttlS?: number, commitMs?: number}} p
 *   `expiresSec`: the refresh cookie's expiry as the browser reports it (seconds), null when absent
 */
export function cookieCommitWaitMs({ expiresSec, nowMs, ttlS = REFRESH_COOKIE_TTL_S, commitMs = COOKIE_COMMIT_MS }) {
  if (expiresSec === null || expiresSec === undefined || expiresSec <= 0) return null;
  const receivedMs = (expiresSec - ttlS) * 1000;
  return Math.max(0, Math.ceil(receivedMs + commitMs - nowMs));
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
