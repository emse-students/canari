## P1 - the admission rule's fix-forward: a conversation may refuse an entry no member made only once nothing legitimate produces one

#2815 made a conversation refuse an external commit by a user holding no leaf, then freeze. Its
post-merge review found it froze legitimate members out for good and dropped every later frame, so
the owner DISARMED it on 2026-10-31: the verdict is computed and logged, the commit is merged, and
`[UNINVITED_ENTRY]` still measures it ([mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).

Owed, in this order, before any refusal is re-armed:

1. **Read the `[UNINVITED_ENTRY]` count on production, by `kind`** (`new-person`, `returning`,
   `direct-peer`, `unvouched-device`), so the legitimate paths are measured first.

   **First reading, 2026-11-01 (read-only, by the lead).** One chat-delivery replica, started at
   16:28 UTC that day, so the window is about 4 h: 3 lines `kind=unvouched-device`, 0 `new-person`,
   0 `unstated`, 0 `invalid`. The window is that short because the reading took only the LIVE
   container's log (`docker logs`), and a deploy recreates the container. It is not enough to decide
   anything: it is a 4-hour window, not a measure of the legitimate paths.

   **The gap: the count does not accumulate.** `[UNINVITED_ENTRY]` exists only as a log line, and
   its dedup set (`reportedUninvitedEntries`, `messaging.controller.ts`) is in memory per replica,
   so a deploy restarts both. Two facts bound how bad that is:

   - **The deploy archive already holds earlier windows**, and the first reading did not read it:
     `archive_logs` copies every container's log to `~/deploy-log-archive/canari-prod/<stamp>/`
     before each deploy, the newest 10 deploys, none older than 30 days
     ([logging](../infrastructure/logging.md)). Each line carries `group`, `entrant` and `epoch`,
     the dedup key, so lines from several archives can be merged and deduplicated offline. An
     archive holds the 30 days before its deploy and is itself kept 30 days, so a line can live
     about 60 days in it ([logging](../infrastructure/logging.md#the-90-day-ceiling-2026-10-16)),
     at most 10 deploys back; past that, nothing holds it. Read by hand.
   - **No persisted report carries it.** The daily jobs of `scheduled.yml` (`hosts`, `backups`,
     `log-retention`) persist their output only as GitHub Actions run logs, and this repository is
     public, so those logs are public: such a line could carry counts by `kind` and nothing else,
     never a group or a user id. The service's own daily or hourly lines (`[ORPHAN_DEVICES]`, the
     stranded report) are container log lines, so they have the same lifetime as this one.

   Two fixes, NOT built, the choice open:

   - **a durable store**: an additive table (one row per `(group, entrant, epoch)` with its `kind`
     and first-seen time), which also makes the dedup survive a deploy. It needs a migration the
     owner approves;
   - **one line per day in a persisted report**: a `scheduled.yml` job, or a step of an existing
     one, that reads the live log and the archives on the host, deduplicates by key and prints
     counts by `kind` only. No migration, but its history lives as long as the Actions log
     retention, and it is public.
2. **The emission side.** A user holding no leaf ASKS a member instead of entering alone, mirroring
   the further-device door (`recovery.ts`, `requestReAdd`); never in a 1:1, where the peer whose
   KeyPackage was skipped at creation is the conversation. The three legitimate producers to close:
   a skipped KeyPackage (`welcome.rs` `external_join_is_a_further_device` false), a leaf removed by
   the stray sweep after its only device was revoked, an evicted only leaf on a standing seat
   (`unhonoured-seat`).
3. **An unfreeze path.** Whatever a refusal leaves is lifted by a person or by a fact, per account,
   never stored device-wide and never permanent.
4. **Never drop frames.** A refusal may stop a recovery; it may not ACK a conversation's messages
   away. And it must hold against a member who enrols a second account to freeze a conversation on
   purpose, and against an older client that merges the commit while its peers refuse it (the
   split): both need the floor raised to the build that refuses.
