/**
 * THE GAP ROWS OF THE 1.4.1 CAMPAIGN - frames that arrive ahead of their commits, frames delivered
 * again from a past epoch, and a member that never saw the first 2000 frames of an epoch.
 *
 * Pure, so `archive/gap-selftest.mjs` pins every transform and judge on a checkout with no rig; the
 * action is `archive/gap.mjs`. `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2 is the plan.
 *
 * WHY THE PENDING PULL IS THE LEVER. A member receives a commit and the frames after it on ONE ordered
 * stream - the socket while it is connected, the pending pull (`GET /api/mls/messages/:user/:device`,
 * JSON rows of `queued_message`) for what was queued while it was not. No CDP tool can touch a socket
 * frame, but the pull is an HTTP answer: so every GAP row takes its seat OFF the network
 * (`net.mjs` `cutHard`), lets the backlog build on the server, and acts on the pull that drains it on
 * the way back (`fault.mjs` `rewrite` / `rewrite-url`). Rows the rewrite leaves out are not ACKed, so
 * the next pull hands them over again - nothing is deleted on the server.
 */

/** The pending pull, and only it: `POST /api/mls/messages/ack` shares the prefix, so the method is named. */
export const PENDING_PULL = { match: '/api/mls/messages/', method: 'GET' };

/** Rung 1's commit-log fetch (`GET /api/mls/commits/:groupId?sinceEpoch=`). */
export const COMMIT_LOG = { match: '/api/mls/commits/', method: 'GET' };

/**
 * The rows `archive/gap.mjs` plays. `committers` Adds W1 makes while W2 is cut (GAP-1's N+1, N+2).
 */
export const GAP_ROWS = {
  'GAP-1': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    adds: ['W4', 'W5'],
    queued: 3,
    live: 2,
    what: 'application frames of N+2 reach W2 before the commits N+1, N+2: queued, applied in order once the commits come, nothing dropped',
    note: 'two commits need two Adds, so W5 joins the plan\'s W1 W2 W4; the commits are taken out of the pull W2 drains on its return, and its rung-1 fetch is held while W1 sends live',
  },
  'GAP-2': {
    devices: ['W1', 'W2'],
    pastEpochs: 3,
    what: 'a frame from a PAST epoch, another\'s and our own, delivered again: classified, ACKed, never re-queued as a gap',
    note: 'three epochs past (W1 leaf refreshes), beyond max_past_epochs = 2; each frame is captured from a pull and appended to a later one of W2',
  },
  'GAP-3': {
    devices: ['W1', 'W2'],
    skip: 2050,
    send: 2100,
    what: 'W2 never sees the first 2000+ frames of an epoch: TooDistantInTheFuture, not an epoch gap; recovered through the ladder',
    note: "not a `Debugger.pause`: a frozen page that later receives every frame IN ORDER never exceeds the forward distance (2000, mls-core `sender_ratchet_config`). What HEAL-W3 meant is a member that never sees the first 2000 frames, so W2's first pull on its return STARTS after them (`rewrite-url`)",
  },
};

/** GAP-4 is decided, not forgotten: the runner records it `SKIPPED` with this reason. */
export const GAP4_SKIP =
  'not played on this build: it needs the shared-payload writer (#2260), which stays OFF for 1.4.1 (plan, "Decided by the lead")';

const lower = (s) => String(s ?? '').toLowerCase();
const parseRows = (text) => {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * A `rewrite` transform that takes `groupId`'s COMMIT rows out of a pull page (GAP-1), recording
 * their ids on the fault record (`dropped`). A page that is not a JSON array is passed through
 * unchanged - and the record then says nothing was dropped, which the row reads as VACUOUS.
 *
 * NEVER AN EMPTY PAGE FOR A NON-EMPTY ONE: the client stops pulling on an empty page, so a page of
 * nothing but this group's commits keeps them (the record says so) rather than end the drain early.
 */
export function dropCommitRows(groupId) {
  return (text, record) => {
    const rows = parseRows(text);
    if (!rows) return text;
    const keep = rows.filter((r) => !(r?.isCommit === true && lower(r.groupId) === lower(groupId)));
    if (keep.length === 0 && rows.length > 0) {
      record.keptAllCommits = rows.length;
      return text;
    }
    record.dropped = rows.filter((r) => !keep.includes(r)).map((r) => r.id);
    return keep.length === rows.length ? text : JSON.stringify(keep);
  };
}

/**
 * A `rewrite` transform that COPIES the rows `predicate` selects into `into` and changes nothing - how
 * GAP-2 captures a frame from a pull to deliver it again later.
 */
export function captureRows(predicate, into) {
  return (text) => {
    for (const r of parseRows(text) ?? []) if (predicate(r)) into.push(r);
    return text;
  };
}

/**
 * A `rewrite` transform that PREPENDS `rows` to a pull page (GAP-2's replay). In front, never behind:
 * the client asks its next page `after` the LAST row's `createdAt`, and a replayed row is old - put
 * last, it would send the drain back over rows this page already delivered.
 */
export function injectRows(rows) {
  return (text, record) => {
    const page = parseRows(text) ?? [];
    record.injected = rows.map((r) => r.id);
    return JSON.stringify([...rows, ...page]);
  };
}

/**
 * A captured row, re-addressed to another device of the campaign - how W2's OWN frame, captured from
 * W1's pull, is handed back to W2 (GAP-2's "own" case).
 */
export const readdressRow = (row, { recipientId, deviceId }) => ({ ...row, recipientId, deviceId });

/**
 * A `rewrite-url` function that makes a pull START after `createdAt` (GAP-3) - only the FIRST page,
 * which is the one without an `after` of its own; the client's own paging continues from there.
 */
export function startAfter(createdAt) {
  return (original) => {
    const u = new URL(original);
    if (u.searchParams.has('after')) return original;
    u.searchParams.set('after', createdAt);
    return u.toString();
  };
}

/** The lines W2's console wrote about `groupId`, sorted by what a GAP row asks of them. */
export function linesAbout(lines, groupId) {
  const short = String(groupId).slice(0, 8);
  const about = (lines ?? []).map((l) => (typeof l === 'string' ? l : l.text)).filter((t) => t.includes(short));
  return {
    gap: about.filter((t) => t.includes(`[GAP] ${short}`)),
    rung2: about.filter((t) => t.includes('forget + welcome_request')),
    lost: about.filter((t) => t.includes(`[MLS] LOST frame for ${short}`)),
    generationGap: about.filter((t) => t.includes(`[MLS] LOST frame for ${short}`) && t.includes('generation too far ahead')),
    duplicate: about.filter((t) => t.includes(`[MLS] Duplicate delivery for ${short}`)),
    reAdd: about.filter((t) => t.includes(`[MLS] Decryption error for ${short}`)),
  };
}

/**
 * GAP-1: the commits were taken out of the pull and rung 1's fetch was held, so the frames of N+2 met
 * a member at N; once the fetch was released every frame shows ONCE, and none was given up.
 *
 * @param {{dropped: string[], held: number, shown: Record<string, number>, lines: ReturnType<typeof linesAbout>}} p
 */
export function gapOneOwn({ dropped, held, shown, lines }) {
  const out = [
    { what: `the commits were taken out of W2's pull (${dropped.length} row(s))`, ok: dropped.length >= 2 },
    { what: `rung 1's commit-log fetch was held while the frames arrived (${held})`, ok: held >= 1 },
    { what: `W2 met the gap and said so (${lines.gap.length} [GAP] line(s))`, ok: lines.gap.length >= 1 },
  ];
  for (const [m, n] of Object.entries(shown)) out.push({ what: `${m} shows ONCE on W2 (${n})`, ok: n === 1 });
  out.push({ what: `no frame given up (${lines.lost.length} LOST line(s))`, ok: lines.lost.length === 0 });
  out.push({ what: `rung 1 healed it: no forget + re-Welcome (${lines.rung2.length})`, ok: lines.rung2.length === 0 });
  return out;
}

/**
 * GAP-2: frames from three epochs past - another member's and W2's own - delivered again. Classified
 * (a duplicate, or nothing to say for our own) and never an epoch gap, a re-add or a loss; the epoch
 * does not move and each message still shows once.
 *
 * @param {{injected: number, epochBefore: number, epochAfter: number, shown: Record<string, number>, lines: ReturnType<typeof linesAbout>}} p
 */
export function pastFrameOwn({ injected, epochBefore, epochAfter, shown, lines }) {
  const out = [
    { what: `two past-epoch frames were delivered again to W2 (${injected})`, ok: injected === 2 },
    { what: `the other member's frame was classified a duplicate and ACKed (${lines.duplicate.length})`, ok: lines.duplicate.length >= 1 },
    { what: `never read as an epoch gap (${lines.gap.length} [GAP] line(s))`, ok: lines.gap.length === 0 },
    { what: `never a re-add (${lines.reAdd.length})`, ok: lines.reAdd.length === 0 },
    { what: `never counted a loss (${lines.lost.length} LOST line(s))`, ok: lines.lost.length === 0 },
    { what: `the replay moved no epoch (${epochBefore} -> ${epochAfter})`, ok: epochBefore === epochAfter },
  ];
  for (const [m, n] of Object.entries(shown)) out.push({ what: `${m} still shows ONCE on W2 (${n})`, ok: n === 1 });
  return out;
}

/**
 * GAP-3: W2's first frame is more than the forward distance ahead. It is named a GENERATION gap and
 * the group is re-joined (the ladder), never treated as an epoch gap; W2 then reads the epoch the
 * invariant sends in.
 *
 * @param {{skipped: number, cutAt: string|null, lines: ReturnType<typeof linesAbout>}} p
 */
export function tooDistantOwn({ skipped, cutAt, lines }) {
  return [
    { what: `W2's pull started past ${skipped} frames (${cutAt ?? 'no cut point'})`, ok: !!cutAt && skipped >= 2001 },
    { what: `TooDistantInTheFuture named as a generation gap (${lines.generationGap.length})`, ok: lines.generationGap.length >= 1 },
    { what: `never an epoch-gap loop (${lines.gap.length} [GAP] line(s))`, ok: lines.gap.length === 0 },
    { what: `never a re-add of a healthy membership (${lines.reAdd.length})`, ok: lines.reAdd.length === 0 },
  ];
}
