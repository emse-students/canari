## The owner's decisions of 2026-11-26 - the Alumni merge, extended

Recorded so no question answered here is asked again. Items 1-4 are the owner's, recorded as he gave
them; items 5-6 are the lead's, taken under the absence rule (reversible) from what the owner said
and saw the same evening; items 7-9 are the owner's answers, the same evening, to the three
questions the design raised. The design they apply is D52-D58 in
[profiles-and-access](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183).

1. **When a duplicate is merged, its local account on Sky, MiGallery, Portail-etu and Le Cercle (if
   it ever signed in there) is TRANSFERRED to the real account, then ERASED. Nothing is lost
   (principle 2), and no orphan is left.** (owner, 2026-11-26). Read the same day: Portail-etu keeps
   no account at all, so it has nothing to transfer (D53). Where: D52, D53.
2. **Manual merge: the ADMIN decides identity, WITH A WRITTEN REASON.** The admin picks the two
   accounts the duplicates page did not pair, for example when the names differ between the Alumni
   base and Canari. MiConnect accepts the merge despite a different name, and the reason is traced.
   **This amends D51 for the manual path only; the automatic pairing keeps its name and promo rule.**
   (owner, 2026-11-26). Where: D55.
3. **A merge waits for the person's next Alumni sign-in with NO time limit, as today. It stays open,
   visible and cancellable. Nothing is forced.** (owner, 2026-11-26). Where: D56.
4. **Target: `1.8.3`.** (owner, 2026-11-26). Every entry below carries `target: 1.8.3`.
5. **The completion follows the MERGE, not an admin's page view** (lead, under the absence rule,
   2026-11-26; reversible). Measured that evening: Canari erased the duplicate's account only when
   the owner reopened `/admin/alumni-duplicates`, because the completion runs on that page's read,
   and until then the duplicate stayed in every person picker. The owner: *"il faudrait qu'il puisse
   disparaître avant"*. MiConnect pushes the merge to Canari as it happens; the page's read stays as
   the reconciler that catches a lost push, and says so at warning when it is the one that
   completes. Charter principle 2, *the essential is never lost* ([principes](../../principes.md)):
   a person must never be offered the account that is about to go. Where: D54.
6. **A duplicate waiting for its merge is in no person picker, and two people of the same name are
   never shown bare** (lead, under the absence rule, 2026-11-26, after the owner's screenshot of the
   picker "Choisissez une ou plusieurs personnes" listing two identical rows of one name;
   reversible). Charter principle 7, *simple, léger, agréable* ([principes](../../principes.md)), and
   the owner's directive of one homogeneous app: every picker obeys ONE rule, applied by the server
   that answers them all. Where: D56.
7. **Le Cercle, when both accounts exist: a pair of `transfer` ledger lines** (owner, 2026-11-26,
   the recommended option). The balance and the membership move from the duplicate to the real
   account through one line out of the duplicate and one into the target, each naming the other - a
   new ledger type, so a Le Cercle schema migration - rather than a `cashout` and a `topup` that
   would book money nobody paid. Until that migration ships, that case answers `409` and changes
   nothing. Where: D53, [the entry](../backlog.d/alumni-merge-le-cercle-transfers-then-erases-the-duplicate.md).
8. **Canari's own duplicate account stays as D48 says: erased, not transferred** (owner, 2026-11-26,
   confirmed). The confirmation names what it holds before the admin confirms. Where: D52.
9. **A duplicate's MiGallery face enrolment is transferred to the real account** (owner, 2026-11-26,
   the recommended option), with its consent, when the real account has no face link of its own;
   when both have one, the real account's stays. Where: D53,
   [the entry](../backlog.d/alumni-merge-migallery-transfers-then-erases-the-duplicate.md).
