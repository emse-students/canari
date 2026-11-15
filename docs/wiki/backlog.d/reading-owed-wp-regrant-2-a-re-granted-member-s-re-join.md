## Reading owed - WP-REGRANT-2, a re-granted member's seed by distribution, never by repair

target: 1.7.0

**What is built:** WP-REGRANT-2, a re-granted member's re-join.

**Measured on 2026-11-14** (local estate at `ad2053fc0`): COMM-22 with four grant/revoke cycles is green on every assertion (8 sessions, 8/8 messages on the server, the peer reads all warm and cold, nothing stays unreadable). **COMM-8 still reads `seedAfterTheGrant: "repaired"`**: the granted peer got the salon's seed by asking and absorbing an answer, not from the distribution frame - the same as every COMM-8 pass the ledger has ever held ([cross-client-campaign](../cross-client-campaign.md)). Whether the distribution frame is still the path the design expects for a grant, or the repair is now the designed one (then COMM-8's expectation changes), is the open question.

**The reading that closes it:** COMM-8 reading `seedAfterTheGrant: "distributed"`, or the design naming the repair as the grant's path.

**Triage 2026-11-14: rig only, about 15 min, and a DECISION first.** Recommended option (reversible, taken under the owner's delegation): the repair IS the designed path for a grant - it has been the one every COMM-8 pass the ledger holds took, and COMM-22 with four grant/revoke cycles is green on it - so COMM-8's expectation changes from `distributed` to `repaired` (or `either, never unreadable`) and the row is re-run once; the design page is amended in the same change.
