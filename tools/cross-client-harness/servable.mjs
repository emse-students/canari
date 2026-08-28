/**
 * WHICH ROWS A GIVEN RESPONDER COULD ACTUALLY HAVE SERVED - the predicate, with nothing attached.
 *
 * IT IS A MODULE AND NOT A CLOSURE INSIDE `healnew.mjs`, FOR THE FOURTH TIME IN ONE DAY. A predicate
 * whose only home is a CLI entry point is a predicate no test can reach and every neighbour
 * re-implements approximately: `gate-probe.mjs` was the first (three copies of "is the PIN gate up",
 * the loosest deciding), `native-residue.mjs` the second, `ready-probe.mjs` the third. This one
 * decides a VERDICT - whether a row passes, fails, or cannot be observed at all - so a rule nobody
 * can exercise off-machine is a rule nobody can check before it is believed.
 *
 * THE FACT BEHIND IT, MEASURED 2026-08-28 AND NOT RE-DERIVED FROM A FAIL. A responder can only answer
 * a re-admission request for a group it is a member of. `dm_device_group_memberships` says the
 * campaign owner holds ELEVEN active groups while the peer that shares the most shares TWO, so a row
 * whose responder is the PEER cannot reach "every row healed" however correct the app is. The claim
 * that IS about the code is the subset: every group the responder could have served, did heal.
 *
 * FULL IDS IN, FULL IDS OUT. The join is between two browser contexts and can only happen here, so
 * it happens on whole values; `cut` is applied by whoever writes the result down. Eight characters
 * would be enough to compare two reads and NOT enough to join two worlds: a collision would put a
 * group the responder is not in INTO the subset, and the row would then demand a heal that nothing
 * online could serve - a false FAIL, which is the one direction a rig must never round towards.
 */

/**
 * Splits a sidebar read into the rows the responder is a member of and the rest.
 *
 * A `removed` tile is in NEITHER: a deleted group is dead, not in transit, and it can no more be
 * served than it can heal. A tile with no id is counted as outside and reported by the caller as a
 * reader fault - `unhooked` already covers the same failure for `data-ready`.
 */
export function splitBySubset(tiles, ids) {
  const has = (t) => !!t.id && ids.has(t.id);
  return {
    inTheSubset: (tiles ?? []).filter((t) => has(t) && !t.removed),
    outside: (tiles ?? []).filter((t) => !has(t) || t.removed),
  };
}

/**
 * The termination proof for a subset row: every row the responder could serve is ready.
 *
 * TERMINATION IS A PROOF, NEVER A CLOCK, AND THIS IS A DIFFERENT PROOF - not a weaker one. Waiting
 * for the whole sidebar on a peer-responder row burns the deadline every time and then reports a
 * stall that nothing online could have prevented; waiting for the subset ends the moment the claim
 * is true. `unhooked` still voids it, because a reader that no longer matches the markup cannot
 * report on any subset either.
 *
 * AN EMPTY SUBSET IS NOT SETTLED HERE. `every` over an empty list is true, and that would make the
 * one row that cannot be run the fastest PASS on the board - so emptiness is refused explicitly.
 * The caller still has to reject it BEFORE watching, as `INVALID`; this is the second guard, on the
 * one predicate that would otherwise be silently vacuous.
 */
export const subsetSettled = (ids) => (x) => {
  if (!x.panel || !(x.rows > 0) || x.unhooked !== 0) return false;
  const { inTheSubset } = splitBySubset(x.tiles, ids);
  return inTheSubset.length > 0 && inTheSubset.every((t) => t.ready);
};
