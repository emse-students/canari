/**
 * KICK-COMMIT, SALON-REVOKE-COMMIT, DEVREVOKE-KEYGROUP - A REMOVAL IS COMMITTED, NOT ONLY UNROUTED.
 *
 * Three gestures take someone out of a key group: a community kick, a revoke of a private salon's
 * access, and a device revoke. Each must end with the departed leaves REMOVED FROM THE GROUP'S TREE -
 * a commit that advances the group's epoch - and not only with the server no longer routing to them.
 * The two are different facts read in different places: the delivery roster
 * (`dm_device_group_memberships`) is routing, and only an epoch advance by a commit says the tree
 * moved. Runner `archive/removals.mjs`; this file is the table and the judge, pure.
 *
 * WHO COMMITS. A kick and a salon revoke are committed by THE ACTOR'S OWN SESSION, AS IT IS, with no
 * reload - the gesture is the trigger. A device revoke is committed by any device of the group that
 * remains; the revoked device can never be the one.
 *
 * WHAT THE JUDGE DOES NOT PROVE. The commit log (`mls_commit_log`) records a commit's group, base epoch,
 * sender device and ciphertext - not its kind, nor which leaves it removed. So a PASS here says: the
 * subject is no longer routed, AND the epoch advanced by a commit of the right committer after the
 * gesture. It does NOT say that commit removed the subject's leaf; a commit of another kind by the same
 * device in the window would pass it. Reading the tree itself needs a client that reports its group's
 * members, which nothing here has yet - the limit is stated on the board too.
 *
 * ROUNDS, NOT CLOCKS. After the gesture each group's epoch is read once per round, at most
 * {@link COMMIT_ROUNDS} rounds; the round it moved in is the measurement, and `null` is "it did not".
 */
import { salonNarration } from './salonrows.mjs';
import { atLevels } from './watch.mjs';

/** Pause between two reads of the groups' epochs. A round is one read of every group plus this. */
export const ROUND_MS = 500;
/** Rounds a removal's commit is waited for after its gesture. */
export const COMMIT_ROUNDS = 30;

/**
 * The rows. `devices`: the seats the row drives, read by `checks.mjs` `ROW_TABLES` for the preflight
 * (DEVREVOKE-KEYGROUP mints W3 itself, and still names it so the preflight reaches it). `committer`: `'actor'` - only a device of the actor seat may commit the removal;
 * `'remaining'` - any device but the removed one. `groups`: the key groups the subject must have been
 * routed on before the gesture, by scope, for the row to be armed.
 */
export const REMOVAL_ROWS = {
  'KICK-COMMIT': {
    actor: 'W1',
    subject: 'W2',
    committer: 'actor',
    devices: ['W1', 'W2'],
    groups: ['community', 'salon'],
    what: "W1 removes W2's account from a community whose public and private salons it held: the community's key group and the private salon's each advance by a commit of W1's session, without a reload",
  },
  'SALON-REVOKE-COMMIT': {
    actor: 'W1',
    subject: 'W2',
    committer: 'actor',
    devices: ['W1', 'W2'],
    groups: ['salon'],
    what: "W1 revokes W2's access to a private salon and opens the salon again the way the rig does: the salon's key group advances by a commit of W1's session, without a reload",
  },
  // THE REVOKE IS DRIVEN FROM W6, NOT W1: the device panel is reached by a full navigation
  // (`purge-devices.mjs`), so the seat that drives it reloads. W1 stays loaded and untouched, and
  // the commit that removes the leaf may come from any device that remains.
  'DEVREVOKE-KEYGROUP': {
    actor: 'W6',
    subject: 'W3',
    committer: 'remaining',
    devices: ['W1', 'W6', 'W3'],
    groups: ['community', 'salon'],
    what: "W6 revokes a fresh device of the owner account (W3) that loaded a community and its private salon: every key group the device was routed on advances by a commit of a remaining device",
  },
};

/**
 * One row's verdict from what it measured.
 *
 * `m.groups`: per key group `{ groupId, scope, before, after, movedAtRound, routedBefore, routedAfter,
 * commits: [{ senderDeviceId, baseEpoch }] }`; `m.actorDevices` and `m.subjectDevices`: device ids;
 * `m.reloaded`: whether the actor's page was reloaded between the gesture and the last read.
 *
 * VACUOUS when the row was not armed - a scope it needs has no group the subject was routed on
 * before the gesture - because a group the subject never reached cannot show its removal.
 *
 * @returns {{ verdict: 'PASS'|'FAIL'|'VACUOUS', failures: string[] }}
 */
export function removalOwn(row, m) {
  const spec = REMOVAL_ROWS[row];
  const groups = m.groups ?? [];
  const missing = spec.groups.filter((scope) => !groups.some((g) => g.scope === scope && g.routedBefore));
  if (missing.length) return { verdict: 'VACUOUS', failures: [`not armed: the subject was routed on no ${missing.join(' or ')} key group before the gesture`] };
  const failures = [];
  const subject = new Set(m.subjectDevices ?? []);
  const actor = new Set(m.actorDevices ?? []);
  for (const g of groups) {
    const tag = `${g.scope} group ${String(g.groupId).slice(0, 8)}`;
    // NO EPOCH READ BEFORE THE GESTURE IS NO BASELINE: `epoch > null` is true in JavaScript, so a
    // missing read would pass every comparison below as "moved".
    if (g.before === null || g.before === undefined) {
      failures.push(`${tag}: no epoch was read before the gesture - nothing to compare against`);
      continue;
    }
    if (g.routedAfter) failures.push(`${tag}: the subject is still routed after the gesture`);
    if (g.movedAtRound === null) {
      failures.push(`${tag}: the epoch did not advance past ${g.before} within ${COMMIT_ROUNDS} rounds`);
      continue;
    }
    const removal = (g.commits ?? []).filter((c) => c.baseEpoch >= g.before);
    const by = spec.committer === 'actor' ? removal.filter((c) => actor.has(c.senderDeviceId)) : removal.filter((c) => !subject.has(c.senderDeviceId));
    if (!by.length) failures.push(`${tag}: no commit from epoch ${g.before} on was sent by ${spec.committer === 'actor' ? "the actor's session" : 'a remaining device'} (${JSON.stringify(removal)})`);
  }
  if (spec.committer === 'actor' && m.reloaded) failures.push("the actor's page was reloaded - the removal must come from the session as it is");
  return { verdict: failures.length ? 'FAIL' : 'PASS', failures };
}

// ── narration ─────────────────────────────────────────────────────────────────────────────────────
//
// WHAT A REMOVAL ROW MAKES ITS SEATS SAY, read on the first runs that reached judging (`1.5.1-alpha.6`,
// 2026-10-29: KICK-COMMIT, SALON-REVOKE-COMMIT, DEVREVOKE-KEYGROUP). Every line is a decision log of
// something the row itself did - build its community, admit the peer, send one message, make its
// gesture - and every needle is SCOPED to the row's own ids (community, channels, key groups, the
// owner and the subject) and pinned to the level the app writes it. Another id, another level, or a
// count that says something went wrong stays dirt.
//
// NOT HERE, ON PURPOSE (each is fixed at the product, never forgiven - backlog):
// - Graine's `holds nothing of community ...` and `absorbed 0/0 seed(s)`: said once per READ, not per
//   decision (the same exclusion `salonNarration` states);
// - the read-mark 404 for a deleted salon, retried forever;
// - a page's boot narration: `removals.mjs` adds `PAGE_BOOT_NARRATION` only to a seat whose window
//   saw a document replaced, as `observersOf` does, so a page that booted unasked is still a finding.

const short = (id) => String(id).slice(0, 8);
const anyOf = (ids) => `(?:${[...new Set((ids ?? []).filter(Boolean).map(short))].join('|') || '(?!)'})`;
const at = (levels, s) => atLevels(levels, new RegExp(`^${s}$`));
const D = ['debug'];
const L = ['log'];
const I = ['info'];
const N = String.raw`\d+`;
/** One or more: a count of zero is a different sentence (nothing happened) and stays dirt. */
const P = String.raw`[1-9]\d*`;
/** A device id as the app shortens it: `web-` or `tauri-`, the user's first eight hex, then the install suffix. */
const DEV = (u) => String.raw`(?:web|tauri)-${u}…-[0-9a-z]+-[0-9a-z]+`;

/**
 * The row's ids the narration is scoped to.
 *
 * @typedef {object} RemovalIds
 * @property {string} workspaceId the row's community
 * @property {string[]} channelIds every channel of it (`communityChannels`)
 * @property {string[]} keyGroupIds every key group of it: the community's and each salon's
 * @property {string} ownerUserId the owner account (W1, W6, and the minted W3)
 * @property {string|null} subjectUserId the peer account a kick or a salon revoke removes (W2), or null
 */

/**
 * What every seat of a removal row says about the row's community and its one salon message: the
 * community build and join (`salonNarration`), the device notices that sort the owner's other devices
 * entering the row's KEY GROUPS - a key group is not a conversation, so the notice layer says nothing
 * and logs that it said nothing - and the decision that those devices are not new here.
 *
 * `+0 undecided` is pinned: an event the notices could not decide is the odd case.
 *
 * @param {RemovalIds} ids
 */
function communityNarration(ids) {
  const kg = anyOf(ids.keyGroupIds);
  return [
    ...salonNarration({ workspaceId: ids.workspaceId, channelIds: ids.channelIds, keyGroupIds: ids.keyGroupIds }),
    at(D, String.raw`\[TRUST\] ${P} device event\(s\) handed to the notices \(drain end\)`),
    at(D, String.raw`\[DEVICE_NOTICE\] ${P} device event\(s\) to sort \(\+0 undecided\)`),
    at(D, String.raw`\[DEVICE_NOTICE\] self-admitted entry in ${kg}\.\.\. - not a conversation, nothing to say`),
    at(L, String.raw`\[DEVICE_NOTICE\] ${P} device\(s\) seen for the first time here are not new`),
  ];
}

/**
 * The owner seat that SENDS the row's one salon message (`removals.mjs` `send`): the view following
 * the new row, the echo sent and settled under the server's id, the unsent ledger cleared, and - once
 * per page life - the proof that the server echoes a client id. `0 waiting repeat(s)` is pinned: a
 * repeat that was waiting is a send that went twice. The owner's OTHER devices ask it for the new
 * community's history (the seed it minted for that message), and it answers them with at least one
 * seed; an answer to another user's device stays dirt.
 *
 * @param {RemovalIds} ids
 */
function senderNarration(ids) {
  const o = short(ids.ownerUserId);
  return [
    at(D, String.raw`\[CHAT_VIEW\] channel_ messages ${P} \(hasNewMessage=true, response=follow-bottom\)`),
    at(L, String.raw`\[SALON-ECHO\] [0-9a-f]{8}… sending`),
    at(L, String.raw`\[SALON-ECHO\] [0-9a-f]{8}… settled as [0-9a-f]{8}…`),
    at(D, String.raw`\[SALON-UNSENT\] ${P} entr\(y/ies\) forgotten: the server holds them`),
    at(L, String.raw`\[SALON-REPEAT\] the server echoed client id [0-9a-f]{8}\.\.\.: a repeated send is answered with its row - 0 waiting repeat\(s\) released`),
    at(I, String.raw`\[GRAINE\] answered ${o}…:${DEV(o)} with ${P} seed\(s\) in ${P} page\(s\)`),
  ];
}

/**
 * The actor's gesture, as `commitRemoval.ts` and `departureCommitter.ts` say it - the very commits
 * the row judges. A KICK registers the subject's private salons and commits the community and each
 * salon from this device; the departure bookkeeping says the actor's own leaf is left to it. A SALON
 * REVOKE says only the departure. Every needle names the row's community, salon and subject.
 *
 * @param {string} row
 * @param {RemovalIds} ids
 */
function gestureNarration(row, ids) {
  const ws = short(ids.workspaceId);
  const ch = anyOf(ids.channelIds);
  const s = short(ids.subjectUserId);
  const o = short(ids.ownerUserId);
  const departure = (where) => at(L, String.raw`\[GRAINE\] DEPARTURE ${s} from ${where}: the actor's device ${o} holds a leaf - left to it; decided again only if it releases it`);
  if (row === 'KICK-COMMIT') {
    return [
      at(L, String.raw`\[GRAINE\] REMOVE community ${ws}: ${s} kicked from the community - committing it from this device`),
      at(L, String.raw`\[GRAINE\] REMOVE ${s}: ${P} private salon\(s\) of ${ws} registered here - each committed in turn`),
      at(L, String.raw`\[GRAINE\] REMOVE salon ${ch} of ${ws}: ${s} kicked from the community - committing it from this device`),
      departure(`community ${ws}`),
      departure(`salon ${ch} of ${ws}`),
    ];
  }
  if (row === 'SALON-REVOKE-COMMIT') {
    // The access panel is a side panel on this viewport; going back to the salon closes it.
    return [departure(`salon ${ch} of ${ws}`), at(D, String.raw`\[historyOverlay\] a navigation closes ${P} open overlay\(s\)`)];
  }
  return [];
}

/**
 * The subject W2, admitted to the row's community and salon by the actor: the Welcome of the salon's
 * key group (in `salonNarration`), the seed the actor's message rode on verified against the tree,
 * the drain re-reading the salon once for it, and the salon opened.
 *
 * @param {RemovalIds} ids
 */
function subjectNarration(ids) {
  const ch = anyOf(ids.channelIds);
  const o = short(ids.ownerUserId);
  return [
    at(D, String.raw`\[GRAINE\] seed [A-Za-z0-9_-]{16,} from ${o}… for channel ${ch} - v2 endorsement verified from the tree`),
    at(D, String.raw`\[GRAINE\] drain over - re-reading ${P} salon\(s\) once for the seeds it brought`),
    at(D, String.raw`\[notificationPreferences\.fetchChannelLevel\(${ch}…\)\]`),
    at(D, String.raw`\[CHAT_VIEW\] channel_ messages ${P} \(hasNewMessage=true, response=(?:follow-bottom|repin-entry)\)`),
  ];
}

/**
 * DEVREVOKE-KEYGROUP's minted owner device (W3), as the owner seat W1 meets it - the admission rule
 * of 2026-10-23 working as decided: the owner is told once at first sight; each conversation the new
 * device asks to enter waits for a member's approval instead of an automatic Add (one `WELCOME_REQ`
 * and one `JOIN_REQUEST` per conversation, both naming the owner's own account); and its history ask
 * in the row's community is answered by withholding the seed of a salon riding another key group, said
 * as "withheld", never as "I hold nothing". Another account, another community, or a user-level join
 * ask (no device) stays dirt.
 *
 * @param {RemovalIds} ids
 */
function mintedDeviceNarration(ids) {
  const ws = short(ids.workspaceId);
  const o = short(ids.ownerUserId);
  return [
    at(L, String.raw`\[DEVICE_NOTICE\] a new device was added to this account \(first-sight\)`),
    at(L, String.raw`\[WELCOME_REQ\] ${o}…:web-${o}\.\.\. is a device this one never saw, of a member of [0-9a-f]{8}\.\.\. - not added automatically, a member's approval of key [0-9a-f]{8}… is asked`),
    at(L, String.raw`\[JOIN_REQUEST\] an unseen device web-${o}\.\.\. of ${o}… asks to join [0-9a-f]{8}\.\.\. under key [0-9a-f]{8}… - a member's answer is awaited`),
    at(I, String.raw`\[GRAINE\] withholding ${P} seed\(s\) from ${o}… on community ${ws}: ${N} of a salon riding another key group, ${N} not listed on this device`),
    at(I, String.raw`\[GRAINE\] not answering ${o}…'s history ask in community ${ws}: ${P} seed\(s\) withheld for their salon's roster - not "I hold nothing"`),
  ];
}

/**
 * The narration a seat is given in a removal row: by row, by seat, by role, scoped to the row's ids -
 * and nothing else. W1 builds the community and sends in every row; it is the actor of a kick and a
 * salon revoke, and the owner seat that meets the minted W3 in DEVREVOKE-KEYGROUP. W2 is the subject
 * of a kick and a salon revoke. Any other seat, or a seat outside its row, gets nothing.
 *
 * @param {string} row a `REMOVAL_ROWS` id
 * @param {string} seat
 * @param {RemovalIds} ids
 */
export function removalNarration(row, seat, ids) {
  const spec = REMOVAL_ROWS[row];
  if (!spec || !ids?.workspaceId) return [];
  if (seat === 'W1') {
    return [...communityNarration(ids), ...senderNarration(ids), ...gestureNarration(row, ids), ...(spec.subject === 'W3' ? mintedDeviceNarration(ids) : [])];
  }
  if (seat === 'W2' && spec.subject === 'W2') return [...communityNarration(ids), ...subjectNarration(ids)];
  return [];
}
