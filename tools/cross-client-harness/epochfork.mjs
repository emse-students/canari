/**
 * IS THIS DEVICE AT THE GROUP'S EPOCH - the predicate no row asked, as a pure comparison.
 *
 * Two production conversations sat forked one epoch behind for twenty-four hours, refusing 191 and
 * 172 commits, while every reading the rig took was green: `data-ready` says the list PAINTED, not
 * that the device is in step with the group (`testing-methodology.md`, "A green sidebar tile does not
 * prove the group is not epoch-forked"). The answer is one pair of numbers: the client's own
 * `getEpoch(groupId)` and the server's `activeEpoch` from `GET /api/mls/users/:id/groups`.
 *
 * This module is the comparison only, so a self-test can pin it on a checkout with no rig; the two
 * in-page readers are in `archive/syncrows.mjs`. Ids are compared WHOLE and recorded CUT (`cut`).
 *
 * A PAIR WITH A MISSING HALF IS NEVER "IN STEP". A group the client reports no epoch for is
 * `unknown`, and a report whose client half could not be read at all is `unobservable` - neither is
 * `clean`, because "could not ask" and "asked and it agrees" are different findings.
 */

const cut = (s) => (typeof s === 'string' && s.length > 8 ? s.slice(0, 8) : s);

/**
 * Compare the device's epochs with the server's, per group.
 *
 * @param {Record<string, number>|null} client groupId -> the client's `getEpoch`, or null if unreadable
 * @param {Record<string, number>|null} server groupId -> the server's `activeEpoch`, or null if unreadable
 * @returns {{observable: boolean, clean: boolean, why?: string, inStep: number, behind: object[], ahead: object[], unknown: string[]}}
 */
export function epochForks(client, server) {
  if (!client || !server) {
    return {
      observable: false,
      clean: false,
      why: !server ? 'the server epochs could not be read' : 'the client epochs could not be read',
      inStep: 0,
      behind: [],
      ahead: [],
      unknown: [],
    };
  }
  const behind = [];
  const ahead = [];
  const unknown = [];
  let inStep = 0;
  for (const [groupId, serverEpoch] of Object.entries(server)) {
    const clientEpoch = client[groupId];
    if (typeof clientEpoch !== 'number') {
      unknown.push(cut(groupId));
    } else if (clientEpoch < serverEpoch) {
      behind.push({ group: cut(groupId), client: clientEpoch, server: serverEpoch, lag: serverEpoch - clientEpoch });
    } else if (clientEpoch > serverEpoch) {
      ahead.push({ group: cut(groupId), client: clientEpoch, server: serverEpoch, lead: clientEpoch - serverEpoch });
    } else {
      inStep += 1;
    }
  }
  return {
    observable: true,
    // A device AHEAD of the server holds a commit the server refused or has not recorded: not in step
    // either, and the same fork seen from the other side.
    clean: behind.length === 0 && ahead.length === 0 && unknown.length === 0,
    inStep,
    behind,
    ahead,
    unknown,
  };
}
