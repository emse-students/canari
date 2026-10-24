/**
 * THE FLOOR ROWS OF THE 1.4.1 CAMPAIGN - their table and their own judgements, pure.
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2, "FLOOR - re-proved on dev, in the same
 * session, before anything else". The runner is `archive/floor.mjs`; this module holds only what a
 * checkout with no rig can test (`archive/floor-selftest.mjs`): what each row needs, and whether the
 * row's OWN question was answered. The five invariants of section 4.0 are judged by
 * `invariantverdict.mjs`, and the two are composed by `rowkit.mjs` `composeVerdict`.
 *
 * Every judge returns `{what, ok}[]` - each assertion NAMED, so a `FAIL` says which part of the row's
 * `PASS entails` column did not hold, and a row whose condition makes the good outcome impossible
 * fails on it (the plan's own rule for the column).
 */
import { commitsSince } from './rowkit.mjs';

/** What each FLOOR row needs. `devices` are the seats it opens and watches; `class` and `minutes` are the plan's. */
export const FLOOR_ROWS = {
  'FLOOR-1': { devices: ['W1', 'W2'], class: 'U', minutes: 10 },
  'FLOOR-2': { devices: ['W1', 'W2', 'W4', 'W5'], class: 'U', minutes: 15 },
  // FLOOR-2's group, seen from the two phones as well: the four browsers stay in play so "one tree"
  // is judged across all six clients, not between the two phones alone.
  'FLOOR-3': { devices: ['W1', 'W2', 'W4', 'W5', 'A1', 'I1'], class: 'B', minutes: 15, phones: ['A1', 'I1'] },
};

/** FLOOR-1's "< 2 s": from the sender's send to the receiver's first rendering of the marker. */
export const FLOOR1_BOUND_MS = 2000;

/**
 * FLOOR-1: "one copy, < 2 s, right author", both ways, and still one copy after a reload.
 *
 * @param {{from: string, to: string, marker: string, arrivalMs: number|null,
 *          receiver: {count: number, own: boolean|null}, sender: {count: number, own: boolean|null}}[]} legs
 *   one per direction; `arrivalMs` null when the receiver never rendered it within the bound's window
 * @param {{device: string, marker: string, count: number}[]} afterReload each marker re-counted on each side after the reload
 * @returns {{what: string, ok: boolean}[]}
 */
export function floor1Own(legs, afterReload) {
  const out = [];
  if (legs.length !== 2) out.push({ what: `two directions sent, not ${legs.length}`, ok: false });
  for (const l of legs) {
    const tag = `${l.from}->${l.to} ${l.marker}`;
    out.push({
      what: `${tag}: arrived in under ${FLOOR1_BOUND_MS} ms (${l.arrivalMs === null ? 'never' : `${l.arrivalMs} ms`})`,
      ok: l.arrivalMs !== null && l.arrivalMs < FLOOR1_BOUND_MS,
    });
    out.push({ what: `${tag}: ONE copy on the receiver (${l.receiver.count})`, ok: l.receiver.count === 1 });
    // A DM SHOWS NO SENDER NAME, so "right author" is own-ness: the receiver shows it as another's,
    // the sender as its own - a message attributed to the wrong side flips one of the two.
    out.push({ what: `${tag}: the receiver shows it as another's`, ok: l.receiver.own === false });
    out.push({ what: `${tag}: ONE copy on the sender (${l.sender.count}), shown as its own`, ok: l.sender.count === 1 && l.sender.own === true });
  }
  if (!afterReload.length) out.push({ what: 'the markers were re-counted after the reload', ok: false });
  for (const r of afterReload) out.push({ what: `${r.device} after the reload: ONE copy of ${r.marker} (${r.count})`, ok: r.count === 1 });
  return out;
}

/**
 * FLOOR-2: "one commit, every device `active`" after ONE bulk Add of three users into a fresh group.
 *
 * @param {object} p
 * @param {number} p.fromEpoch the server's activeEpoch after the group existed and before the Add
 * @param {{activeEpoch: number, commitEpochs: number[], roster: {userId: string, awaitingAdmission: boolean}[],
 *          seats: {userId: string, deviceId: string, status: string, kicked: boolean}[]}} p.view the server's view after
 * @param {string[]} p.expectUsers every user that must be on the roster: the creator and the three added
 * @param {string[]} p.inPlayDeviceIds the device id each seat in play holds, which must each be an active seat
 * @returns {{what: string, ok: boolean}[]}
 */
export function floor2Own({ fromEpoch, view, expectUsers, inPlayDeviceIds }) {
  const out = [];
  const moved = commitsSince(view.commitEpochs, fromEpoch);
  out.push({ what: `ONE commit since epoch ${fromEpoch} (${moved.length}: ${moved.join(',') || 'none'})`, ok: moved.length === 1 });
  out.push({ what: `the active epoch moved by exactly one (${fromEpoch} -> ${view.activeEpoch})`, ok: view.activeEpoch === fromEpoch + 1 });
  const onRoster = new Map((view.roster ?? []).map((r) => [String(r.userId).toLowerCase(), r]));
  for (const u of expectUsers) {
    const r = onRoster.get(String(u).toLowerCase());
    out.push({ what: `${u.slice(0, 8)} on the roster and admitted`, ok: !!r && r.awaitingAdmission !== true });
  }
  const seats = view.seats ?? [];
  const notActive = seats.filter((s) => s.status !== 'active' || s.kicked);
  out.push({
    what: `every device seat active (${notActive.length ? notActive.map((s) => `${String(s.deviceId).slice(0, 8)}=${s.kicked ? 'kicked' : s.status}`).join(' ') : 'all'})`,
    ok: seats.length > 0 && notActive.length === 0,
  });
  const active = new Set(seats.filter((s) => s.status === 'active' && !s.kicked).map((s) => String(s.deviceId).toLowerCase()));
  for (const d of inPlayDeviceIds) out.push({ what: `the in-play device ${String(d).slice(0, 8)} holds an active seat`, ok: active.has(String(d).toLowerCase()) });
  return out;
}

/**
 * FLOOR-3's premise: both phones were IN PLAY as members of the group. The row's question - both
 * decrypt, one tree - is the invariant's (1) and (3) over them; this only refuses a run that judged
 * one tree without the phones it is about.
 *
 * @param {string[]} phones the phones the row names
 * @param {string[]} membersInPlay the member devices the invariant was run over
 * @returns {string[]} what is missing, for `composeVerdict({premise})`
 */
export const floor3Premise = (phones, membersInPlay) => phones.filter((p) => !membersInPlay.includes(p)).map((p) => `${p} was not in play as a member`);
