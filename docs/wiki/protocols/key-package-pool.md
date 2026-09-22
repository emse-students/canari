# The one-time key-package pool, measured

The MLS one-time pool is minted by this client and reclaimed by nothing. This page is the
MEASUREMENT RECORD: every count, every population read on production, and - the part worth the
page - **every rule and every candidate cause that was REFUTED, so no later session re-derives
them.** What is still OWED is in [backlog](../backlog.md), never here.

**QUOTE NO COUNT FROM THIS PAGE AS CURRENT.** Every figure below except where stated was INFERRED
from a blob's weight plus an assumption about what else was in it, which is the instrument this
record ends by rejecting. A device that reports its own state census is what would replace it.

Read with [mls-protocol](mls-protocol.md) and the
[state machine's triage](mls-graine-state-machine.md#10-triage---what-is-worth-a-pull-request).

---

#### THE CHURN'S ACCOUNT LIVES IN `CHANGELOG.md`, AND WHAT A LATER SESSION MUST NOT RE-DERIVE

Four sections of investigation stood here until 2026-09-16 - the 2026-09-08 observation on the
Mi 9T, the refutation of candidate 2 at the reload boundary, the lock-order cause and its
verification on the same handset. All four describe a defect that SHIPPED, so the backlog is the
wrong file for them: the account is `CHANGELOG.md`, *"a resume read the MLS keystore before it took
the lock, so a mint that finished in between was erased"*, and the earlier half is under
`[0.16.4]`, *"a device published fifty one-time prekeys and immediately purged all fifty"*.

**What those sections established, and what a later session must not re-derive:** the pool is full
at rest and carries fifty distinct packages; the reload no longer drops key material, because the
read, the decrypt and the install happen under one manager lock rather than two; and the growth
that fed the blob is SLOWED, not repaid - `load_or_create` deletes on `not_after` alone, so it
bounds the leak at 84 days and reclaims nothing already written.

**Stopping the churn and reclaiming the store are two pieces of work, and only the first is done.**
The rest of this entry is the second.

## WHAT IS LEFT IS THE BALANCE: 3053 BUNDLES THAT CANNOT SAFELY BE DROPPED, DRAINING BY THEIR OWN 84-DAY LIFETIME

*The blob's composition is a hypothesis until it is weighed, and no prune may be written before it
is.* `state_composition` said `KeyPackage 3051x` and stopped there, which is the number every
investigation so far has divided. `MlsManager::key_package_census_at` splits it, and the load-time
log now prints it beside the composition on every device:

```
load_or_create: state composition - 10676363B total; KeyPackage 3051x7214310B, Tree 5x1704647B, MessageSecrets 5x1703382B
load_or_create: key package census - 3051 proven (2782 one-time, 269 last-resort);
                0 expired, 0 undecodable; 528 mint instant(s), largest batch 51
```

**Two causes, and the pool size is neither.** 2782 one-time bundles - about fifty-six purge/remint
rounds - plus 269 last-resort, one per connection. A hypothesis that the fallback was the dominant
cause was REFUTED by this measurement before any code was written for it: 9%, not the bulk.

**Cause one, and why nobody had fixed it by scanning.** `republishKeyMaterial` purges the server and
mints fifty; nothing local dropped the abandoned pool. The device cannot derive the dead set,
because `resolveKeyPackagePayloadForDevice` DELETES a row as it hands it out - so "absent from the
server" conflates "a peer is about to send the Welcome built on it" with "its owner revoked it".
A row the PURGE deletes carries no such ambiguity: it was still in the pool, which is the same as
never having been handed out. `DELETE /prekeys` now returns what it removed in ONE
`DELETE ... RETURNING`, and `forget_key_packages` drops exactly that and never derives a set. The
two-statement version was rejected on the same argument: a peer claiming a prekey between the select
and the delete would have it reported as purged.

**Cause two.** The fallback was minted unconditionally per connection while the pool beside it has
always been incremental (`needed = 50 - existing`). Reuse is the whole meaning of the extension.
Rotation is now the package's own lifetime.

**Verified on hardware, the half observable without a storm** - two app processes, two connections:

```
08:49:19  pid 19179  census - 3053 proven (2782 one-time, 271 last-resort)
08:49:20  pid 19179  republishing the held last-resort
08:50:10  pid 19762  census - 3053 proven (2782 one-time, 271 last-resort)
08:50:22  pid 19762  republishing the held last-resort
```

The count does not move. The purge-reclaim half cannot be triggered without a `NoMatchingKeyPackage`
storm and no debug hook was added to the product to force one; it is covered by fifteen tests across
the three layers, including the one that proves a HANDED-OUT bundle survives a purge that did not
name it.

**WHAT IS LEFT, AND IT IS ONE RULE WITH NO MECHANISM.** Three retention rules were drafted here.
Rule three - *keep published + last-resort + the K most recently minted* - was the one this entry
called "the one worth building", blocked on a single number: how long a Welcome may sit between the
claim and the join. **That number was measured on production on 2026-09-12 and it killed the rule**
(the section below carries it). K sits inside the delivery window whatever K is, so the rule cannot
be repaired by raising it.

**Rule two is what survives, and it is safe by construction rather than by argument**: a row the
server's `DELETE ... RETURNING` names was still in the pool, so it was never handed out and no
Welcome can exist for it - true whatever the window turns out to be. `forget_key_packages` drops
exactly that set and never derives one. **It reclaims only the currently published fifty**, which is
the whole of what can be justified today.

**So the 3053 already written are not reclaimed, no rule on this device can reclaim them, and that
is why NOTIF-1b is still blocked** - its 19 992 ms warm-up is the store, not the churn. The server
has no record that these bundles were ever handed out, so nothing can prove a given one is not what
a pending Welcome needs, and a rule that guessed would delete exactly that. `0 expired` on the day
of measurement means the whole balance still has its life to run: 84 days from minting, so it
drains on its own from **late October 2026** - and `load_or_create` already deletes on `not_after`,
so that drain needs no work from anybody.

**THE ONE THING THAT WOULD WIDEN THIS IS SERVER-SIDE, AND IT IS NOT WRITTEN.** A column recording
when a package stopped being published - or the claim instant, which
`resolveKeyPackagePayloadForDevice` destroys today by DELETEing the row as it hands it out - would
let a later rule separate "abandoned" from "claimed, Welcome in flight". It would only ever help
bundles minted after it exists, which is why it was passed over in favour of a one-off prune; the
one-off prune is now refuted, so this is the remaining path. **Nobody has costed it, and it is not
started.**

**AND THE DIRECT PRUNE HAS NO SURFACE EITHER, WHICH IS WHAT 2026-09-11 FOUND WHEN IT WENT TO RUN
IT.** The user's 2026-09-10 decision to prune the test fixture by hand was recorded as though the
doing were clerical. It is not: the only thing that deletes these bundles is
`MlsManager::prune_key_packages_expired_at(now_secs)`, called with an instant ~100 days ahead, which
the tests do and **nothing in the product can**. There is no debug surface to hang it on -
`VITE_ENABLE_DEV_ROUTES` survives only in generated ambient types, no route reads it, and
`commands/mls.rs` carries no `cfg(debug_assertions)` command. Shipping a dev-gated destructive
command into the product for one phone would violate both *one-off actions go to the user* and *a
destructive control needs an allowlist of what it may touch*, and would leave a permanent hazard
behind a flag nothing reads. **It was not built, and the 84-day drain makes it unnecessary.**

## THE POPULATION WAS MEASURED ON 2026-09-07, AND IT REFUTES HALF OF THE HEADLINE ABOVE

*A predicate that named the last incident is not the predicate that names the next one.* The claim
"**its pool is empty essentially always**" was read off ONE device's log lines, and it does not
survive contact with the population. Two `GROUP BY`s, one per estate, both read-only:

| | production | local estate |
| --- | --- | --- |
| devices with a `key_package` | 614 | 580 |
| devices with at least one prekey | 582 | 543 |
| devices with a pool of **exactly 50** | **437** | **413** |
| devices with a pool of **5 or fewer** | **0** | **0** |
| live (non-revoked) devices with **no** prekey | **32** (5.2%) | - |

The tail is 49, 48, 47, 46, 45... which is what ordinary consumption by peers looks like. It is not
what a purge loop looks like.

**WHAT IS STILL TRUE, AND IT IS THE DEFECT.** The churn is real and the server proves it: the most
recent Tauri device - `tauri-f7a9bb80...`, the account the harness drives, prekeys stamped
`2026-09-06 19:46:44.16218` - holds 50, and **all fifty carry that single timestamp to the
microsecond.** One batch, minted at one instant, with nothing older surviving beside it. An earlier
batch was purged wholesale and this one replaced it. That is the loop, and it is exactly the waste
that feeds the `mls.bin` growth entry: ~97 kB of bundles a round into a local store that sheds
nothing under 84 days.

**WHAT IS FALSE, AND IT CHANGES A SEVERITY.** The pool is *full at rest*, because the republish
follows the purge within the same connection. So the consequence this entry drew - "an empty pool
means the static fallback is served to EVERY peer, so #390's `last_resort` marking is load-bearing
for the NORMAL path" - is wrong. It is load-bearing for **32 devices out of 614**, which is a real
minority and a real reason to keep the marking, but it is not the normal path and it must stop being
described as one.

**SO THE DEFECT IS WASTE AND GROWTH, NOT AVAILABILITY.** Peers are being served prekeys, and the
NoMatchingKeyPackage family this entry was feared to explain has to be explained by something else.
The cause of the churn is still open, and the three candidates below stand - but the guard shipped in
\#393 is now the instrument that will name it, because it prints `REFUSED` when the round-tripped
bytes match what this session minted and `purged` when they do not. **Nobody has yet seen which line
it prints on a device**, and that single observation settles candidate 1 against candidates 2 and 3.

**AND THE LOOP IS NOT VISIBLE IN THE ACTIVE POPULATION EITHER** - 103 production devices whose
fallback `key_package` was refreshed inside three days, crossed against when their prekeys were
minted:

| what the device did | devices |
| --- | --- |
| kept its pool across connections (prekeys older than the last `key_package`) | **55**, avg pool 51 |
| topped up incrementally (several mint timestamps) - **the design working** | **39** |
| single batch of exactly 50, minted at the last connection | 27 |

The middle row is the important one: 39 devices are doing exactly what the top-up was written to do,
`needed = 50 - existing` with `existing` in the forties. And the 55 prove the pool SURVIVES a
reconnection, which a purge loop would make impossible.

**THE 27 CANNOT BE READ AS THE LOOP, AND SAYING OTHERWISE WOULD REPEAT THIS ENTRY'S ORIGINAL ERROR.**
A device connecting for the FIRST time mints 50 in one batch at that connection. So does a device
whose pool peers had fully consumed. Both produce the identical signature, and **a snapshot holds no
history that separates them**. What the population settles is the severity claim; what it cannot
settle is the mechanism.

**THE OBSERVATION STILL OWED IS NOW TWO LINES, AND THIS PARAGRAPH SAID SOMETHING ELSE UNTIL
2026-09-08.** It read `purged N/M` as proof of candidate 1, and candidate 1 has since been refuted
from the code - the round trip cannot change a byte - so that reading is gone and the lines mean
something narrower:

| line, from a device reconnecting while holding a published batch | what it settles |
| --- | --- |
| `REFUSED to purge N/M` | **SEEN 2026-09-08, and it is the ACCUSATION rather than the all-clear**: the ownership check answered false for packages this session minted, and only the guard stopped them being purged. The pool is protected; the seam is BROKEN |
| `purged N/M` | the fingerprints did NOT match. Since the bytes cannot have changed, the packages were minted by a process this `publishedThisSession` set does not describe - the manager/process identity, which is candidate 2's family |
| `[RESUME] reload DROPS KEY MATERIAL - live keystore holds N ... holds M` | **candidate 2 outright**, and it is the line to look for first: it names the loss at the boundary where it happens rather than one layer later |

**TWO OF THE THREE WERE SEEN ON 2026-09-08** - the measurement is at the top of this entry. The third,
`[RESUME] reload DROPS KEY MATERIAL`, is the one still owed, and it is now the line that names the cause.

**THE 32 ARE THEIR OWN QUESTION**, and none of them is revoked. Whether they are dormant devices that
never reconnected, or devices genuinely stuck with an empty pool, is unanswered - `MAX(createdAt)`
per device against last-seen would settle it.

**This is the engine under the 19.5 MB blob, and it was invisible until somebody counted the log
lines.** One NOTIF-1b run, lasting a couple of minutes, with the raw logcat kept:

```
[MLS][Tauri] generateKeyPackage native batch path needed=49     x3
[MLS][Tauri] generateKeyPackage native batch path needed=50     x1
[MLS] reconcilePublishedKeyPackages: purged 49/50 orphaned prekey(s)
```

**197 pool prekeys plus 4 fallbacks in ONE run** - 201 bundles at 1 936 bytes, ~389 kB - and in the
same capture: **zero** `NoMatchingKeyPackage`, **zero** `republishKeyMaterial`, **zero** `[BG_SEND]`,
**zero** `one-time pool EMPTY`. No storm, no healing, nothing exotic. **This is the ORDINARY path.**

**THE DEFECT, SETTLED ON A CLEAN ESTATE - AND THIS ENTRY WAS WRONG TWICE BEFORE IT GOT HERE.**
The sequence matters more than the conclusion, because both wrong readings were reasonable.

*Reading 1, from the client log alone:* `needed=49` every connection and `purged 49/50` right after
each top-up - a closed loop, the purge undoing its own refill.

*Reading 2, after asking the server:* 148 inserted, 49 pruned, 1 remaining - so **98 had been CLAIMED
by peers**, about one a second. That looked like it demoted the purge to a bit part, and this entry
was rewritten to say claims empty the pool and the purge does not. **It was wrong.** The run had been
taken on an estate carrying **42 live throwaway groups** a crashed check had left behind, and every
reconnection re-entered all of them, so those claims were DEBRIS sitting on top of the real
mechanism and hiding it.

*Reading 3, the measurement that settles it:* `cleanup.mjs` swept 42 groups, 6 salons and a
community; the run was repeated with nothing left that could claim a prekey. The delivery service,
same phone, no peers inviting:

```
count=50            <- publish 50
count=49  count=49
deleted=49          <- purge
count=50            <- publish 50
deleted=50          <- purge ALL FIFTY
count=50            <- publish 50
deleted=50          <- purge ALL FIFTY
count=50
```

**Every publish is followed by a purge of the whole batch, and `deleted=50` says it with no
arithmetic to argue about.** The client agrees from its own side: `needed=50` at every connection -
not 49, not 30 - which is only possible if the pool is EMPTY each time. Reading 1 was right, and the
debris is what made it look like something else.

**READ OFF THE PHONE, 2026-09-06 - THE QUESTION IS CLOSED AND THE FIRST ANSWER WAS RIGHT.** An APK
carrying `state_composition` was built and the device said it itself, in one line at load:

```
state composition - 8006000B total; KeyPackage 2338x5523276B, MessageSecrets 5x1220171B, Tree 5x1208632B
```

| part | entries | bytes | share | each |
| --- | --- | --- | --- | --- |
| **KeyPackage** | **2 338** | **5 523 276** | **69%** | 2 362 |
| MessageSecrets | 5 | 1 220 171 | 15% | 244 034 |
| Tree | 5 | 1 208 632 | 15% | 241 726 |

**Key packages dominate, which is what this entry said before two corrections talked it out of the
position.** 2 338 accumulated bundles on a device whose server pool holds fifty. Both earlier
readings were also true and neither was the whole: deleting 42 abandoned groups really did free
12.8 MB (~300 kB a group, and the table shows where that lives), and epochs really are bounded. What
none of them could do was ATTRIBUTE, which is why the instrument now exists.

**THE PRUNE'S 84-DAY HORIZON IS FAR TOO GENEROUS, AND THIS IS THE NUMBER THAT PROVES IT.** Not one of
the 2 338 has expired - the prune did not fire on this load - because the pile accumulated in WEEKS
and openmls dates a key package 84 days ahead. A horizon that never arrives is a horizon that bounds
nothing in practice. **The retention rule needs to be tighter than a default lifetime, or bounded by
COUNT**, and the count is now readable rather than guessed.

**AND THE OBVIOUS TIGHTENING IS UNSAFE, WHICH IS THE PART A LATER SESSION WOULD GET WRONG.** The
natural rule - *keep the recently minted bundles, drop the old ones* - grades on the wrong axis. A
prekey can sit UNCLAIMED on the server for weeks and be claimed a second before the prune runs: its
bundle is then old by mint date and load-bearing by use. **Mint age does not measure the risk.** What
does is time since the package stopped being published, and nothing records that today.

Three candidate rules, and what each actually costs:

| Rule | Safe? | Reclaims the 2 338? |
| --- | --- | --- |
| `not_after < now` (shipped) | yes | no - 84 days never arrives |
| Drop what the server's DELETE says it removed | **yes, by construction** - a returned row was never claimed, so no Welcome can exist for it | no, only the 50 currently published |
| Keep published + last-resort + the K most recently minted | only if K mints cannot happen inside a Welcome's delivery window | yes, ~4.9 MB at K=200 |

The second is provably correct and needs the endpoint to return what it deleted rather than 204. The
third is the only one that reclaims the historical pile, and its safety is an ARGUMENT rather than a
construction: with the provenance guard (#393) holding the pool at 50, K=200 is four full refills -
days - and a Welcome does not take days. The guard is what makes it defensible at all; on a build
without it the loop mints 200 in hours and the rule would eat live bundles.

## THE WELCOME DELIVERY WINDOW, MEASURED ON PRODUCTION 2026-09-12 - AND IT REFUTES RULE THREE

The line above asked for exactly one number before the rule could ship: how long a Welcome may sit
between the claim and the join. It was read off production, read-only, from the two populations that
carry it.

**Joins that COMPLETED** (`dm_device_group_memberships`, `status='active'`, `kickedAt IS NULL`, 265
rows): p50 **3.6 seconds**, p90 **1 day 5 h**, p99 **11 days**, worst **35 days 16 h**. 258 of 265
landed inside five days; the whole tail is seven rows.

**Welcomes STILL in flight** (`queued_message`, `isWelcome`, 98 rows - these are deleted on delivery,
so every survivor is a Welcome nobody has taken): p50 **9 days 23 h**, p95 **40 days 5 h**, oldest
**45 days 20 h**. Of the 98, **64 target a membership still `pending`** - genuinely waiting, oldest
40 days 5 h.

**So a Welcome does take days, and sometimes weeks.** "K=200 is four full refills - days - and a
Welcome does not take days" is false on both halves. A worst case of 35 days 16 h is a join that
really landed: any rule whose horizon is shorter than that would have eaten the bundle for it.
And the mint rate is not one batch per refill - this entry establishes three paragraphs above that
**a fresh last-resort package is published on EVERY connection**, so a device that connects a few
times a day mints hundreds inside a 40-day window. K=200 sits well inside the window rather than
outside it. **Rule three is unsafe as argued, and the argument cannot be repaired by raising K**:
the K that clears a 40-day window at this mint rate reclaims nothing.

**IT ALSO SOFTENS THIS ENTRY'S OWN COMPLAINT ABOUT 84 DAYS.** "Far too generous" is right about
RECLAIM - 84 days never arrives against a pile that accumulates in weeks - and wrong about SAFETY, in
a way a later session would act on: the observed window reaches 46 days, so the room between a safe
horizon and the shipped one is under two months, not the wide margin the phrase implies. A horizon
below ~46 days is not a tightening, it is a regression with a measurement against it.

**What survives is rule two**, which is safe by construction rather than by argument: a row the
server's DELETE returns was never claimed, so no Welcome can exist for it, whatever the window is.
It reclaims only the currently published fifty - and that is now the whole of what can be justified
without a column recording when a package stopped being published.

**THE CAVEAT ON THE COMPLETED HALF, STATED RATHER THAN BURIED.** `updatedAt` moves on every write to
the row, not only on the join - `kickedAt IS NULL` removes the kicks, nothing removes a demotion
followed by a re-promotion. So those deltas are UPPER bounds on the claim-to-join delay. The bias is
upward, which is the safe direction for a retention floor, and the second population settles the
question independently: a queued Welcome that has waited 40 days is a Welcome the server held for 40
days, with no column to misread.

**A THIRD OF THE QUEUED WELCOMES CAN NEVER BE DELIVERED, AND NOTHING SAYS SO.** Of the 98: 24 target
a membership that is already `active` (the device joined by another route - an external commit, or a
later Welcome - and the queued copy will never be consumed, oldest 46 days), and 10 have **no
membership row at all** (the device was deleted, which removes every row it had). `reportQueueDepth`
counts depth and cannot separate "waiting" from "will never be taken", which is the same shape as the
stale-base population before `reportStaleExternalJoinBases`. Worth its own row.

~~**The pile is very likely no longer growing.**~~ **MEASURED FALSE ON THE HANDSET, 2026-09-08.** The
device said it itself, at load, on a build carrying the guard:

```
state composition - 9076074B total; KeyPackage 2467x5831295B, Tree 51x1627467B, MessageSecrets 51x1370542B
```

**2 467 key packages against 2 338 two days earlier - +129 - and the loop did not run in that
window.** The server log proves the negative for its whole 5-hour life: the phone appears in it
exactly once, `[REGISTER_PREKEYS] ... count=50`, and there is **not one `PRUNE_PREKEYS` for any
device**; the phone's 46 surviving prekeys all carry one timestamp to the microsecond, so it
published a batch and KEPT it. So the growth is not purge debris - **it is the ordinary path**, which
this entry names three paragraphs above without connecting the two: a fresh last-resort package is
published on EVERY connection, and each top-up mints into a store that sheds nothing under 84 days.

**That changes the disposition, not the severity.** It is not "a one-off reclaim of ~4.9 MB on
affected handsets"; it is a slow leak that is still live on a build where the loop is fixed, and any
rule written for it has to bound the STEADY state rather than clean up after an incident. **The
reclaim argument in the table above was sized against a pile that had stopped growing, and it had
not.** *(`mls.bin` is 9.07 MB here against 20.8 MB on 2026-09-06 - the group sweep held, and it is
what makes the key-package share so visible: 64% of what is left.)*

**AND A REAL GROUP IS NOT THE GROUP THE SYNTHETIC TEST MEASURED.** ~490 kB apiece here, against
5 330 bytes for a fresh group of one and a 17 kB plateau at 81 epochs. The weight is `Tree` (member
leaves a campaign accumulated - 242 kB is roughly 120 of them) and `MessageSecrets` (per-sender
ratchet history, which `SenderRatchetConfiguration::new(2000, 2000)` sizes deliberately). Neither is
epochs. **Every synthetic figure in `state_weight.rs` is a FLOOR and must be read as one.**

**WHAT THE FIELD SHOWED THE SAME NIGHT, AND IT CORRECTS THIS ENTRY'S ARITHMETIC A THIRD TIME.**
After `cleanup.mjs` swept 42 abandoned groups, the phone's `mls.bin` fell from **20 812 360 to
8 018 495 bytes** - 12.8 MB, 61% - and one checkpoint from 48 449 ms to **6 943 ms**. The prune
shipped that day did NOT fire (no line in the capture), so the drop is the groups.

That looked like it demoted key packages, so the mechanism was measured rather than divided:
`what_an_epoch_costs_at_constant_membership` churns one device in and out of a group forty times and
**the state PLATEAUS - 81 epochs, 17 364 bytes, growth stops after the second round.** Epochs are
bounded, `MessageSecrets` and `ResumptionPsk` stay at ONE entry each, so accumulated epochs are not
what makes a real group heavy. **That refutation is the useful part**; what remains heavy about a
campaign group is not yet named.

**AND THE LOOP DID NOT REPRODUCE ON THE BUILD CARRYING THE GUARD.** With the pool emptied by hand to
force a mint, the phone published 50 and kept all 50 - `needed=50`, no purge, and the guard's own
`REFUSED` line never fired, meaning `keyPackageHasPrivate` recognised every one of them. The failing
condition therefore needs something this run did not have, and the difference worth suspecting is the
checkpoint cost: 48 s when it failed, 6.9 s when it did not. **That is a hypothesis and it is written
as one** - three readings have already been wrong here, two of them from dividing numbers instead of
removing a variable.

**THE INSTRUMENT THAT WOULD HAVE SETTLED ALL OF THIS DID NOT EXIST**, which is why it now does:
`MlsManager::state_composition` logs what the state is made of once per load, so the next occurrence
is read rather than inferred.

**WHAT THIS MEANS IN PRODUCTION, AND IT IS WORSE THAN THE BLOB.** A device whose one-time pool is
empty is served its STATIC FALLBACK to every peer that asks. That is exactly the condition
[mls-protocol](mls-protocol.md#the-two-kinds-of-key-package) names as the reason the
fallback had to be marked `last_resort` - and this loop puts a device in that condition ESSENTIALLY
ALWAYS rather than rarely. The 2026-09-06 `last_resort` fix (#390) is therefore not a safety net for
an edge case; it is load-bearing for the normal path, and it explains why `NoMatchingKeyPackage` was
so easy to reproduce before it.

**And a device cannot fail to hold the private key of a package it minted seconds earlier**, so
`keyPackageHasPrivate` is answering `false` about this device's own fresh mints: a broken seam
between minting and asking, real and reproducible on a clean estate.

**A CANDIDATE CAUSE, FOUND BY READING ON 2026-09-06, AND IT IS AN ORDERING DEFECT RATHER THAN A KEY
DEFECT.** Three MLS engines share one `mls.bin` on Android - foreground Tauri, FCM JNI, Worker JNI -
and each does *load, modify, write*. **Only the WRITE is protected.** `background_write_mls_bin`
takes `mls_bin_write_lock` and tests `foreground_is_active()`; the load-modify-write cycle around it
is not a unit, so nothing detects that the file changed between an engine's load and its write.

And that test is a CLOCK. `FOREGROUND_GRACE_MS` is 30 s, refreshed by a 10 s JS heartbeat which -
by its own comment - "auto-pauses on hidden". Meanwhile `sauvegarder_mls_et_persister`
(`commands/mls.rs`) runs in this order:

1. lock the manager;
2. `save_encrypted_with_key(...)` - **the expensive half, measured at 48 s on the Mi 9T**;
3. `write_mls_state_blob(...)` - which is the first thing that refreshes the guard.

So on backgrounding the heartbeat stops, the guard lapses 30 s later, and step 2 keeps running for
another ~18 s. **In that window a background engine reads `foreground_is_active() == false` and
writes a blob it loaded before the mint.** The window is a function of the checkpoint's cost, which
is why the defect tracks the slow checkpoint (48 s) and never appeared on the fast one (6.9 s) - at
6.9 s it does not open at all.

The sequence that produces the observed numbers exactly:

| | |
| --- | --- |
| 1 | foreground mints 50 prekeys and publishes them |
| 2 | app backgrounded; heartbeat paused, guard lapses at 30 s |
| 3 | FCM arrives: the background engine loads the PRE-MINT `mls.bin`, works, writes it back - the 50 are gone from disk |
| 4 | app foregrounded: `reloadStateFromDisk()` replaces the warm engine with that state |
| 5 | reconciliation asks "do I hold the private key?" - **false, fifty times** - and purges all 50 |

That is `count=50 / deleted=50`, and it explains why the device cannot back packages it demonstrably
minted: the SESSION minted them, the STORAGE no longer has them.

**THE FIX IS NOT A LONGER GRACE.** A deadline that must outlast an operation whose cost is unbounded
is the clock this repository's own rule forbids as load-bearing. The durable-state form is a
**compare-and-swap on the file**: an engine remembers the fingerprint of the blob it loaded and,
under the write lock, refuses to write when the on-disk blob is no longer that one. A lost update
becomes a detected conflict, the losing engine's work is retried against the current state, and the
30 s stop being load-bearing - they may stay as an optimisation that avoids wasted work, which is
what a clock is allowed to be.

**THIS IS READ, NOT MEASURED.** The window is provable from the source and the ordering is wrong on
its face, so the CAS is worth doing whether or not it is the whole cause. What would settle it is
one capture pairing the `state composition` line at `load_or_create` with the guard's own refusals
across a background/foreground cycle - if the KeyPackage count falls across step 3, the chain holds.

**What each round costs.** ~50 bundles x 1 936 bytes = ~97 kB written into a state that nothing
prunes below 84 days. Measured across one day on this handset:

| | 2026-09-06 morning | 2026-09-06 evening | delta |
| --- | --- | --- | --- |
| `stat mls.bin` | 19 548 753 | **20 812 360** | **+1 263 607 (+6.5%)** |
| one checkpoint | 17.1 / 17.1 / 19.7 s | **25.7 s / 48.4 s** | ~2.5x |

+1.26 MB a day is ~652 bundles a day at the measured weight, which is ~13 rounds of fifty - entirely
consistent with the rounds seen in a single two-minute run. **On a clean estate the whole of that is
the loop**: with nothing able to claim a prekey, the device still published 50 and purged 50, three
times in one run. This is not a client honestly replacing what peers consumed; it is a device
refilling a pool it empties itself, into a local store that until 2026-09-06 never deleted anything
and now only sheds at 84 days. **The growth feeds itself**: a bigger blob is a
slower checkpoint, and a slower checkpoint widens every window in the app that a checkpoint sits
inside. This is why the per-connection fallback reuse and a shorter local retention matter more than
they looked - the mint rate is not going to fall.

**IT ALSO EXPLAINS A ROW THAT FAILED THE SAME EVENING.** NOTIF-1b went `FAIL` with
`notifiedInMs = 20887` against 2 152 ms that morning, on the same build. Twenty-one seconds is not a
notification defect - it is the phone sitting inside a 25-to-48-second checkpoint. The row was
measuring the blob.

**WHERE THE FAULT IS NOT.** `mls-core/tests/published_prekeys_are_recognised.rs` mints 50 prekeys and
asks `key_package_has_private` about each through the publish round trip: all 50 recognised, the
last-resort fallback recognised, and another device's package correctly refused. **So the Rust is
right and the defect is above it** - in the seam between publishing and asking. That narrows it to a
short list, and each is checkable without a phone:

1. ~~the bytes `listOwnPrekeys` returns are not byte-identical to what `publishKeyPackages` sent
   (base64 framing, `number[]` marshalling across the Tauri IPC)~~ - **REFUTED FROM THE CODE,
   2026-09-08**, and by construction rather than by a run. `publishKeyPackages` sends
   `toBase64(bytes)`; the server VALIDATES the string and stores it verbatim
   (`devices.controller.ts`, `registerDevicePrekeys` - `create({ keyPackage: kp })`, no decode, no
   re-encode); `listDevicePrekeys` returns `r.keyPackage` straight off the column; the client reads
   it back with `fromBase64`. There is no transformation anywhere on the path, so the round trip
   cannot change a byte - which also means the guard's fingerprint and `keyPackageHasPrivate`
   cannot both be failing for THIS reason;
2. **the manager answering `key_package_a_clef_privee` is not the one that minted - NAMED PRECISELY
   2026-09-08, AND REPRODUCED WITHOUT A PHONE.** The mechanism is the reload boundary:
   `recharger_mls_au_resume` replaces the live manager with one rebuilt from `mls.bin`, gated ONLY
   by `reload_is_monotonic`, which compares GROUP EPOCHS and nothing else. **Key material is not a
   group epoch.** A snapshot predating a mint therefore holds every group at exactly its live epoch,
   passes the guard, and installs a keystore missing all fifty bundles the device published seconds
   earlier - after which `key_package_has_private` answers `false` about the device's own mints,
   which is exactly what the reconciliation reads as a server orphan.
   `reload_monotonic.rs::a_snapshot_predating_a_mint_passes_the_epoch_guard_while_losing_every_minted_key_package`
   pins all three steps: the guard accepts, the count drops by 50, and **50 of 50 published packages
   are unrecognisable to the reloaded manager** - the `purged 50/50` line, reproduced on a desktop.
   *This makes the checkpoint-duration correlation the entry below wrote as a bare hypothesis into a
   consequence: a 48 s checkpoint is a 48 s window in which the blob on disk is the PRE-MINT one,
   seven times wider than at 6.9 s.* **What it does NOT prove is that a resume actually fires inside
   that window on the handset** - that is the observation still owed, and the instrument below is
   what answers it;
3. the reconciliation races the publish and reads a list the mint has not landed in. **Partly
   answered**: `generateKeyPackage` is AWAITED before the reconciliation is started, and
   `generer_key_packages_et_persister` mints AND writes `mls.bin` under the same lock, so the mint is
   durable before the list is asked for. What remains true is that the reconciliation is started with
   `void` (`initializeConnection.ts`) and therefore runs CONCURRENTLY with the rest of connection
   sync - which is what makes candidate 2's window reachable at all.

**AND CANDIDATE 2 IS NOT A NEW HYPOTHESIS - IT IS A KNOWN DEFECT CLASS WHOSE NATIVE INSTANCE WAS
MISSED, AND THE WEB SIDE HAD ALREADY WRITTEN THE ARGUMENT DOWN.** `WebMlsService.installUnlessOvertaken`
exists for precisely this, and its docblock states the finding above in its own words:

> `swapClientMonotonic` cannot answer this. It refuses a regression and measures one with the EPOCH,
> which is evidence for "is this snapshot from an older epoch" and for nothing else - a generation
> that moved inside one epoch is just as stale and completely invisible to it.

It then predicts the miss: *"a rule that lives at one call site is a rule the next off-thread worker
will not inherit"*. **`recharger_mls_au_resume` is that next caller** - it snapshots (`mls.bin`),
works on a copy (loads a candidate), and installs it - and it inherited only the epoch half, across
a language boundary where nothing could compare the two. **The web guard is not theoretical either:
it FIRED during the HEAL-REVOKE-5 run of 2026-09-08**, on the key-package path itself -
`[MLS] key package worker state DISCARDED: the live client was mutated 1 time(s) since the snapshot`
- so the hazard is observed, on the same operation, on the platform that guards it.

**WHAT THIS DOES NOT LICENCE IS COPYING THE WEB FIX**, and the asymmetry is the reason the native
side gets an accusation instead. On web the two candidates are ORDERED: the worker's output derives
from an older snapshot and the live client is authoritative, so refusing is free. At the native
resume BOTH sides have moved - the background engine advanced the blob, the foreground minted into
the live manager - and neither is a superset of the other. That is a merge, not a precedence, and
nobody has written it.

**CANDIDATE 2 IS NO LONGER A CANDIDATE, AND THE DEVICE LINE THIS ENTRY WAS OWED IS TAKEN.** At
09:51:43.207 on 2026-09-08 the shipped instrument accused, on hardware, for the first time:
`[RESUME] reload DROPS KEY MATERIAL - live keystore holds 2625 key package(s), the mls.bin being
loaded holds 2624`, with `Every group is at or ahead of its live epoch, so the epoch guard cannot
see this` in its own text and a `KeyPackage published` two seconds later. **One bundle, not
forty-nine** - so the reload is A source of the churn this entry measures and not, on this evidence,
the whole of it. The same run also showed the reload putting back the RECEIVE ratchet, which no
key-package count can see; both readings and the ordering are in **"one frame is decrypted by three
engines against one receive ratchet"** under Storage and retention.

**AND IT WAS MEASURED ON THE RECEIVE RATCHET TOO.**
`mls.bin reloaded on resume (C2)` was observed putting a secret tree back far enough that two
generations already consumed by the foreground decrypted a second time, with the epoch unmoved at
196 throughout - the exact blind spot this section predicts for `swapClientMonotonic`. The table and
the timings are in **"one frame is decrypted by three engines against one receive ratchet"** under
Storage and retention; read the two together, because the reload is one mechanism and the key
packages counted below are only the half an accusation can see.

**THE INSTRUMENT FOR CANDIDATE 2 SHIPPED 2026-09-08, AND IT ACCUSES RATHER THAN REFUSES.**
`recharger_mls_au_resume` now compares `key_package_count()` across the reload and logs
`[RESUME] reload DROPS KEY MATERIAL - live keystore holds N ... the mls.bin being loaded holds M` at
`error` level. **Refusing was considered and rejected on a mechanism, not a budget**: this reload
exists to pick up what a background JNI engine advanced while the app was away, and that advance is
often a RATCHET GENERATION rather than an epoch - a decrypted application message moves no epoch at
all - so a refusal grading on key packages would silently drop the background work the reload was
written to rescue, trading a known defect for an unmeasured one. **A later session must not "finish"
this by turning the accusation into a refusal without answering that first.**

**WHY THE EXISTING SAFETY NETS DO NOT CATCH IT.** `reconcilePublishedKeyPackages` is documented as
*"conservative: only purges PROVEN orphans"* and treats a validation error as "leave it alone" - so a
package that cannot be checked survives. It has no floor and no rate check: **purging 49 of 50 is
indistinguishable, to that function, from purging 1 of 50.** A reconciliation that removes ~all of
what was just added is not conservative, it is a loop, and nothing says so. This repository's own
rule applies exactly - a fallback's rate must be measured against the population before its name is
believed.

**WHAT IS OWED, IN ORDER.**

1. ~~**A floor and a loud refusal in `reconcilePublishedKeyPackages`**~~ - **SHIPPED, AND THE FLOOR
   WAS DELIBERATELY NOT BUILT** (`e5aba1f76`, #393, four tests). Re-read 2026-09-08: this item asked
   for the wrong mechanism and the fix says why in the code. A share-based floor cannot work, because
   a device restored from an older backup HAS genuinely lost every private key and purging 50 of 50
   is exactly what the function is for - so "too many" is not the discriminator. **Provenance is**:
   `publishedThisSession` holds the fingerprint of every package this process minted, and a `false`
   from `keyPackageHasPrivate` about one of those is never evidence about the server. It is refused,
   counted, and accused at `console.error`.

   **The residue, and it is not nothing.** That set is per-process and deliberately not durable -
   the claim it supports is "this process minted these bytes". So packages minted in an EARLIER
   session are still purgeable, and a device whose keystore is emptied by the reload of candidate 2
   and then RESTARTED would run the loop again with nothing to refuse it. The guard closes the
   observed case, not the class.
2. **Then the cause**, from the three-item list above - and this is now the FIRST open item. Item 1
   is refuted from the code; item 2 is named, reproduced on a desktop, and instrumented; item 3 is
   partly answered. **What is left is one observation on the handset**, and see the note below it for
   what was tried on 2026-09-08.
3. **The per-connection fallback reuse** already filed against the blob entry, which is the same
   family of waste.

**FIRST ATTEMPT AT THE OWED OBSERVATION, 2026-09-08, AND IT DID NOT REACH THE PATH.** The phone runs
`f2748d75` - the very commit that carries the instrument, built forty seconds after it - so the
handset CAN print the accusation. A full NOTIF phase was driven across it (backgrounded sends, pushes,
a notification tap that foregrounds the app), and logcat over that window holds **no** `[RESUME]` line
from Canari at all: not the `error` accusation, not the `debug` line a successful reload leaves, and
not the `warn` the counting branch emits. The only `RESUME` lines in the buffer are the Android
launcher's.

**That is not yet evidence that the reload never ran**, and saying so is the point: the successful
path logs at `debug`, which a release build may filter, and the JS half of the sequence
(`[MLS][Tauri] mls.bin reloaded on resume (C2)`, `Resume reload SKIPPED`) does not reach logcat at
all - the WebView's console is read over CDP, and logcat carries only the native side. **So the next
attempt reads the phone's CDP console across a background/resume, not its logcat**, and that is the
one line still owed.

**AN ATTEMPT AT A SECOND OBSERVATION, 2026-09-16, AND IT COULD NOT BE MADE TO CARRY WEIGHT.** The
Mi 9T was re-imaged by the 2026-09-14 hardware session (`firstInstallTime=2026-09-14 20:12:15`) and
runs `0.18.1`. Four hours after first run its `mls.bin` was **2 750 195 bytes** for a device holding
4 conversations and 1 180 messages. The temptation is to read the residue as bundles and call the
loop live - **and that reading does not hold.** Group weight depends on membership, this install's
membership was never counted, and between fifty and two hundred members a group the four groups
account for anywhere from 0.45 MB to 1.6 MB of it. The bundle residue is therefore somewhere between
~600 and ~1 400, which accuses nothing.

**What the attempt did establish is that a file size is the wrong instrument, and this entry has
been using it since September.** Every count here - 3053, 3051, 2782, ten thousand - was inferred
from a blob's weight and an assumption about what else was in it. **The cheapest next step is no
longer the CDP observation; it is a device that can report its own state census** (groups, members,
one-time bundles, last-resort), which would settle this entry, the blob entry and the 2026-09-06
19.5 MB question in one line each. See the blob entry below, where that item now lives.

**And this handset can no longer answer the other half either**: its 19.5 MB blob went with the debug
build, so the prune's reclaim is not observable here.

**The 2026-09-06 prune (`prune_expired_key_packages`) does NOT fix this** and was never going to:
these bundles are hours old, not 84 days. The prune bounds the ceiling; this loop is what fills it.

## THE SERVER SERVED A DEAD LAST-RESORT PACKAGE TO 95% OF DEVICES, AND THE COLUMN THAT SHOULD HAVE STOPPED IT WAS NULL FOR ALL OF THEM

**Found on 2026-09-18 in a console export the user took on their own browser**, on production
`v0.18.11`, two days after migration 024 shipped to fix exactly this:

```
[RUST::INFO] add_members_bulk to group: 60fbab12... (1 key packages)
[RUST::WARN] Skipping invalid KeyPackage at index 0: LifetimeError(Expired { not_after: 1789396881, now: 1789732051 })
[PENDING] Add error for tauri-01c42125...: Crypto/OpenMLS error: No valid KeyPackages to add
```

`not_after` is 2026-09-14T14:41:21Z and `now` is 2026-09-18T11:47:31Z: the package was **3.88 days
dead** when the server handed it over. The invitation is neither satisfied nor abandoned, so it
retries on every launch, for ever - the condition migration 024 was written to end.

### Which row it came from, established by elimination rather than assumed

The one-time pool's serving query already excluded elapsed rows, so a dated one-time row could not
have been served. It was therefore either an undated one-time row or the static last-resort row.
The two measurements below settle it:

| table | `notAfter` NULL | dated and valid | dated and elapsed |
| --- | --- | --- | --- |
| `one_time_key_package` | 577 | 30 829 | 14 (correctly refused) |
| `key_package` (last-resort) | **683** | 36 | 0 |

The 577 undated one-time rows were **all created on 2026-09-17 or 2026-09-18**, and
`createdAt + 84 days` puts every one of them in December - none could be the 2026-09-14 package. The
last-resort row is what was served, and a direct query confirmed that device's row is one of **three**
on production whose `createdAt` is more than a lifetime old.

### Why the guard never fired, which is the actual defect

`resolveKeyPackagePayloadForDevice` refused on `if (device.notAfter && device.notAfter <= now)`. That
column is written **only** by `register-device`, which runs at enrolment. `republishKeyMaterial` -
the routine a client runs every 30 s - calls `deleteAllOneTimePrekeys` then `generateKeyPackage`, and
**never touches the last-resort row**. So the entity docblock's "they stay invisible until their
owners next connect" was a promise nothing keeps: 683 of 719 rows were NULL, the `&&` short-circuited,
and **95% of devices were exempt from the refusal entirely**.

### The two tables need opposite answers, and that is the whole fix

`createdAt + 84 days` is not one rule applied twice:

* **`one_time_key_package` is INSERT-once and never updated**, so the sum IS the package's lifetime -
  which is precisely why migration 024 backfilled it that way. The mistake was making it a one-shot
  UPDATE: old clients publish bare base64 with no date, so the backfill drained and refilled at ~290
  rows a day. Migration 025 makes it the column `DEFAULT`, the publish path applies it to an undated
  or unparseable batch, and the two read sites plus the reclaim `COALESCE` to it - so the filter is
  **total** and no read has an "unknown" arm left.
* **`key_package` is UPDATED in place** and `registerDevice` resets `createdAt` while the client
  republishes a package it already holds, so a row can carry today's date and a package that elapses
  in four days. Backfilling it would certify dead packages as live, and 024 was right to refuse.

But the same fact read the other way is sound, and that is `lastResortDeadline`: **the package is at
least as old as its row**, so `createdAt + 84 days` is an upper bound on how long it can still live.
Past that instant it is dead whatever `notAfter` says; before it, nothing is proven. Certifying a
package VALID this way would be wrong; certifying one DEAD cannot be. On production that separates
**3 provably dead rows** - including the one in the export - from 680 that stay honestly unjudgeable,
and it needs no client to speak first.

A reported date that has **not** elapsed still wins: it is the package's own lifetime, where the
bound is only a limit on it.

### What this does NOT fix, and what the undated rows turned out to be

The unjudgeable rows drain only as their owners re-enrol, because nothing republishes a last-resort
package's date.

**MEASURED ON PRODUCTION 2026-09-22, AND THE SPLIT IS A CLIENT VERSION WITH NO EXCEPTION.** Of 759
rows, every one whose `deviceAppVersion` is `>= 0.18.10` carries a date (162 of 162) and every one
below it, or with no version recorded at all, does not (597 of 597). `notAfter` is read from
`body.notAfter` at `register-device` - the server derives nothing - so the column records whether
the CLIENT sent a date, and the client began sending one in `0.18.10`.

**Git says the same thing, so the finding rests on two independent readings.** `git log -S`
on the line that sends the date puts it in `f88a65d0b` (#759, 2026-09-16), and
`git tag --contains` makes `v0.18.10` the first release carrying it: the boundary in the table
and the boundary in the history are the same one.

**That refutes the repair this section used to name.** Making `republishKeyMaterial` carry the date
is client code, so it runs only on a build that already dates the row at `register-device`; it would
date nothing that is not dated. **A repair written in the client cannot reach a population defined by
not carrying the client change.** The rows date themselves instead, at about 20 a day measured
against 2026-09-18 - 677 undated then, 597 four days later. The only shape that could reach the rest
is the server decoding the `keyPackage` bytes it already holds, which means an MLS decoder in a
service built never to interpret them; the trade is in `docs/wiki/backlog.md`.
