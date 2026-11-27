## P1 - the admission rule's fix-forward: a conversation may refuse an entry no member made only once nothing legitimate produces one

target: 1.8.3

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-20, sitting [S15](../device-verification.md#the-readings-of-2026-11-20-s15-171-alpha7-content-free-push-on-the-mi-9t-the-miconnect-terms-stage-the-admission-card-not-reached): **step 2's reading was NOT taken.** Three web-rig runs revoking a member's devices and enrolling a new one never raised the "X veut rejoindre la conversation" card: the new device was either added by an online member's sweep (the member still held a leaf, or a pending device row sat in the same pass) or entered by its own external commit. A SQL-made revocation with the new device's sends, commits and welcome requests refused by a CDP fault raised none either. The card needs a person with NO leaf, on a group, at the server's epoch, and the product's own revoke path does not leave that state on the rig; the reading needs a constructed state (a member whose every leaf was removed by a commit) and stays owed._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md)).
Step 1's table (#3774) ships in `1.7.0`; its reading needs two weeks of production after that
stable, and steps 2-5 are `1.7.1` and `1.8.0` work._

#2815 made a conversation refuse an external commit by a user holding no leaf, then freeze. Its
post-merge review found it froze legitimate members out for good and dropped every later frame, so
the owner DISARMED it on 2026-10-31: the verdict is computed and logged, the commit is merged, and
`[UNINVITED_ENTRY]` still measures it ([mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).

**The design, the five slices and the gate that lifts the refusal are on ONE page:
[admission-fix-forward](../protocols/admission-fix-forward.md)** (2026-11-25). This entry carries
slices 1 and 2, the `1.8.1` half; slice 3 is
[the emission side](p1-admission-fix-forward-the-emission-side.md) (`1.9.0`), slices 4 and 5
[the unfreeze path, never dropping frames, the re-arm](p1-admission-fix-forward-unfreeze-and-never-drop.md)
(`1.10.0`) - four to six weeks of work and two store cycles in all, each floor waiting for both
stores.

1. **Slice 1 - the entrant's own word. BUILT 2026-11-25**
   ([slice 1](../protocols/admission-fix-forward.md#slice-1---the-entrants-own-word-built-2026-11-25)):
   the engine's door answers three ways (`external_join_standing`: own leaf, further device, no leaf
   of the user), and a device whose join was accepted on `no-leaf-of-user` reports its own entry
   under an `entrant-*` kind - the seat reading that opened the door - in the same table, on the
   same key as its members' rows. **Owed: its reading**, the two statements on that page, once the
   stable carrying it has served 14 days. *Size: ten minutes, after the wait.*
2. **The members' count, read first - read the `[UNINVITED_ENTRY]` count on production, by `kind`** (`new-person`, `returning`,
   `direct-peer`, `unvouched-device`), so the legitimate paths are measured first.

   **BUILT 2026-11-17: the count is a table** (`uninvited_entries`, migration 053, additive, not
   held; [the count is a table](../protocols/mls-protocol.md#the-count-is-a-table-uninvited_entries-migration-053-2026-11-17)).
   The gap this item carried - the deduplication was a per-replica `Set` and the line lived only in
   one container's log, so every deploy reset the count, and the deploy-log archive holding earlier
   windows is readable only by the deploy account - is closed: one row per `(group, entrant, epoch,
   kind)`, claimed by `INSERT ... ON CONFLICT DO NOTHING`, aged out at 90 days, deleted with the
   conversation and with the account (the rows are pseudonymous: the device id re-identifies). Of the two fixes this entry left open, the table was taken (reversible): the
   `scheduled.yml` line would have been public, bounded by the Actions log retention, and would not
   have made the deduplication survive a deploy.

   **Owed: the reading itself**, read-only, one `GROUP BY` (the query is on the wiki page), once the
   table has held at least two weeks of production - so after the stable that carries migration 053
   has served that long. *Size: ten minutes, after the wait.* It also needs a client that classifies
   by the device proof (#3519, not in `v1.6.12`): production clients still decide `returning` by the
   older rule, so a reading before `1.7.0` measures that rule, not this one.

   Readings so far, each on the live container's log only (the window since the last deploy), kept
   because the table starts empty:
   - **2026-11-01** (about 4 h): 3 `unvouched-device`, 0 `new-person`, 0 `unstated`, 0 `invalid`.
   - **2026-11-13** (24 h): 5 `returning`, 0 `new-person`.
   - **2026-11-17** (about 38 h, `v1.6.12` clients): 5 `returning` (plus 3 `repeat` lines of the same
     entries), 0 `new-person`, 0 of any other kind.

3. **Slice 2 - the member side, FIRST - found 2026-11-17, and it orders everything after it.** A user holding
   no leaf whose roster seat is NOT an invitation-link ask was added by nobody AND asked about to
   nobody - exactly the seat of all three legitimate producers ([the table](../protocols/admission-fix-forward.md#slice-1---the-entrants-own-word-built-2026-11-25)) - so their ONLY door was their
   own external commit, and an emission side shipped alone would strand every one of them for good.
   **Decided by the owner, 2026-11-17:** the card reuses the existing join-request card as it stands
   - "X veut rejoindre la conversation", "Accepter" / "Refuser" - and a Decline REMOVES the seat
   ([decisions](../decisions/owner-decisions-of-2026-11-17.md)).

   **BUILT 2026-11-19** ([who admits a new person](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)):
   such a person, in a GROUP conversation, is raised as that card, only on a tree confirmed at the
   server's epoch (`askAMemberToAdmit`); a Decline sends the epoch of the confirmed tree they are
   absent from, and the server removes the seat under the seat lock only while the group is still at
   that epoch (`removed`), else touches nothing (`epoch-moved`; `declineSeat`). **Owed:** one rig
   reading on the pre-release that carries it (a member revokes their only device and enrols a new
   one: the other member sees the card; Refuser removes the seat and the person's external commit is
   refused; Accepter brings them back), then `minClientVersion` raised to that build once BOTH stores
   serve it - what slice 3 waits on. *Size: the reading, then a store cycle.*
