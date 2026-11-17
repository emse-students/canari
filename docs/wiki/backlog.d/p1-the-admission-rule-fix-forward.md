## P1 - the admission rule's fix-forward: a conversation may refuse an entry no member made only once nothing legitimate produces one

target: 1.7.0

#2815 made a conversation refuse an external commit by a user holding no leaf, then freeze. Its
post-merge review found it froze legitimate members out for good and dropped every later frame, so
the owner DISARMED it on 2026-10-31: the verdict is computed and logged, the commit is merged, and
`[UNINVITED_ENTRY]` still measures it ([mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).

**A multi-week chantier: four to six weeks of work and two store cycles** (a member-side build must
reach the client floor before the emission side may ship). Owed, in this order, before any refusal is
re-armed:

1. **Read the `[UNINVITED_ENTRY]` count on production, by `kind`** (`new-person`, `returning`,
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

2. **The member side, FIRST - found 2026-11-17, and it orders everything after it.** A user holding
   no leaf whose roster seat is NOT an invitation-link ask is today added by nobody AND asked about
   to nobody: `askAMemberToAdmit` (`utils/chat/actions.ts`) logs "not added, and nobody is asked:
   their seat is not an invitation-link ask" and returns. That is exactly the seat of all three
   legitimate producers below (a seat a member's invite or the person's own past membership wrote).
   So today their ONLY door is their own external commit, and an emission side shipped alone would
   strand every one of them for good. Owed: such a person, in a GROUP conversation, is raised to the
   members as an ask (the `JoinRequestRow` card, a member's Add on Accept), and a Decline of a seat
   that is not a link ask is defined server-side (today `declineJoinRequest` answers
   `not-awaiting`). *Size: about one week (client, chat-delivery, Paraglide fr/en, tests, one rig
   reading). Owner decision owed: the card's wording for a person coming back, and whether a
   Decline removes their seat.*
3. **The emission side**, only once step 2 is in every client allowed to connect (`minClientVersion`
   raised once BOTH stores serve it - before that, an older member asks nobody and the asker waits
   for ever). A user holding no leaf ASKS a member instead of entering alone, mirroring the
   further-device door (`recovery.ts`, `requestReAdd`), with no self-join when nobody answers; never
   in a 1:1, where the peer whose KeyPackage was skipped at creation is the conversation. The
   predicate `external_join_is_a_further_device` (`welcome.rs`) becomes three answers (own leaf,
   further device, no leaf of the user) so the client decides from the GroupInfo it would commit on.
   The three legitimate producers to close: a skipped KeyPackage (`welcome.rs` answer false), a leaf
   removed by the stray sweep after its only device was revoked, an evicted only leaf on a standing
   seat (`unhonoured-seat`). Each is pinned today by a test that it is merged (`admission_policy.rs`).
   *Size: about one week (mls-core, recovery, tests), plus the floor raise of step 2.*
4. **An unfreeze path.** Whatever a refusal leaves is lifted by a person or by a fact, per account,
   never stored device-wide and never permanent. *Size: three to five days, designed on the wiki
   first.*
5. **Never drop frames.** A refusal may stop a recovery; it may not ACK a conversation's messages
   away. And it must hold against a member who enrols a second account to freeze a conversation on
   purpose, and against an older client that merges the commit while its peers refuse it (the
   split): both need the floor raised to the build that refuses. *Size: about one week, then a store
   cycle for the floor, then the re-arm itself behind its own reading.*
