/**
 * THE FIVE INVARIANTS OF EVERY MLS ROW, JUDGED BY ONE PURE FUNCTION (R8).
 *
 * What every MLS row asserts besides its own question (`docs/wiki/cross-client-campaign-1-4-1.md`,
 * section 4.0), decided here as ONE pure function.
 *
 * `invariant.mjs` collects (CDP on every client in play, `estate.mjs` psql and server window) and
 * hands the observations here; this module judges them. Pure, so `archive/invariant-selftest.mjs`
 * pins every rule on a checkout with no rig, no browser and no `names.mjs`.
 *
 * THREE OUTCOMES PER INVARIANT, NEVER TWO. `failures` break the row; `approximations` say which
 * part of an invariant the rig could NOT observe directly and what stood in for it. An approximation
 * is not a pass that forgot to say so: it is printed with the verdict and recorded in the ledger, so a
 * reader can tell "asked and it agrees" from "could only ask something nearby" (the same rule
 * `epochfork.mjs` applies to an unreadable epoch - `unobservable` is never `clean`).
 *
 * The approximations a build of `origin/main` on 2026-10-24 forces, each named where it is decided:
 *
 * - (1) the epoch FINGERPRINT is not exposed to the page (`window.__canariMlsEpochs()` answers epoch
 *   numbers only; the fingerprint lives in mls-core and reaches JS only inside Graine's run reading).
 *   Epoch equality across devices AND the server, plus no `[FORK]` / `[INTEGRITY]` line anywhere,
 *   stand in. A fork with equal epoch numbers is exactly what the fork check reports when a frame
 *   crosses the two trees - which invariant (3)'s message makes happen.
 * - (2) a client's staged commit (`pending_submission`) has no window hook; the server's commit log
 *   (one row per epoch moved, contiguous) and every device AT the server's epoch stand in.
 * - (5) a client's tree leaves have no window hook; the server's ACTIVE device seats stand in for
 *   them, and every member device in play must hold the group.
 *
 * A collector that CAN read the direct value passes it (`fingerprint`, `pendingSubmission`,
 * `leafUsers`), and the approximation disappears with no change here.
 */

/**
 * A client's 5xx answers minus the ones THE ROW'S OWN FAULT fulfilled (DUP-5's `status 503`), ONE
 * forgiven per provoked answer - a count, never a pattern, so an unprovoked 503 on the same path
 * still fails invariant 4. `http5xx` entries are `<status> <url up to 120 chars>` (`invariant.mjs`).
 *
 * @param {string[]} http5xx
 * @param {{status: number, url: string}[]} provoked fault records' fulfilled 5xx (`rowkit.mjs` `provokedFailures`)
 * @returns {{kept: string[], forgiven: string[]}}
 */
export function forgiveProvoked5xx(http5xx, provoked) {
  const kept = [...(http5xx ?? [])];
  const forgiven = [];
  for (const p of provoked ?? []) {
    if (!(p.status >= 500)) continue;
    const i = kept.indexOf(`${p.status} ${String(p.url).slice(0, 120)}`);
    if (i >= 0) forgiven.push(...kept.splice(i, 1));
  }
  return { kept, forgiven };
}

/** Lines that are never acceptable after an MLS row, wherever they appear (section 4.0, item 4). */
export const FORBIDDEN = [
  { name: 'accepted-not-held', re: /ACCEPTED AND NOT HELD/ },
  { name: 'erases', re: /\bERASES\b/ },
  { name: 'unreadable', re: /\bUNREADABLE\b/ },
  { name: 'absent-from-foreground', re: /is ABSENT from the state this foreground keeps/ },
];

/** `[ADMISSION]` is forbidden at ERROR only - its info lines are the mechanism working (#2358). */
const ADMISSION = /\[ADMISSION\]/;

/** A recorded fork finding, client side (mls-core `fork_check.rs`, `integrityFindings.ts`) or server side. */
const FORK_LINE = /\[FORK\] group \S+ at epoch|\[INTEGRITY\] fork\b/;
const SERVER_INTEGRITY = /\[INTEGRITY\]/;

/** Nest's line for an unhandled exception, which is what a 5xx answer leaves in a service log. */
const SERVER_5XX = /\[ExceptionsHandler\]/;

const cut = (s) => (typeof s === 'string' && s.length > 8 ? s.slice(0, 8) : s);

/** `{text, level}` from a raw line, a string being level-less. */
const asLine = (l) => (typeof l === 'string' ? { text: l, level: null } : { text: String(l?.text ?? ''), level: l?.level ?? null });

const isErrorLevel = ({ text, level }) => level === 'error' || /\bERROR\b/.test(text);

/**
 * The forbidden lines among `lines`, named.
 *
 * @param {(string|{text: string, level?: string})[]} lines
 * @returns {string[]} one `name: line` per hit
 */
export function forbiddenIn(lines) {
  const out = [];
  for (const raw of lines ?? []) {
    const l = asLine(raw);
    for (const f of FORBIDDEN) if (f.re.test(l.text)) out.push(`${f.name}: ${l.text.slice(0, 160)}`);
    if (ADMISSION.test(l.text) && isErrorLevel(l)) out.push(`admission-error: ${l.text.slice(0, 160)}`);
  }
  return out;
}

/**
 * The members still behind the server's epoch for `group`: the condition the reload pass waits on
 * before it judges. A reloaded client CONNECTS, and its connection may commit (the stray-leaf sweep
 * removes a leaver's leaf exactly there) - so a judge reading the clients and then the server samples
 * a moving group, and reads "W1 at 2, the server at 3" across one commit W1 itself made (RM-8,
 * 2026-10-25). Waiting until nobody is behind is the settlement; the bound stays the judge's.
 *
 * @param {Record<string, Record<string, number>|null>} epochsByDevice member device -> its `__canariMlsEpochs()`
 * @param {string} group
 * @param {number|null} serverEpoch
 * @returns {string[]} the devices whose epoch is absent or below the server's
 */
export function behindServer(epochsByDevice, group, serverEpoch) {
  if (serverEpoch === null || serverEpoch === undefined) return [];
  return Object.entries(epochsByDevice)
    .filter(([, epochs]) => !(epochs && Number.isFinite(epochs[group]) && epochs[group] >= serverEpoch))
    .map(([device]) => device);
}

/**
 * The group has SETTLED when its last two rounds agree: nobody behind, at the same server epoch. One
 * clean round is not enough - a connection commit may be one round trip from landing - and two clean
 * rounds at different epochs are a group still moving.
 *
 * @param {{serverEpoch: number|null, behind: string[]}[]} rounds oldest first
 */
export function settledRounds(rounds) {
  if (rounds.length < 2) return false;
  const [a, b] = rounds.slice(-2);
  return a.behind.length === 0 && b.behind.length === 0 && a.serverEpoch === b.serverEpoch;
}

/**
 * Judge one invariant pass.
 *
 * @param {object} obs
 * @param {string} obs.group the group id the row moved
 * @param {number|null} [obs.fromEpoch] the server's `activeEpoch` BEFORE the row's action; null when the row did not record it
 * @param {boolean} [obs.expectStage] the row's own subject is a commit left staged (OFF-*, KILL-*): invariant 2's client half is waived, never the server half
 * @param {object[]} obs.clients one per client in play:
 *   `{ device, userId, deviceId, member, epochs: {gid: epoch}|null, epochsWhy?, fingerprint?, pendingSubmission?,
 *      loggedOut, lines: (string|{text,level})[]|null, rowWatched?: boolean (false: the lines cover the probe only),
 *      http5xx?: string[], provoked5xx?: {status, url}[] (forgiven one each, recorded as an approximation), leafUsers?: string[],
 *      received?: {marker, count, own: boolean|null, authorId: string|null}[] }`
 * @param {object} obs.server `{ activeEpoch, commitEpochs: number[], roster: {userId, awaitingAdmission}[],
 *   seats: {userId, deviceId, status, kicked}[], lines: string[]|null, unreachable?: string }`
 * @param {{markers: string[], authorId: string}|null} obs.message the message(s) sent AFTER the event, in send order
 * @returns {{ok: boolean, failures: {invariant: number, what: string}[], approximations: {invariant: number, what: string}[]}}
 */
export function invariantVerdict(obs) {
  const failures = [];
  const approximations = [];
  const fail = (invariant, what) => failures.push({ invariant, what });
  const approx = (invariant, what) => {
    if (!approximations.some((a) => a.invariant === invariant && a.what === what)) approximations.push({ invariant, what });
  };
  const g = obs.group;
  const clients = obs.clients ?? [];
  const members = clients.filter((c) => c.member);
  const server = obs.server ?? {};

  if (!members.length) fail(1, 'no member device in play - an invariant over nobody is not a pass');
  if (server.unreachable) fail(1, `the server could not be read: ${server.unreachable}`);

  // ── 1. One tree ──────────────────────────────────────────────────────────────────────────────
  const epochOf = new Map();
  for (const c of members) {
    if (!c.epochs) {
      fail(1, `${c.device}: epochs unobservable (${c.epochsWhy ?? 'no reason given'}) - "could not ask" is not "agrees"`);
      continue;
    }
    if (typeof c.epochs[g] !== 'number') {
      fail(1, `${c.device}: holds no state for ${cut(g)} although it is a member`);
      continue;
    }
    epochOf.set(c.device, c.epochs[g]);
  }
  const distinct = [...new Set(epochOf.values())];
  if (distinct.length > 1) fail(1, `members disagree on the epoch: ${[...epochOf].map(([d, e]) => `${d}=${e}`).join(' ')}`);
  if (typeof server.activeEpoch === 'number') {
    for (const [d, e] of epochOf) {
      if (e !== server.activeEpoch) fail(1, `${d} at epoch ${e}, the server at ${server.activeEpoch}`);
    }
  } else if (!server.unreachable) {
    fail(1, `the server holds no activeEpoch for ${cut(g)}`);
  }
  const prints = members.map((c) => c.fingerprint);
  if (prints.every((p) => typeof p === 'string' && p)) {
    if (new Set(prints).size > 1) fail(1, `members disagree on the epoch fingerprint: ${members.map((c) => `${c.device}=${cut(c.fingerprint)}`).join(' ')}`);
  } else {
    approx(1, 'epoch FINGERPRINT not exposed to the page: epoch equality with the server and no [FORK]/[INTEGRITY] line stand in');
  }
  for (const c of clients) {
    for (const raw of c.lines ?? []) {
      const l = asLine(raw);
      if (FORK_LINE.test(l.text)) fail(1, `${c.device}: fork finding recorded: ${l.text.slice(0, 160)}`);
    }
  }
  for (const l of server.lines ?? []) {
    if (SERVER_INTEGRITY.test(l)) fail(1, `server: integrity finding reported: ${l.slice(0, 160)}`);
  }

  // ── 2. No stage left behind; one commit-log row per epoch moved ─────────────────────────────
  for (const c of members) {
    if (c.pendingSubmission === true && !obs.expectStage) fail(2, `${c.device}: a staged commit is left (pending_submission)`);
    else if (c.pendingSubmission !== false && c.pendingSubmission !== true && !obs.expectStage) {
      approx(2, 'pending_submission has no window hook: the commit log and every device AT the server epoch stand in');
    }
  }
  if (typeof obs.fromEpoch === 'number' && typeof server.activeEpoch === 'number') {
    const moved = server.activeEpoch - obs.fromEpoch;
    const logged = [...(server.commitEpochs ?? [])].filter((e) => e >= obs.fromEpoch && e < server.activeEpoch).sort((a, b) => a - b);
    const want = Array.from({ length: Math.max(0, moved) }, (_, i) => obs.fromEpoch + i);
    if (moved < 0) fail(2, `the server epoch went BACK: ${obs.fromEpoch} -> ${server.activeEpoch}`);
    else if (logged.join() !== want.join()) {
      fail(2, `commit log for epochs ${obs.fromEpoch}..${server.activeEpoch - 1} holds [${logged.join(',')}], expected exactly [${want.join(',')}]`);
    }
    const beyond = (server.commitEpochs ?? []).filter((e) => e >= server.activeEpoch);
    if (beyond.length) fail(2, `commit log holds rows at or past the active epoch ${server.activeEpoch}: [${beyond.join(',')}]`);
  } else {
    fail(2, 'the row recorded no starting epoch (fromEpoch), so the commit log cannot be checked against what moved');
  }

  // ── 3. A message after the event reaches every member once, in order, right author ──────────
  const msg = obs.message;
  if (!msg || !msg.markers?.length) {
    fail(3, 'no message was sent after the event');
  } else {
    for (const c of members) {
      const got = c.received ?? [];
      const positions = [];
      for (const m of msg.markers) {
        const r = got.find((x) => x.marker === m);
        if (!r || r.count === 0) {
          fail(3, `${c.device}: ${m} never arrived`);
          continue;
        }
        if (r.count > 1) fail(3, `${c.device}: ${m} shown ${r.count} times`);
        const ownExpected = c.userId === msg.authorId;
        if (r.own !== null && r.own !== undefined && r.own !== ownExpected) {
          fail(3, `${c.device}: ${m} shown as ${r.own ? 'OWN' : 'someone else\'s'}, the author is ${ownExpected ? 'this account' : 'another account'}`);
        }
        if (!ownExpected && r.authorId && r.authorId !== msg.authorId) fail(3, `${c.device}: ${m} attributed to ${cut(r.authorId)}, sent by ${cut(msg.authorId)}`);
        if (r.position !== undefined) positions.push(r.position);
      }
      if (positions.length > 1 && positions.some((p, i) => i > 0 && p <= positions[i - 1])) {
        fail(3, `${c.device}: the post-event messages are out of order (rendered at rows ${positions.join(', ')})`);
      }
    }
  }

  // ── 4. No forbidden line anywhere; nobody logged out ─────────────────────────────────────────
  for (const c of clients) {
    if (c.lines === null || c.lines === undefined) {
      fail(4, `${c.device}: client console not observed at all`);
    } else if (c.rowWatched === false) {
      approx(4, `${c.device}: client console observed during the probe only - a runner passes its own watcher to cover the row`);
    }
    for (const hit of forbiddenIn(c.lines ?? [])) fail(4, `${c.device}: ${hit}`);
    const { kept, forgiven } = forgiveProvoked5xx(c.http5xx, c.provoked5xx);
    for (const h of kept) fail(4, `${c.device}: a 5xx answer: ${h}`);
    // NOT SILENT: the row provoked these on purpose, and the verdict says which it set aside.
    if (forgiven.length) approx(4, `${c.device}: ${forgiven.length} 5xx answer(s) the row's own fault provoked, forgiven one each: ${forgiven.join('; ')}`);
    if (c.loggedOut) fail(4, `${c.device}: logged out`);
  }
  if (server.lines === null || server.lines === undefined) {
    if (!server.unreachable) fail(4, 'the server window was not read');
  } else {
    for (const hit of forbiddenIn(server.lines)) fail(4, `server: ${hit}`);
    for (const l of server.lines) if (SERVER_5XX.test(l)) fail(4, `server: a 5xx (unhandled exception): ${l.slice(0, 160)}`);
  }

  // ── 5. The roster and the tree agree ─────────────────────────────────────────────────────────
  const roster = new Set((server.roster ?? []).filter((r) => !r.awaitingAdmission).map((r) => r.userId));
  const seated = new Set((server.seats ?? []).filter((s) => s.status === 'active' && !s.kicked).map((s) => s.userId));
  const leafSets = members.filter((c) => Array.isArray(c.leafUsers)).map((c) => [c.device, new Set(c.leafUsers)]);
  const treeSets = leafSets.length ? leafSets : [['server seats', seated]];
  if (!leafSets.length) approx(5, "tree leaves have no window hook: the server's ACTIVE device seats stand in for them");
  for (const [who, tree] of treeSets) {
    const missing = [...roster].filter((u) => !tree.has(u));
    const extra = [...tree].filter((u) => !roster.has(u));
    if (missing.length) fail(5, `${who}: on the roster with no leaf: ${missing.map(cut).join(' ')}`);
    if (extra.length) fail(5, `${who}: a leaf with no roster row: ${extra.map(cut).join(' ')}`);
  }
  for (const c of clients) {
    if (c.member && c.deviceId && !(server.seats ?? []).some((s) => s.deviceId === c.deviceId && s.status === 'active' && !s.kicked)) {
      fail(5, `${c.device}: a member device in play with no active seat`);
    }
    if (c.member && !roster.has(c.userId)) fail(5, `${c.device}: declared a member, its account is not on the roster`);
  }

  return { ok: failures.length === 0, failures, approximations };
}
