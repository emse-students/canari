/**
 * THE GROUPS THIS DEVICE IS CREATING RIGHT NOW - the creation's own state, read by the two sweeps
 * that would otherwise mistake the group for one this device is missing.
 *
 * WHY IT EXISTS. A creation registers the membership BEFORE the local MLS group exists, and that
 * order is an invariant (`createNewGroup`, measured 2026-08-30): from that instant the server LISTS
 * the group for this user and holds a `pending` invitation row for each of the user's other
 * devices, while the conversation row is written only once the group is reachable, at the very end
 * (2026-09-01). Between the two, a connection pass sees exactly the shape of a group this device
 * lost - listed by the server, absent from `conversations` - and acted on it: discovery wrote a
 * `[DISCOVERY] Placeholder` for it and the pending-invitation sweep requested a re-add recovery of
 * it (`absent locally -> recovery requested`), which the recovery seam then refused with `already
 * in WASM`. Measured on the web rig by LEAF-REFRESH-1 (2026-11-16): the row creates a group a
 * second after a reload, inside the connection pass. Nothing was lost, which is why it is a defect
 * and not a design - a race that heals cleanly is still a race.
 *
 * THE OVERLAP IS DELETED, NOT NARROWED. The mark is set synchronously before `registerMember` is
 * sent, and a sweep can only see the group in a server answer produced after that registration was
 * committed - so any sweep that sees the group sees the mark too. The mark is released in the
 * creation's `finally`, after the conversation row is written (success) or the server group deleted
 * (failure): there is no instant at which the group is listed, unmarked and rowless because of an
 * in-flight creation. No clock is involved.
 *
 * PER TAB, AND THAT IS THE RIGHT SCOPE: only the leader tab creates groups (`createGroup` refuses on
 * a follower) and only the leader runs the sweeps (`getIsTabLeader` guards both).
 */

const inCreation = new Set<string>();

/**
 * Marks `groupId` as being created by this device, until the returned release is called.
 *
 * Call it before `registerMember`, release it in the creation's `finally`.
 */
export function markGroupInCreation(groupId: string): () => void {
  inCreation.add(groupId);
  return () => {
    inCreation.delete(groupId);
  };
}

/** Whether this device is creating `groupId` right now - see the module comment. */
export function isGroupInCreation(groupId: string): boolean {
  return inCreation.has(groupId);
}
