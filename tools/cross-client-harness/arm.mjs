/**
 * The one module in this harness that WRITES to production, and the distinction it turns on.
 *
 * `grainedb.mjs` says READ-ONLY, ALWAYS, and gives the reason: *a check that repairs the state it is
 * measuring measures the repair*. That rule is about REPAIR, and it is not weakened here - what
 * follows is ARMING, which is its opposite. A repair moves the system towards the state the check
 * hopes to see; an arming puts the system into the state the check exists to observe, and then the
 * check learns nothing it did not have to be told. `testing-methodology.md` requires exactly this:
 * arm the precondition, or report VACUOUS.
 *
 * IT IS A SEPARATE FILE SO THE DISTINCTION STAYS VISIBLE. A write helper sitting beside the readers
 * is a write helper the next check reaches for without noticing, and `grainedb`'s rule would erode
 * one convenient call at a time. Everything here is a state NO INTERFACE CAN REACH, and each export
 * says which and why - a state a person could produce through the product does not belong here, it
 * belongs in a gesture.
 *
 * EVERY WRITE IS SCOPED TO A ROW THE CALLING CHECK ITSELF CREATED, by the community id it just
 * built. Nothing here may touch a row it did not make.
 */
import { psql } from './ssh.mjs';

/**
 * Ages a community's live invite so it is EXPIRED, and answers how many rows moved.
 *
 * NO INTERFACE CAN PRODUCE THIS. The panel offers 1, 7 and 30 days, so the shortest expiry a person
 * can mint is a day away - and COMM-3 asks what an expired link does. The alternatives are both
 * worse than a write: waiting a day, or deleting the row, which tests "no invite" rather than "an
 * invite that has run out" and would pass against a server that had never implemented expiry at all.
 *
 * `revoked = false` is part of the scope, not decoration: rotating mints a new row and revokes the
 * old, and ageing a revoked row would arm a state the check could not distinguish from revocation.
 *
 * @param workspaceId the community the calling check just created
 * @returns the number of invites aged - 0 means the arming did not happen and the run is VACUOUS
 */
export function expireInvite(workspaceId) {
  const out = psql(
    `UPDATE workspace_invites SET "expiresAt" = now() - interval '1 hour' ` +
      `WHERE "workspaceId" = '${workspaceId}' AND revoked = false`
  );
  const m = /UPDATE (\d+)/.exec(out);
  return m ? Number(m[1]) : 0;
}
