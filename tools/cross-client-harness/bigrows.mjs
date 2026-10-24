/**
 * THE LARGE-GROUP ROWS OF THE 1.4.1 CAMPAIGN - BIG-1..3 - their table and judges.
 *
 * Pure, so `archive/big-selftest.mjs` pins every judge on a checkout with no rig; the action is
 * `archive/big.mjs`. `docs/wiki/cross-client-campaign-1-4-1.md` section 4.8 is the plan. Every seat
 * the rig has is in play: the owner on W1, W3, W6, A1 and I1, the peer on W2 and W7, the third
 * account on W4 and W8, the fourth on W5 (`names.example.mjs`).
 */

/** Every seat of the large rows, in the order they are opened. */
export const BIG_SEATS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'A1', 'I1'];

/** The rows `archive/big.mjs` plays. */
export const BIG_ROWS = {
  'BIG-1': {
    devices: BIG_SEATS,
    phones: ['A1', 'I1'],
    what: "W1 creates a group and adds the three other accounts in ONE bulk Add: one commit, every device reads the first message, and each phone's checkpoint time is read",
  },
  'BIG-2': {
    devices: BIG_SEATS,
    senders: ['W1', 'W2', 'W4'],
    perSender: 10,
    // W1'S OWN SENDS CARRY THE TWO COMMITS: a leaf refresh armed before its 4th and its 7th message.
    commitsBefore: [3, 6],
    what: '30 rapid messages from three senders while two commits land in the middle: every message once, in order, on every device',
  },
  'BIG-3': {
    devices: BIG_SEATS,
    senders: ['W1', 'W2'],
    removed: 'W4',
    newcomer: 'W5',
    what: "a community of every seat but the fourth account: the third account is removed, then the fourth joins - one new seed per event per sender, the removed seat reads nothing after, the newcomer reads only from its admission",
  },
};

const low = (s) => String(s ?? '').toLowerCase();

/** The `[MLS] Encrypted state checkpoint persisted. (N ms)` durations in a console, in order. */
export function checkpointMs(lines) {
  const out = [];
  for (const l of lines ?? []) {
    const m = /\[MLS\] Encrypted state checkpoint persisted\. \((\d+) ms\)/.exec(l);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/**
 * BIG-1: one commit for the bulk Add; every device listed and reading the first message once; a
 * checkpoint duration read on each phone.
 *
 * @param {object} p
 * @param {number} p.accepts commits accepted since the Add began
 * @param {Record<string, number|null>} p.listed per device, ms until it listed the group, or null
 * @param {Record<string, number>} p.shown per device, how many times the first message shows
 * @param {Record<string, number[]>} p.checkpoints per phone, the checkpoint durations read after the Add
 */
export function bulkAddOwn({ accepts, listed, shown, checkpoints }) {
  return [
    { what: `the bulk Add is ONE commit (${accepts} accepted)`, ok: accepts === 1 },
    ...Object.entries(listed).map(([d, ms]) => ({ what: `${d} lists the group (${ms === null ? 'never' : `${ms} ms`})`, ok: ms !== null })),
    ...Object.entries(shown).map(([d, n]) => ({ what: `${d} reads the first message once (${n})`, ok: n === 1 })),
    ...Object.entries(checkpoints).map(([d, ms]) => ({ what: `${d}'s checkpoint time was read (${ms.length ? `${ms.join(', ')} ms` : 'no line'})`, ok: ms.length > 0 })),
  ];
}

/**
 * Whether each sender's messages appear in the order sent, from their row positions on one device.
 *
 * @param {Record<string, (number|undefined)[]>} positionsBySender sender -> the positions of its marks, in send order
 */
export function inSendOrder(positionsBySender) {
  return Object.fromEntries(
    Object.entries(positionsBySender).map(([s, ps]) => [s, ps.every((p) => typeof p === 'number') && ps.every((p, i) => i === 0 || p > ps[i - 1])])
  );
}

/**
 * BIG-2: two commits landed, and on every device every message shows once and each sender's in order.
 *
 * @param {object} p
 * @param {number} p.accepts commits accepted during the burst
 * @param {number} p.expectedCommits how many the row armed
 * @param {Record<string, {counts: Record<string, number>, ordered: Record<string, boolean>}>} p.perDevice
 */
export function burstOwn({ accepts, expectedCommits, perDevice }) {
  const out = [{ what: `${expectedCommits} commits landed during the burst (${accepts})`, ok: accepts === expectedCommits }];
  for (const [d, r] of Object.entries(perDevice)) {
    const wrong = Object.entries(r.counts).filter(([, n]) => n !== 1);
    out.push({ what: `${d} shows every message once (${wrong.length ? wrong.map(([m, n]) => `${m}x${n}`).join(' ') : 'all once'})`, ok: wrong.length === 0 });
    const disordered = Object.entries(r.ordered).filter(([, ok]) => !ok).map(([s]) => s);
    out.push({ what: `${d} shows each sender's messages in send order (${disordered.length ? `NOT ${disordered.join(' ')}` : 'yes'})`, ok: disordered.length === 0 });
  }
  return out;
}

/**
 * The Graine sessions each author's salon messages were sealed under, per PHASE: the phases are cut
 * at each event's instant (`[start, removal)`, `[removal, join)`, `[join, ...)`).
 *
 * @param {{authorId: string, sessionId: string, at: string}[]} rows the salon's messages, oldest first
 * @param {string[]} cuts the ISO instants that begin phase 1, 2...
 * @returns {Record<string, string[][]>} author -> per phase, its distinct session ids
 */
export function sessionsByPhase(rows, cuts) {
  const phaseOf = (at) => cuts.filter((c) => at >= c).length;
  const out = {};
  for (const r of rows ?? []) {
    const a = low(r.authorId);
    out[a] ??= cuts.map(() => []).concat([[]]);
    const p = phaseOf(r.at);
    if (!out[a][p].includes(r.sessionId)) out[a][p].push(r.sessionId);
  }
  return out;
}

/**
 * BIG-3: one seed per event per sender, never one per epoch; the removed account reads nothing after
 * its removal; the newcomer reads from its admission only.
 *
 * @param {object} p
 * @param {Record<string, string[][]>} p.sessions `sessionsByPhase` for the senders
 * @param {string[]} p.senders the senders' user ids
 * @param {Record<string, number>} p.removedShown per removed device, how many post-removal messages it shows
 * @param {boolean} p.removedSeated the removed account still holds an active seat in the community's group
 * @param {{before: number, after: number}} p.newcomer how many messages from before and after its admission it shows
 * @param {number} p.afterExpected how many post-admission messages were sent
 */
export function seedPerEventOwn({ sessions, senders, removedShown, removedSeated, newcomer, afterExpected }) {
  const out = [];
  for (const s of senders) {
    const phases = sessions[low(s)] ?? [];
    const counts = phases.map((p) => p.length);
    out.push({ what: `${low(s).slice(0, 8)} sealed each phase under ONE session (${counts.join('/') || 'none'})`, ok: phases.length === 3 && counts.every((n) => n === 1) });
    const all = phases.flat();
    out.push({ what: `${low(s).slice(0, 8)} rotated once per event - three distinct sessions over three phases (${new Set(all).size})`, ok: phases.length === 3 && new Set(all).size === 3 });
  }
  for (const [d, n] of Object.entries(removedShown)) out.push({ what: `the removed ${d} shows nothing written after its removal (${n})`, ok: n === 0 });
  out.push({ what: `the removed account holds no seat in the community's group (${removedSeated ? 'STILL seated' : 'gone'})`, ok: removedSeated === false });
  out.push({ what: `the newcomer reads nothing from before its admission (${newcomer.before})`, ok: newcomer.before === 0 });
  out.push({ what: `the newcomer reads what was written after it (${newcomer.after}/${afterExpected})`, ok: newcomer.after === afterExpected });
  return out;
}

/**
 * The community's own invariant: every member holds an active seat in the community's group, and
 * no one else does - shaped like `checkInvariant`'s result for `composeVerdict`.
 *
 * @param {object} p
 * @param {string} p.pass
 * @param {{devices: {userId: string, status: string}[]}|null} p.dist `communityDistribution`
 * @param {string[]} p.members the community's member ids
 * @param {string[]} p.users the users this row put in play
 */
export function communityEntitlement({ pass, dist, members, users }) {
  const failures = [];
  if (!dist) failures.push({ invariant: 'C', what: "the community's group is not on the server" });
  else {
    const memberSet = new Set((members ?? []).map(low));
    for (const u of users) {
      const seated = dist.devices.some((d) => low(d.userId) === low(u) && d.status === 'active');
      if (memberSet.has(low(u)) !== seated) failures.push({ invariant: 'C', what: `${low(u).slice(0, 8)} is ${memberSet.has(low(u)) ? 'a member' : 'not a member'} but ${seated ? 'holds' : 'holds no'} active seat in the community's group` });
    }
  }
  return { ok: failures.length === 0, passes: [{ pass, ok: failures.length === 0, failures, approximations: [{ invariant: 'C', what: "a community salon is not a sidebar conversation: section 4.0's message probe is replaced by the membership check" }] }] };
}
