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
