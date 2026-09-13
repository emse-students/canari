# Backlog

**Everything below is SCHEDULED** - the user's decision of 2026-08-18: the backlog and `CLAUDE.md`
are both emptied before the campaign restarts. This file is no longer a parking area; it is the
DETAIL for the queue in `CLAUDE.md`, which carries the order and one line per item. Read the order
there, the substance here, and delete an entry from BOTH when it ships.

The exception is the handful that genuinely cannot be pulled forward - blocked upstream, blocked on
an iPhone that does not exist, blocked on credentials somebody else owes, or post-campaign by the
user's own decision. Each says which it is, and `CLAUDE.md` lists them together at the end of the
queue so that "not scheduled" never has to be inferred.

Severity uses the repo scale: **P1** security, or a user-facing path that is broken - **P2**
correctness, nothing at risk - **P3** hygiene. An item with no severity is a QUESTION, not a defect,
and its first task is to answer the question rather than to write code.

Each entry states what is known, so that picking it up does not start with a rediscovery. **Delete an
entry outright when it ships** - the rule goes to [durable-rules](durable-rules.md), the story to
`CHANGELOG.md`, the mechanism to the wiki page that entry points at. An entry describing its own fix
is an entry nobody trusts to be current.

**NOTHING FIXED BELONGS IN THIS FILE.** Where a fix is in the tree and only its measurement is
missing, it gets ONE LINE in the table at the top and no entry of its own - a fixed thing mixed in
with open work is how a queue stops being readable (user, 2026-08-30). Where an entry keeps an open
half, the shipped half is a pointer, never a retelling.

---

## Owed a VERIFICATION, and nothing else

Each of these is fixed in the tree; what is left is the measurement that would prove it. **Nothing
about them is open work** - the story is in `CHANGELOG.md`, the mechanism on the wiki page named,
the rule in [durable-rules](durable-rules.md). Delete the line once the measurement is taken.

| What | The measurement that closes it |
| --- | --- |
| `/forms/success` no longer asks for a form called `success` | after the deploy, social-service logs no `invalid input syntax for type uuid: "success"` across a completed payment - the symptom fired once per payment, so ONE payment settles it. The unit test pins the derived set; only prod pins the silence |
| the `apiFetch` fallback now names its cause | the next run's logs separate "a container is restarting", which needs nothing, from "refresh is broken", which needs everything - they were the identical line. If one cause dominates, its RATE wants measuring against the population before the name "transient" is believed |
| the `[PENDING]` line that called a routine race "Non-recoverable" | the next run reports it in `notable` from an ANCHORED rule, not from the generic `epoch` rule matching words an error string happened to carry. **The two old spellings stay pinned** until A1 runs a build emitting the new line - an APK embeds its frontend and is not reached by a deploy |
| a push carries its ciphertext once, not twice | HARDWARE, both platforms, iOS the riskier half - no iPhone has yet received a push built without the redundant `data` map ([chat-delivery](services/chat-delivery.md#transport--single-gateway-fcm)) |
| a device with no push token now says so | after the next release, a tokenless device either acquires one or prints `[PUSH_UNAVAILABLE]` naming a cause; continued silence with a tokenless device still in `key_package` means a FIFTH cause, not a fixed one |
| the notification quick reply's 403 | HARDWARE: check K steps 1-5 and **K2**, on A1 which already carries the build - **and the window must be ARMED, a run made without arming proves nothing** ([check K](device-verification.md#the-backgrounded-run-that-failed-and-the-defect-it-found)). The iOS twin is corrected identically and equally unproven |
| the login button that took a press and showed nothing | the fix is a reordering, visible in the component's own state, so any cold `/login` press proves it. What is NOT explained is the 2026-08-28 measurement's "no request" over thirty seconds: a version check running its ladder would have issued three. Read the network tail of the next cold login before calling that measurement understood |
| the last server-composed sentence now asks the device which language it reads | after the next release, `[PUSH_REGISTER]` prints `locale=fr` or `locale=en` rather than `unstated` for a device that has restarted once - every client re-registers on its next start because the skip predicate changed shape. The VISIBLE half needs an iPhone AND a failed NSE, which is why the log line is the measurement |
| acknowledging a conversation from the notification shade | HARDWARE, both platforms. On A1: send from W1, background the app, tap **Marquer comme lu**, then OPEN the app - the badge must be gone, which is the half that needed `read_watermarks.ndjson`. Then the same with a quick REPLY, which now means the same thing. `logcat` must show `sendReadWatermark: queued+drained at=<ms>` with the SENDER's instant, never a value near `now`. Board row **NOTIF-6b**, and the iOS twin is written identically and equally unproven |
| search folds accents now, everywhere it folds case | **SEARCH-5, and it needs `W1 W2` only - no hardware.** Its five `PASS`es asserted the pre-fix behaviour (the row was written to RECORD the gap), so they are VOID and the runner's prediction is flipped. A run answering `noAccentFound=true` closes this; SEARCH-1, -3 and -6 are ASCII-only and unaffected |
| WP-REGRANT-2, a re-granted member's re-join | COMM-22, four grant/revoke cycles green - and COMM-8 reading `seedAfterTheGrant: true`, never `repaired`, which is a fallback and not a path |
| the auto-merge sweep drains its queue unattended | the next sweep after a merge must merge EVERY pull request that is mergeable, not one. Until 2026-09-01 each merge moved `main` and staleness-invalidated the rest, so the queue drained at one per pass and only while somebody pushed; the predicate now asks whether `.github/workflows/` or `.github/scripts/` moved instead. #302 and #303 are the population sitting on it - both `CLEAN`, both built on `6a356d7e`, neither touched by a gate change. One sweep log showing both merged closes this |
| a security advisory now has an ACTOR at all | `automated-security-fixes` was `{"enabled":false}` while alerts were on, and the `cargo` ecosystem limits `production-dependencies` to patch - so `serde_with` 3.19.0 -> 3.21.0 (GHSA-7gcf-g7xr-8hxj, medium, `frontend/src-tauri/Cargo.lock`) could be reported and never fixed by anything. Enabled 2026-09-02, and it fired within the minute - **onto a THIRD refusal nobody knew about**, the update job failing on a manifest cargo cannot parse (P1 below). So **this row cannot close on alert 210**: it closes on the first security pull request Dependabot opens for ANY directory, and 210 itself waits on the P1 |
| the auto-merge ceiling refuses a major | **half taken.** The workflow is enabled again and its shipped loop body was replayed over all 33 open Dependabot PRs: 26 merge, 6 refuse, and the 6 collapse to the two gates below. What replay cannot show is the workflow REFUSING in its own run log, because no major has opened since - so the row stays until a real one does, logging `REFUSED` and staying open |
| a proposed event now tells the association's calendar managers | **ANSWERED ON THE Mi 9T, 2026-09-09 - both halves.** Shade in 2 271 ms with the app backgrounded, in-app row rendered, two `event_proposed` rows written to both BDE validators, event left `pending`. The precondition was narrower than this row had guessed - the validator grant must be on the **BDE** (`a.isBDE = true`) and the proposer must hold `PROPOSE_EVENT` on a NON-BDE association, or their event is validated on the spot and never becomes a proposal - and both grants name their account by its OIDC **subject**, never a display name. Reading the notification instead of counting it found two defects, both fixed: the agenda's five resource pairs had shipped with their ACCENTS STRIPPED, and the two FORM pairs were still English on the legacy side. A test now compares the server's legacy sentence with the Android resource for every key. ([device-verification](device-verification.md#the-layout-pass-of-2026-09-09-and-the-sixth-check-that-ran-later-the-same-day)) |
| the five products the boutique never sold are buyable | **ONE MANUAL FLIP IS OWED, and it is the user's** (2026-08-31). `activationWithheld` releases a product when payments BECOME ready, and BDE's Stripe onboarding completed long ago - no event will ever fire for it, which is the correct behaviour for an allowlist and the reason a per-tier on-sale switch now exists. So: open `/associations/bde/edit`, Cotisations tab, tick **En vente** on the 170 EUR tier, then buy nothing and simply confirm it appears in `/shop`. The other four associations have no payment account at all, so their products are correctly withheld and release themselves when one arrives - what closes THAT half is the next association to finish onboarding, whose products must go on sale with nobody touching them |

---

## Owed to the USER - decisions, rotations and one-off clicks

**This section holds NO substance.** Every line points at the entry that carries it, and exists only
so that "what is waiting on me" is one list rather than a sweep of the file (user, 2026-09-02:
*"Fais moi une liste des choses qu'il me reste a faire"*). Delete a line when its target entry ships
or its click is made. A line here is a thing NO agent can do - a decision, a credential somebody
else holds, a console owned by the user, or hardware that does not exist.

| What | Kind | Where the substance is |
| --- | --- | --- |
| set up the external uptime probe that mails - **decided 2026-09-06, mail**; the probe must hit `/api/version` AND `/api/chat-delivery-health`, never the homepage, which answered 200 through both outages | ~1 click in Cloudflare or an uptime service | [P2 - NOTHING TELLS ANYBODY PRODUCTION IS DOWN](#p2---nothing-tells-anybody-production-is-down-and-both-outages-of-2026-09-01-were-reported-by-the-user-owed-to-the-user-a-decision-then-one-click) |
| `DEPENDABOT_ALERTS_TOKEN` - a fine-grained token with **"Dependabot alerts: read"** on this repository. The nightly alerts job has NEVER passed: it declared `security-events: read`, which is code scanning, and Dependabot alerts have no `permissions:` key at all, so `GITHUB_TOKEN` cannot read them at any setting. The job now reads this secret when it exists and fails loudly when it does not - deliberately, because an alert list nobody reads looks exactly like an empty one | 1 token, 1 secret | `.github/scripts/dependabot-alerts-report.sh`, and the 403 it now names correctly |
| App Store Connect: the 2.3.6 radio button | 1 click | [mobile](frontend/mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on) |
| Lydia's credentials, which Lydia owes | blocked upstream | WP-LYDIA-1 |
| **an iPhone - ON ITS WAY, and the user intends the WHOLE campaign to be re-run on it** (user, 2026-09-10). **iOS is the only thing "hardware-blocked" still means** - the redundant push `data` map on both platforms, the shade acknowledgement, iOS window layout, and no iOS build reaching a device without a pre-release. This is a DATE, not a wall: write those rows so they are ready to run rather than deferring their design | hardware, arriving | [device-verification](device-verification.md) |
| copy `canari-harness/` to the second machine to resume the campaign | 1 copy | [cross-client-campaign-resume](cross-client-campaign-resume.md) |
| **three legacy rows excluded from the import, to add by hand if they should be cotisants** - one whose `Cotisation` cell is empty while its neighbours are filled, and two whose destroyed accents no directory entry resolves. Decided 2026-09-11: an import may not guess, and the three carry no tag until somebody says so | 1 decision, then 3 rows | [P2 - the legacy rows are loaded and NOT ONE claim has been observed](#p2---the-legacy-rows-are-loaded-on-both-estates-and-not-one-claim-has-been-observed-shipped-2026-09-11-v0171) |
| **ask the School's network service what is scheduled on `fw-ste.emse.fr` between 22h and 23h.** Two production boxes that share no hardware lose their egress together for minutes at a time, always in that band; the firewall is outside the access scope here and nothing in this repository can shorten the cut | 1 conversation | [P1 - production goes dark in the 22h band](#p1---production-goes-dark-in-the-22h-band-and-the-only-thing-both-boxes-share-is-the-schools-firewall-measured-2026-09-11) |
| **rotate the tunnel run token on the production origin** - it was printed in full into an agent transcript on 2026-09-11 by `systemctl status`, and it sits in the unit's `ExecStart`, so it is readable by anything that can run `ps` on the box. The procedure and the ORDER that matters are already written | 1 dashboard refresh, then the unit | [cloudflare-edge](infrastructure/cloudflare-edge.md#rotating-the-run-token-and-the-order-that-matters) |
| **rotate one credential that an hourly job on a production box passes ON ITS COMMAND LINE**, and move it into a root-only environment file - a password in `ExecStart` or a crontab is readable by every local user through `ps`, and this one was exposed in a transcript on 2026-09-11. The host and the value are in the operator's local agent memory, deliberately: this repository is PUBLIC | 1 rotation, 1 file | agent memory (secret-adjacent, must never enter this repo) |

## Open defects, in severity order

### P1 - the send checkpoint has a seam, and the native side never filled it

`BaseMlsService.checkpointAfterSend` carries a docblock that states an invariant and names the
incident behind it: **`mls.bin` is never behind a frame that has already left the device**. The
failure it describes was measured on the phone on 2026-08-14, twice, on a fleet with nothing else
happening to it - a client sends, is reloaded before the checkpoint lands, drains its durable outbox
against a state read back from disk that is BEHIND the sends the previous session made, and the
peers refuse those frames with `SecretReuseError`, correctly reporting that the sender's ratchet
rewound.

The docblock then says: *"The DEFAULT does not await, and that is web's answer on purpose ... Native
overrides this - see `TauriMlsService`."*

**There is no override.** `checkpointAfterSend` has exactly two occurrences in the whole tree, both
in `BaseMlsService.ts` - the call and the default. `git log -S` over `TauriMlsService.ts` returns
nothing: one never existed. The commit that introduced the method says so itself (`f391c1991`,
"`checkpointAfterSend` is added as the seam for the half that is still open"), so this is a designed
fix that was never wired, not a regression. The guard the docblock relies on (`liveMutations`) is
per-page-session while the outbox is durable, which is precisely why the native await was owed.

So on the one platform where the fault was actually observed, the stated invariant does not hold.

**This is one of four checkpoint routes carrying three different durability guarantees** (audit item
D8), and the only one whose documentation and behaviour disagree:

| Route | Guarantee |
|---|---|
| `persistCheckpoint()` | durable before return, or it throws |
| `persistMlsStructuralCheckpoint({mlsService})` | same, with a fallback |
| `persistMlsStructuralCheckpoint()` (no argument) | durable **only if a persister is registered**; otherwise writes nothing and returns `false` |
| `checkpointAfterSend()` | never awaited; deferred to a microtask, and suppressed outright while `bulkIngestDepth > 0` |

### The MLS audit items that are still real, with their verified counts (swept 2026-09-12)

**These numbers are the swept ones, not the audit's.** The audit was written by reading the source,
so each item was a hypothesis; the counts below were re-derived against `main`, and eight of them
came back LARGER than claimed. Every item the sweep killed has been deleted from this list rather
than recorded - what shipped is in `CHANGELOG.md`.

**Duplicate paths to fuse** (the user's decision, verbatim: *"Fusionner vers une implementation"* -
a real collapse, not a test that fails on divergence):

| Item | What is duplicated | Count | The part that bites |
| --- | --- | --- | --- |
| `S-D1` | `pending -> active` on a device membership | 5 paths, 3 writers | THREE gate behaviours: `activateDeviceMembership` warns and returns, `updateInvitationStatus` throws, and `createGroup` has **no addressability gate at all** |
| `S-D2` | `ABSENT\|active -> pending` | 5 writers + 3 inserts | they disagree on `kickedAt` and on the Redis SREM; `sendWelcome` *resets `kickedAt` to null* |
| `S-D9` | Redis routing-set refill from the rows | 3 identical blocks | `messaging.service.ts:2045`, `:2213`, `:2297`. A fourth site (`:838`) is a different mechanism and stays |
| `S-D6` | base publication onto one `putGroupInfo` | 3 writers | |
| `S-D8` | group tombstone | 3 routes | |
| `S-D10` | orphan-group purge | 3 call sites | |
| `S-D5` | commit replay | 2 routes | the PushSecret route silently coerces a missing/negative `sinceEpoch` to 0 where the JWT route rejects it |
| `S-D4` | add-lock TTL | 2 policies | clamped 1-60 s vs hard-coded 15 s |
| `S-D7` | send | 2 routes | |
| `D8` | checkpoint | 4 routes, 3 guarantees | see the P1 above |
| `G-D11` | ways `holdsGroupState` becomes false | **6 sites** | audit said 2 |
| `R-D6` | where eviction is learnt | **5** | audit said 3 |
| `R-D7` | conversation-row builders | **4** | audit said 2 |
| `R-D8` | outbox flush triggers | **6 triggers, 8 sites** | audit said 5 |
| `R-D3` | stale-base repair | 2 mechanisms | the responder (`sessionAuth.ts:1107-1130`) gates on `isGroupActive` and never calls `classifyBase` |
| `R-D9` | "re-add the requester" | 2 entrances, 1 responder | the deferred-drain entrance passes no `onNotReady`, so a still-not-ready group is dropped rather than re-deferred |
| `R-D10` | `no_peer_online` recorded | 2 ways | only one is discharged by a presence edge; `noRepairerAt`/`lastReAddAt` are not |
| `G-D1` | `ensureDistributionGroupFor` | 5 call sites | deduplicated only by an in-flight map |
| `G-D9` | rotation reasons | 4 -> 1 outcome | the reason survives only in a log line |
| `D1`, `D3`, `D4`, `D5`, `D9`, `D10`, `D12`, `D13` | see the MLS client sweep | 2-3 each | `D3` is three forget+rejoin escalations for ONE condition |
| `G-D2`-`G-D8`, `G-D10`, `G-D13`, `G-D14` | Graine entry points | 2 each | `G-D6` (requester fail-open / answerer fail-closed) is deliberate and stays |

**Availability dead ends - every one needs an exit that EXISTS** (the user, 2026-09-12: *"on ne peut
pas demander a un utilisateur de sortir de l'impasse lui-meme. La sortie de l'impasse doit exister
pour garantir la disponibilite"*, scoped the same day to availability rather than deliberate
refusals):

| Item | The state | Population |
| --- | --- | --- |
| `S-E1`/`DE4` | a commit-log hole | **18 holes, 11 of 58 groups, every one exactly ONE epoch wide** |
| `S-E5` | a `pending` seat nobody honours | **30**, all `never added`, zero carry `kickedAt` |
| `S-E3`/`G-E3`/`DE3` | stale base, every holder behind | **1 group** |
| `S-E7` | `latestKeyRotationPayload` | **NULL in 58 of 58** - the column is dead |
| `R-E3` | `ROSTER_DISAGREE` | outbox has no attempt ceiling; `sender-not-active` is neither permanent disposition |
| `R-E4` | an `isGroupHealthy` hold | returns `retry` without incrementing `attempts` or writing `nextAttemptAt` |
| `R-E8` | exit-owed limbo | the group is invisible **and** un-recoverable while the server never answers; no counter, no expiry |
| `R-E1`/`DE2` | `NO_REPAIRER` | left only by the epoch pair moving - which needs the holder that is absent |
| `R-E9`, `R-E11` | peer-unresolved; `readWelcomeOwed() === null` | retried for ever, no counter |
| `DE7` | `MLS_LOCAL_STATE_UNDECRYPTABLE` | the only route offered requires the OLD PIN |
| `DE10` | an undecodable payload | never enqueued, so never ACK-able; the code names the 90-day retention window as its only terminator |
| `DE13` | leaving a conversation | nothing stages a Remove for the leaver's own leaf |
| `G-E1`, `G-E2`/`DE11` | no distribution group for a scope; 403 on one | log and `return false`, no retry |
| `G-E6` | `historyAsked` set when nobody could be asked | cleared only by the community leaving the device, or a restart |
| `G-E10` | `forgetCommunityGraine` with no runtime | warns, returns 0; seeds and joined groups stay |
| `S-E10` | base-refresh answering `no_peer_online` | persists nothing at all |

### P2 - five conversations rest on ONE holder and one has none, and the report can only say so (measured on production 2026-09-12)

**The measurement.** Of 58 live groups on production: 1 with zero holders, 9 with one, 48 with two
or more, counting a holder as a DISTINCT USER holding an `active` device membership. Five of the ten
have fewer than two rows in `dm_group_members` and are one-person groups or orphans rather than
conversations; the five that remain are real, and one of them is a DM at **epoch 284 with six
devices sitting `pending` on it**, four of them created the day of the measurement.

**What shipped.** `reportSingleHolderGroups`, hourly, beside the other three reports - WARN at one
holder, ERROR at zero, with the pending count beside each because a pending device is the cheapest
second holder available. The predicate requires two user-level members, and that requirement came
out of the measurement rather than out of taste: without it, half of every line is debris.

**What is open, and it is a design decision rather than work.** The report names the population and
cannot repair it. DE2 is terminal by RFC 9420 construction - every way into a group requires a party
holding the group secrets, and this server holds only ciphertext - so the only useful moment is
BEFORE the last holder goes, and the only levers are upstream:

- **Land the Welcomes that are already owed.** Six pending devices on the epoch-284 DM would each
  become a second holder. Whether they were starved by the background re-add returning 400 (fixed
  2026-09-12) is measurable from the next report after that fix ships, and that is the first thing
  to read rather than the first thing to build.
- **Tell somebody.** A conversation with one holder is a fact about a USER's own account, and
  nothing surfaces it to them. What channel, and whether it is worth surfacing at all, is undecided.
- **Refuse the last exit.** A client could decline to forget a group it is the last holder of
  without warning. This one needs care: a destructive control gated on a server's count is a
  fallback path, and the count is a proxy.

Nothing here is to be built before the next report is read. See
[the state machine](protocols/mls-graine-state-machine.md), section 9 (DE1, DE2) and section 10.

### P1 - a damaged local MLS state is reported as a PIN rotation, and the PIN the user actually holds does not get them back in (measured 2026-09-08)

**The measurement.** CORRUPT-2 (`corrupt2.mjs`) XORs ONE byte at the midpoint of the 18.4 MB
`mls_autosave` ciphertext, leaving length and shape intact, and reloads. The client reaches its PIN
gate - it does not hang, and it does not come up quietly showing an empty history - and it says:

```
[INIT] Login did not complete (state_sealed_with_old_key):
Votre PIN a ete change sur un autre appareil. Recuperez vos messages avec votre ancien PIN.
```

**RAISED 2026-09-08 BY CORRUPT-1, FROM A WRONG MESSAGE TO A DOOR.** The same damage in its most
realistic shape - the state cut to HALF its length, which is what an interrupted flush, a full disk
or a killed tab leave behind - produces the same `state_sealed_with_old_key`, and then:

```
recoveredWithTheCorrectPin = false
recoveryTrail = ['LOCKED+overlay', 'LOCKED+overlay', 'LOCKED+overlay', 'LOCKED+overlay', 'LOCKED+overlay']
```

`bringToReady` is the PRODUCT's own recovery - it answers the gate with the correct PIN exactly as a
user would - and five passes left the client locked. **The control is inside the row**: once the
snapshot is restored, the same helper with the same PIN reaches a named starting point, so what locks
the gate is the truncated state, not the gesture. Clean, no dirt, reproduced twice.

So the user is told to recover with an old PIN that never existed, and the PIN they DO hold does not
work either. **What is NOT measured**: the modal carries a sign-out button (`onSignOut` is a required
prop precisely because the modal blocks the app), and whether that clears the unreadable state and
lets the device re-enrol has not been tested - it is destructive to the fixture. If it does work, the
defect is that the one remedy is never named and is presented as the destructive last resort; if it
does not, the device is simply lost. **That measurement is answered below by reading, and the run is still worth having.**

**Why that is wrong.** No PIN was changed. `sessionAuth` verifies the PIN SERVER-SIDE and only then
decrypts the local state, so at the moment this message is chosen the product already KNOWS the
credential in the user's hands is the right one. The message sends them after an old PIN that does
not exist, never names the real cause, and never offers the one recovery that works - the clean
re-enrolment CORRUPT-4 measured on the same estate the same day, where a device with no usable state
re-joined all four of its groups self-service.

**THE LOOP IS CLOSED, AND THE LAST DOOR IS THE DESTRUCTIVE ONE.** The sign-out question this entry
owed is answered by READING rather than by a run - deliberately, because measuring it means signing
W1 out, and if the device key is not reproducible from the PIN alone the restored snapshot becomes
undecryptable and the fixture's history is destroyed by the very check investigating its destruction.
`ChatBackgroundService.handlePinSignOut` says what it does in its own first line:

```
[AUTH] Sign-out from the PIN gate - ending the session, keeping the local state.
```

So signing out and back in re-reads the same damaged bytes, re-arms `noFreshStart: !!bytes`, and
returns to the same wall. Every exit the blocking modal offers is therefore accounted for:

| what the user is offered | what it does about a DAMAGED state |
| --- | --- |
| the message's own advice - "recover with your old PIN" (`onRecoverPin`) | nothing: no old PIN sealed this blob, so the recovery cannot succeed |
| entering the CORRECT PIN | **measured `LOCKED+overlay`, five passes** (CORRUPT-1) |
| signing out (`onSignOut`, a REQUIRED prop because the modal blocks the app) | keeps the local state by design - the next sign-in hits the same failure |
| `onForgotPinReset` -> `POST /api/mls/security/pin-reset` | **works, and is the only thing that does** - a server-side reset that DESTROYS the messaging state, behind a disclosure and a two-step confirmation, and labelled for a PIN the user has not forgotten |

**That is the severity.** The user is told the wrong cause, pointed at a remedy that cannot work,
refused by the credential they actually hold, and the one action that unblocks them is presented as
the destructive last resort for a different problem entirely. Meanwhile the product ALREADY knows how
to recover this device without destroying anything: CORRUPT-4 measured a client with no usable state
re-joining all four of its groups by external commit, self-service, in under a second. The whole
defect is that nothing tells `noFreshStart` that this state is damaged rather than foreign.

**Measured**: the misdiagnosis (CORRUPT-2, CORRUPT-1) and the locked gate (CORRUPT-1). **Read, not
run**: the sign-out and reset behaviour above. A run for the sign-out half is still worth having once
there is a device whose history is expendable - it is the one line in that table taken on trust.

**It is the vault defect one layer down.** `init` reports `MLS_LOCAL_STATE_UNDECRYPTABLE`, and an
AEAD tag that does not verify has two causes that the blob alone cannot separate: the state was
sealed under a DIFFERENT device key (a PIN rotated on another device - ordinary, recoverable with the
old PIN) or the ciphertext was ALTERED (corruption - the old PIN is irrelevant). One code path names
both and distinguishes neither, which is exactly what `loadDeviceKey` did until 2026-09-08.

**`mls_autosave_ver` cannot settle it**: it is a per-write SEQUENCE COUNTER that orders concurrent
flushes, not a key id. Nothing stored beside the blob says which key sealed it.

**The fix has the same shape as the vault's, and the discriminator is already known at the decision
point.** Two candidates, and the second is cheaper:

1. Store a short fingerprint of the device key beside the state at save time (a MAC of a constant
   under that key). On a failed decrypt, a fingerprint that MATCHES the current device key excludes
   rotation, so what is left is alteration; a mismatch is the rotation the message describes.
2. The server already knows when the account PIN was last rotated - it verified the PIN. If the
   stored state was written AFTER the last rotation, a rotation cannot be the cause. This carries the
   discriminator to where the decision is made from where it is already KNOWN, which is the rule, but
   it needs a server field the client does not have today.

**What it must NOT become.** A fallback that re-enrols whenever a decrypt fails would destroy the
history of every user whose PIN really was rotated - the case `noFreshStart` exists to protect. The
two causes have to be TOLD APART, not merged; the point of the fingerprint is that it makes the
distinction a fact rather than a guess.

**THE MECHANISM, AND IT IS ONE THE REPOSITORY'S OWN RULES FORBID.**
`BaseMlsService.classifyStateLoadFailure` decides between `mismatch` and `sealed` like this:

```ts
return errStr.includes('identity mismatch') || errStr.includes('Credential identity')
  ? 'mismatch'
  : 'sealed';
```

It BRANCHES ON AN ERROR MESSAGE - *"a distinction carried in prose is a distinction exactly ONE call
site will make"* - and its default arm is `sealed`. So every failure the two needles do not recognise
becomes "your PIN was changed on another device", corruption included. Its own doc-comment records
that an earlier version of this same confusion *"surfaced a false 'your PIN was changed on another
device' to users who had never changed their PIN"*; the case was fixed for `mismatch` and left
standing for everything else.

**WHY THIS IS A WORK PACKAGE AND NOT A SESSION-TAIL FIX - RE-SCOPED 2026-09-08 BY READING THE
CRATES, AND THE ORIGINAL REASON WAS WRONG.**

This entry used to say the blocker was storage: *"the fingerprint has to be STORED somewhere both
platforms can read... the phone keeps its state in `mls.bin` through Rust and has no matching
side-channel today"*, and that doing it on the web alone would recreate CORRUPT-4's asymmetry. **The
premise does not hold.** `frontend/mls-core` is a dependency of BOTH `frontend/mls-wasm`
(`Cargo.toml:10`) and `frontend/src-tauri` (`Cargo.toml:28`), and `MlsManager::save_encrypted_with_key`
/ `load_with_key` in `mls-core/src/crypto.rs` are the one place the state is sealed and opened for
either platform. There is no side channel to invent and no asymmetry available to create: the
fingerprint belongs in the blob's OWN framing, written once, read by both. The TS side treats the
blob as opaque and delegates to WASM, so it needs no format knowledge at all.

**BUT IT IS STILL A WORK PACKAGE, FOR A DIFFERENT AND HARDER REASON: THE WRITE PATH CANNOT MOVE
FIRST.** `tests/cross_version_state.rs` states its own scope in its header - one generation of
fixtures proves *today's code reads what v0.14.14 wrote*, and *"says nothing about whether today's
code writes something v0.14.14 could read, which is the other direction and matters when a fleet is
mixed"*. That other direction is exactly what a header would break: an older build handed
`[magic][keyId][nonce][ciphertext]` reads the first twelve bytes as a nonce, fails the AEAD, and
reports the state unopenable - this very defect, newly caused by a downgrade. Downgrades are not
hypothetical here: the APK is reinstalled by hand all through a campaign session, and a store
rollback does the same thing to a real user.

**So the sequence is READ-FIRST, WRITE-LATER, and it spans two releases:**

1. Teach the reader the versioned header (and keep reading headerless blobs, which is the LEGACY
   FORMAT and not a fallback), and type the failure at the throw. Behaviourally inert - nothing
   writes a header yet - which is the point: it can ship without a downgrade hazard.
2. Once that reader is the floor everywhere (`minClientVersion` is the lever), flip the writer. The
   classification becomes real at that moment and not before.

**THE HEADER GOES AT THE STATE LAYER, NEVER IN `security::encrypt_blob`.** That function is shared
with `mls-wasm/src/pin_crypto.rs`, which seals the PIN-protected BACKUP files, and with the
pre-v0.11.0 legacy reader in `src-tauri/src/commands/mls.rs`. Changing it would silently change the
backup format too - a second, wider migration nobody asked for, on files users keep off-device.

**The touch points, enumerated rather than estimated** - writes: `encrypt_state_blob_with_key`,
`save_encrypted_with_key`. Reads that must accept both shapes: `load_with_key`, the keystore probe
in `resolve_at_rest_key` (it calls `decrypt_blob` on the raw blob after a bare `len() >= 12` check),
and `mls-wasm/src/lib.rs::decrypt_mls_state_blob_with_key` (same bare check). The legacy re-seal in
`src-tauri/src/commands/mls.rs` already writes through `encrypt_state_blob_with_key`, so it inherits
whatever that does.

**STEP 1 IS DONE (2026-09-08, not yet shipped), MINUS THE HEADER - AND IT WENT FURTHER THAN THE
TYPED ERROR, BECAUSE THE NAMES WERE THE DEFECT TOO.**

`MlsError` gained `StateUndecryptable` and `StateIdentityMismatch`, whose `Display` forms lead with
`STATE_UNDECRYPTABLE:` / `IDENTITY_MISMATCH:` - the same shape as `EVICTED:` and `NO_SUCH_MEMBER:`,
which this enum already uses for exactly this reason. Both throws were `mls-core`'s own, so there
was never a dependency's prose to match; what there was was a DEFAULT ARM, and it is gone:

```ts
if (errStr.includes('IDENTITY_MISMATCH')) return 'mismatch';
if (errStr.includes('STATE_UNDECRYPTABLE')) return 'undecryptable';
return 'unknown';                      // and it WARNS, because it used to be silent
```

Three renames carry the point, and each one was a claim the product could not support:

| was | is | why the old name was wrong |
| --- | --- | --- |
| `'sealed'` | `'undecryptable'` | "sealed" names a CAUSE; a failed AEAD tag is an OBSERVATION with two |
| `state_sealed_with_old_key` | `local_state_unopenable` | the login code the UI routes on, asserting the same thing |
| `auth_state_sealed_old_pin` | `auth_local_state_unopenable` | the sentence the user reads |

The new message states both possibilities and **names the reset**, which is the one remedy that
works on a damaged state and was previously offered only as the destructive last resort for a
problem the user did not have. The old-PIN path is still offered: it costs nothing, destroys
nothing, and is genuinely one of the two cases.

**The blocking test was also rewritten from `=== 'sealed'` to `!== 'mismatch'`.** Written the first
way it excluded `unknown` by accident - an unrecognised failure would have been rotated away instead
of paused on, which is the classifier's old default arm seen from the other side.

**`InvalidData` for a blob under twelve bytes went too.** That is what an interrupted flush, a full
disk or a killed tab leave behind - the most realistic corruption there is - and it answered a name
shared with unrelated parse failures, so it collected the default diagnosis like everything else.

Tests: four in `mls-core/tests/state_load_failure_is_typed.rs` (wrong key, flipped byte, three short
lengths, and the no-state control), six on the classifier including one that asserts the OLD PROSE
no longer classifies - if it ever does again, someone has put the distinction back in a sentence.
The previous test file asserted the defect: its last case was named *"defaults to sealed for an
unrecognised failure"*.

**STEP 1 IS NOW COMPLETE - THE READER LANDED 2026-09-08, AND IT IS THE WHOLE OF THE READ-FIRST HALF.**

`mls-core/src/state_blob.rs` is the one place either platform decides what shape a state blob is:

```
legacy : [nonce (12) || ciphertext]                                  <- every installed device
v1     : [b"CANARIS" || 1 || key_fingerprint (8) || nonce || ct]     <- nothing writes this yet
```

Seven magic bytes plus a version byte make "is this framed" a 2^-64 question against 12 bytes of OS
randomness, **which is why there is no re-parse-as-legacy retry**: a retry would be the fallback this
repository forbids, and it would turn a genuinely corrupt framed blob into a confusing legacy one.
The fingerprint is eight bytes of SHA-256 over a domain constant and the key - deliberately NOT the
AEAD under a fixed nonce, the tempting dependency-free option, because the state blobs draw random
nonces from the same key and a fixed one carries a 2^-96 chance of reusing a nonce whose plaintext is
a PUBLIC CONSTANT, which leaks the keystream and therefore the state.

**THE THREE READERS ARE NOW ONE.** `load_with_key`, the keystore probe in `resolve_at_rest_key` and
`mls-wasm`'s `decrypt_mls_state_blob_with_key` each carried their own `len() >= 12` - a test a framed
blob passes while holding four bytes of body. The probe mattered most: on a framed blob it would have
handed the header to the cipher as a nonce, failed the tag, and DELETED A PERFECTLY GOOD KEYSTORE KEY,
manufacturing this very defect on the next launch.

`MlsError::StateSealedUnderAnotherKey` (`STATE_KEY_MISMATCH:`) is thrown when a framed header names a
key other than the one in hand - checked BEFORE the cipher, because *never learn by failing what a
fact could have told you*. The classifier learns it in the same release as `'rotated'`, and needs no
new branch at any call site: every `cause !== 'mismatch'` path already pauses and asks for the old
PIN, which is exactly right for a real rotation, and the pre-v0.11.0 Argon2id retry keys off
`undecryptable` and must not fire for a v1 blob. Recognising it now rather than at step 2 is not
eagerness: routed through `unknown` it would print *"not typed by mls-core"* about an error mls-core
types, and an accusation that is wrong is worse than one that is missing.

**THIS RELEASE IS BEHAVIOURALLY INERT AND THAT IS THE POINT.** No blob in the field has a header, so
every load still takes the legacy arm and still answers `StateUndecryptable`. What shipped is the
FLOOR: once `minClientVersion` puts this reader everywhere, step 2 is one line at
`save_encrypted_with_key`, and `state_blob::frame_v1` already exists and is tested so that flip is not
a design revisited months later. Two integration tests stand in for field evidence until then - a
framed state opens with its own key, and one sealed under another key is named a rotation while the
IDENTICAL ciphertext unframed can still only be called undecryptable, which is the entry's whole
argument in one assertion.

**STEP 2 IS UNCHANGED AND STILL OWED**, and it is blocked on exactly one thing: this reader being the
floor. Until then the two causes remain unseparated in the field.

**Where the evidence is.** Board cell CORRUPT-2 on [cross-client-testing](cross-client-testing.md);
the runner and its reasoning in `tools/cross-client-harness/archive/corrupt2.mjs`; the parallel fix
and its five tests in `frontend/src/lib/utils/deviceKeyVault.ts` and its test file.

---

### RESOLVED 2026-09-08 - the "zombie socket" was the row grading its own precondition, and one question survives it

**FILED AS A P1 CANDIDATE THE SAME AFTERNOON, AND EVERY LOAD-BEARING CLAIM IN IT WAS WRONG.** It is
kept rather than deleted because the way it was wrong is the finding: three logs existed the whole
time that would have settled it in minutes, and none of them had been opened. What follows is what
each one said.

**THE SOCKET WAS NEVER A ZOMBIE. The gateway held it and wrote to it.**

```
13:50:30.807  New WebSocket connection ... Device=tauri-...-mtn445lg-25sy (conn_id=2703, 1 active)
13:50:32.372  [PubSub] route kind=mls target=...:tauri-...-mtn445lg-25sy queuedId=875958e0-...
13:50:32.372  [Gateway] Message directly routed to ...:tauri-...-mtn445lg-25sy
```

The delivery service agrees and goes further - it queued the message for every recipient, not only
the reachable ones, and pushed to the one that was not:

```
[SEND][send-1f7491f4] QUEUED count=6
[SEND][send-1f7491f4] recipient=...:tauri-...-mtn445lg-25sy online=false queuedId=9110ed23-...
[PUSH_SEND][send-1f7491f4] FCM sent ... platform=android inlineProto=true bytes=659
```

and the phone drained its backlog and acknowledged it (`[ACK] requested=2 -> deleted=2`, then
`deleted=1`), which this client does **only for rows it successfully handled** - `BaseMlsService.ts`
refuses to acknowledge what it could not deliver. Transport, queue, push and acknowledgement all
worked. The `4 pings without server response` line arrives AFTER the row backgrounds the app and
describes a socket the client itself had just paused.

**`make local-frontend` DID NOT RUN BEFORE THESE RUNS.** The entry asserted it "ran immediately
before the first of these two". Measured: `canari-local-nginx-1` started `13:28:36Z`, the runs
recorded at `13:41:17Z` and `13:52:06Z` - thirteen and twenty-three minutes later - and
`canari-local-chat-gateway-1`, which terminates the WebSocket, had been up since **2026-09-04**. The
alternative that made this a CANDIDATE rather than a P1 was false, and so was the P1 it was hedging.

**WHAT ACTUALLY HAPPENED: the row measured a booting app and blamed the notification layer.** Its
own docblock forbids exactly that sentence, and the delivery service dates the boot - thirteen
seconds AFTER the warm-up was sent, the phone was still registering:

```
13:50:32  warm-up routed to the phone, acked
13:50:45  [REGISTER_DEVICE] isNew=false pendingGroups=7
13:50:45  [REGISTER_PREKEYS] count=6
13:50:45  [USER_GROUPS] groups=7
13:50:45  [INVITATIONS PENDING] START
```

Meanwhile the row's actual subject passed every clause it has: `notifiedInMs` **2206** and **2203**,
inside the 10 s discriminator, with the body drawn - `itCarriedTheMessageAndNotJustASenderName` was
never unmet. Both runs were recorded `FAIL`.

**THE GRADING DEFECT, FIXED.** `notif.mjs` put four preconditions into the same array as its product
clauses, where `unmet.length > 0` made every one of them a product verdict - while the comment on
each said the opposite ("a RIG CLAUSE, not a product one", "the OS is cutting it", "different
findings and must not share a verdict"). A failed precondition now yields `SETUP-FAILED` with
`notMeasured` naming it. This is deliberately NOT the `baselineTooSlow` rule, which still lets a
product failure win: a slow-but-arriving warm-up proves the app IS routing, so the other clauses
were validly asked; a warm-up that never arrives proves nothing downstream was asked at all. The
same conflation was in `k.mjs` (NOTIF-6c), whose `thePreconditionWasArmed` clause is labelled "NOT a
product clause" where it is pushed and was graded `FAIL` anyway. Fixed identically.

**AND THE ROW SWALLOWED THE PRECONDITION UNDER THAT ONE.** A1's `ensureChat` and `openConversation`
were `.catch(() => null)` - no line, no field, `clean: true` - so "the DM never opened" and "the DM
was open and nothing came" produced identical runs. They are now recorded in `a1SetupFaults`,
announced on the console, and asserted as `theDmWasOpenOnThePhone`.

**THAT QUESTION IS ANSWERED, AND IT WAS THE RIG.** The next run said so by construction, exactly as designed: `theDmWasOpenOnThePhone` unmet, and the sentence `.catch(() => null)` had been discarding all along - *"openConversation: 2 of 5 conversation tiles match the requested name on port 9333, so the row is AMBIGUOUS and none was opened."* A group deleted seven hours earlier was still in the phone's sidebar under the PEER's name, colliding with the DM. Cleared by hand (P2 below), the row was re-run and **every product clause passed**: `unmet []`, notified in 4 231 ms with the body drawn, the app alive, hidden, networked, and holding the message. So the 77-second silence was a conversation nobody had opened, not a message that vanished - and no product defect was ever in this. **What is left is the slow baseline**: the warm-up took 19 992 ms in the FOREGROUND, past the 10 s discriminator, so the row honestly records `SETUP-FAILED` rather than inventing a verdict. That is the blob P1 above, and it is the only thing now standing between NOTIF-1b and a measurement.

**Recorded beside it, unchanged and unseparated**: `mls.bin` is **10 237 105 bytes** on this
handset, the blob a checkpoint re-encrypts per message and the prekey-churn P1 above is what grows
it. And `queued_message` holds **13 275 undrained rows** (12 051 web, 1 224 tauri) for dead test
devices going back to 2026-08-05, which `cleanup.mjs` does not sweep.
---


### P2 - the legacy rows are LOADED on both estates, and NOT ONE claim has been observed (shipped 2026-09-11, v0.17.1)

**1429 rows are staged on dev and on production** - 269 BDE, 1160 Cercle, applied through
`--emit-sql` and `psql`, `INSERT 0 0` on a re-run. Nothing is waiting on a load any more. What is
still missing is a single observed claim: the mechanism has never been watched granting a tag to a
real person, and the instruments that would show it - the service log line and
`/admin/legacy-cotisations` - have never been read against one.

**Sixty accounts will settle it without anybody arranging anything.** Projected against production's
396 accounts by computing each user's key with `normalizeMatchKey` itself, rather than an
approximation of it in SQL:

| | staged | has an account today | will be GRANTED | will close `already-held` |
| --- | --- | --- | --- | --- |
| BDE | 269 | 152 | 27 | 125 |
| Le Cercle | 1160 | 156 | 33 | 123 |

Zero keys are held by two accounts on either estate, so the collisions tab starts empty and any row
appearing in it later is a real homonym. The remaining ~1120 rows belong to people with no account,
which is the whole reason this is a staging table and not a one-shot grant.

**`already-held` is the DOMINANT case, not the rare one** - 248 of the 308 rows that have an account.
Each is somebody who already paid through Canari and whose row closes without granting, because the
sibling-tier revoke inside `grantCotisant` would otherwise take away the tier they paid for. The
guard is therefore load-bearing on first contact with real data, and it is the one thing to read on
the screen once sign-ins start.

**What to read, and when.** The next time somebody signs in, `/admin/legacy-cotisations` should move
off zero in the claimed tab. Until it does, an empty screen and a broken claim still look identical.

**Both assumptions behind the keys are now measured.** The promo conventions of Authentik, the
Cercle legacy base and the directory export agree at offset 0 - 206 accounts match the directory and
119 a Cercle cotisant, against 12 and 2 at offset +1 and nothing beyond. Had Authentik sent a
graduation year where the legacy stores an entry year, every key would have been wrong by 3 with
nothing to report it. And `promo.csv`, which the 141 accent repairs rest on, is an export dated
2025-11-13 covering 2016-2025 - contemporaneous with the sources it repairs, not older. It covers
962 of the 1019 undamaged Cercle cotisants (94%), with 26 of the 141 repairs in a promo below 90%.
**The decisive test simulated the exact failure mode**: corrupt an accented name, REMOVE its true
owner from the reference, run the real repair. 599 simulations, 599 refusals, zero wrong person
accepted; with the owner present, 599 of 599 named correctly.

**The promo-2026 cohort is unserved by design and it is the LARGEST.** 153 of the 396 accounts -
more than any other promo - are 1A who arrived after both lists were frozen. They appear in neither
source, so they must pay through the shop, and all three membership products are `isActive = false`.
The user confirmed 2026-09-11 that the inactive flag is deliberate and is not to be touched.

### P2 - a DELETED two-person group keeps the peer's name in the sidebar, so it is indistinguishable from the DM (measured 2026-09-08)

`e615e00a-2c4d-443a-a940-2ac33303647a` is `N17B-mtsi0qrfu86`, `isGroup=t`, `deletedAt
2026-09-08 10:02:22`. Seven hours later it was still the second row of the phone's sidebar, titled
**"Canari Test Beta"** - the other member's name - directly above the real DM with that same person,
titled identically:

```
2bd5add9-...  | Canari Test Beta | (the DM)
e615e00a-...  | Canari Test Beta | N17B-mtsi1ldyydy the first thing ever sa...
```

**The row keeping its place is by design; the row losing its NAME is not.** A tombstone's local copy
belongs to the client until it is dismissed - that split is deliberate and `dismiss.mjs` owns it. But
the group HAS a name server-side, and the client renders the peer-name fallback instead. For a user,
deleting a two-person group leaves two identical rows with that person's name and no way to tell
which is the conversation.

**It also disabled two instruments at once.** `openConversation` resolves a peer by TITLE and
correctly refused - *"2 of 5 conversation tiles match the requested name on port 9333, so the row is
AMBIGUOUS and none was opened"* - which is how NOTIF-1b lost three verdicts. And `isGroupDebris`
matches on the group's name, so the sweep cannot recognise the row either: enumerating from the DOM
would read "Canari Test Beta" and spare it.

**Not to be confused with the sweep gap beside it.** The phone keeps no `CanariDB_<user>` in
IndexedDB at all (origin `http://tauri.localhost` holds only `emoji-picker-element-fr`), so
`dismiss.mjs` cannot enumerate it from any client. That is a second, independent hole, now reported
honestly instead of as a chooser refusing.

**Cleared by hand on 2026-09-08** through the product's own control - open the tile by its
`data-conversation-tile` id rather than its title, then "Supprimer localement" - which is also the
proof the fallback is only in the rendering: the row was reachable and deletable the whole time.

**Blocked on nothing.** Local estate, test accounts, and a reproduction that takes one group.

### P3 - our message notification is not a CONVERSATION to Android, where the reference's is (measured against Messenger on the Mi 9T, 2026-09-09)

Asked by the user: *"tu as pu observer les notifications messenger sur le telephone pour voir si
nous sommes bien ?"*. Read from `dumpsys notification` on six live Messenger records, **structure
only - every `text` and `content-desc` was stripped before anything was read, and no capture kept**.

**On the shape of a message we already match it**, which is the half worth saying first:

| | Messenger | Canari |
| --- | --- | --- |
| `MessagingStyle` | yes | yes |
| a `Person` for the sender | yes | yes |
| direct reply (`RemoteInput`) | yes | yes |
| a large icon | yes | yes |
| grouped at all | yes | yes |
| bubble metadata | no | no |

**Two things differ, and both change how Android FILES the notification rather than how it looks.**

- **A conversation shortcut.** Every Messenger record carries
  `shortcut=thread_shortcut_GROUP:<id> found valid? true`. We publish none: there is no
  `ShortcutInfo`, no `ShortcutManager`, no `setLocusId` and no `setShortcutId` anywhere in
  `CanariFirebaseMessagingService.kt`, and no share target in the manifest. Since Android 11 that
  shortcut is what makes a notification a CONVERSATION - the section at the top of the shade, the
  option to mark a thread Priority, bubbles, and the avatar treatment. Without it ours is filed with
  the ordinary alerts whatever its style says.
- **One group for everything.** `setGroup(GROUP_KEY_MESSAGES)` is a single constant at all three
  call sites, with one summary; Messenger's key is per THREAD (`GROUP:<threadId>`). So four messages
  across two conversations collapse into one stack of four here, and into two stacks there - and the
  second is the one a reader can act on.

**What this is NOT.** It is not a rendering defect and nothing is broken; a notification arrives,
reads correctly and can be replied to. It is a placement difference, which is why it is a P3 and not
higher - and why it should be measured on the phone after any change, since nothing in CI can see
which section of the shade a notification lands in.

**Order if it is taken**: the shortcut first, because the per-thread group key is what a
conversation shortcut implies, and doing the group alone would split the stack without buying any of
the conversation treatment.

---
### P2 - a server exception's English text is shown verbatim to a French reader, at 185 call sites (counted 2026-09-09)

Depositing an event without the right flag answers `403` from
`global-admin-or-association-role.guard.ts`, whose message is
`Insufficient permissions in this association`. The calendar page prints **that string**, unchanged,
under the form - eight English words in an otherwise French modal, seen on W2 at 958px.

**The server is not wrong.** Its exception messages are dev-facing and MUST be English, like every
other log and error in this tree. What is wrong is a client that treats `error.message` as display
copy: nothing types a string as user-visible, so no compiler catches it, which is exactly why the
rule says *default to Paraglide for ANY new user-visible string, on the first draft*.

**The fix is on the CLIENT and it is a mapping, not a translation.** A refusal the reader can act on
is "vous n'avez pas le droit de deposer un evenement pour cette association", built from the STATUS
and the operation - never from prose that crossed the network. A message is a distinction carried in
words, and branching on it later is the failure this repository already names.

**COUNTED, AND THE COUNT IS WHAT PROMOTED THIS.** `err instanceof Error ? err.message : ...` appears
**185 times across 61 `.svelte` files**. Of those, **173 assign it straight to UI state and 2 hand
it to a toast; NOT ONE is log-only.** So this is not a modal with an English sentence - it is the
house style for reporting a failure, and every 4xx the API answers with prose reaches a reader in
whatever language the server happened to write it in.

**That changes the shape of the fix.** 185 hand-written mappings is not a pass anybody finishes, and
a partial one leaves the defect exactly where it was. What the count argues for is ONE helper the
call sites already have a reason to use - a failure classified at the THROW, as a type, with the
localized sentence chosen from the status and the operation - and then the sites migrate to it as
they are touched. The rule this repository already carries says the same thing about error prose:
*a distinction carried in words is a distinction exactly one call site will make*.

**What must NOT happen** is translating the server's messages. They are dev-facing and English is
correct for them, the same as every log here.

**Blocked on nothing** - local estate, and it reproduces on any 4xx the API answers with prose.

---
### P3 - a pending attachment's name is painted TWICE, 19px apart (observed on the Mi 9T, 2026-09-09)

Found while verifying the voice-note gesture and **not caused by it**: the recorder's only output is
a file, and this is the chip that every pending attachment gets, whatever produced it. A photo will
do the same.

Measured at 436px, both boxes 62px wide, in the same static flow:

| | element | box | overflow | hidden |
| --- | --- | --- | --- | --- |
| inside the tile | `span.line-clamp-2` | `21,830 62x26` | `hidden` / `clip` | 0 |
| under it | `div.truncate` | `21,849 62x14` | `hidden` / `ellipsis` | **70px of the name** |

The span is 26px tall from y=830, so it runs to 856 and the div starts at 849: **they overlap by
7px**, and the reader sees the same filename twice with the lower copy struck through the upper
one's descenders. The two also disagree about how to shorten a name - one wraps to two lines, the
other ellipsises - so the same string is abbreviated two different ways in one 62px column.

**One of the two is redundant and the fix is to decide which**, not to nudge a margin. The tile
already names the file; a caption under a 62px tile that hides 70 of its characters tells the reader
less than the icon does. **Whichever survives should be the only one**, and a test asserting that a
chip renders its name once would keep it that way.

**Blocked on nothing** - local estate, and it reproduces on any attachment.

---
### P3 - `cleanup.mjs` sweeps groups but not the delivery queue, and 13 275 rows have accumulated (measured 2026-09-08)

```
SELECT split_part("deviceId",'-',1) AS kind, count(*) FROM queued_message GROUP BY 1;
 web   | 12051
 tauri |  1224
```

Oldest row **2026-08-05**, spread over dead throwaway devices - the top six tauri device ids hold
326, 299, 275, 126, 94 and 59 rows each. Retention is 90 days, so this expires on its own; it is
filed because of what debris has already cost this campaign. Forty-two leftover groups made a run
misread twice on 2026-09-06, and sweeping them turned a `FAIL` into that row's first clean `PASS`
and PROVED a P1 - **debris does not just slow a run, it reattributes what the run measures**. A
device re-entering a long queue on every reconnect is the same shape of cost.

`cleanup.mjs` reports "nothing to sweep" against this state, which is the more precise finding: it
answers a narrower question than its name suggests. Either it grows a clause for the queue, or its
report says which stores it does not look at - a sweep that is silent about what it cannot see reads
as an all-clear.

**The GROUP half of this is fixed** (2026-09-08): `debris.mjs` named six runners while seven mint
groups, so three `N17B-*` groups from NOTIF-17b were permanent - the phone under test carried seven
groups where it should have carried four. The allowlist is widened, `debris-selftest.mjs` now
refuses when an unenumerated file calls `createGroup(`, and the three are swept (`CHANGELOG.md`).
What is left is the QUEUE half above, which no sweep looks at.

**Blocked on nothing.** Local estate, test accounts, destroyable.

---

## Notifications - the two builders, and the rung of the campaign that reads them as one

### P2 - a reaction to YOUR OWN message must notify by push, and today no reaction notifies at all (decided by the user 2026-09-10)

Every other reaction stays silent, which is what today's design already does and does deliberately:
`frontend/src/lib/mls-client/frameDelivery.ts` classifies a reaction as a `mutation`,
`{ silent: true, durable: true }`, carrying the reason *"It must not notify, and it must survive"*,
and the server states the same rule from its side. Both are right about the case they name - a busy
salon where people react constantly would be unusable. **The case neither distinguishes is a
reaction to something YOU wrote**, which is the only reaction a person is plausibly waiting for, and
which Messenger and Slack both notify.

**IT IS NOT BLOCKED ON THE SERVER HOLDING CIPHERTEXT, WHICH IS THE OBVIOUS WRONG ANSWER.** The
server cannot classify a frame and does not need to: the class is DECLARED BY THE SENDER, exactly as
`durable` is, and the reacting client already knows whose message it reacted to. So a fifth
`DELIVERY` class - silent for everyone except the author of the target - is expressible with no
plaintext leaving the device. That is the standing rule about carrying the discriminator to where
the decision is made.

**NOTIF-15 IS UNBLOCKED, AND ITS EXPECTATION INVERTS.** It could not be run while the design
notified on no reaction at all, because it would have failed against something doing exactly what it
said. It now asserts a notification for a reaction to the recipient's own message AND the silence of
every other reaction in the same run.

**ONE SUB-QUESTION IS STILL OPEN AND MUST NOT BE GUESSED: which Android channel.** `canari_social`
exists for reactions and comments on POSTS but sits at `IMPORTANCE_DEFAULT` and silent, which would
contradict "you are notified"; `canari_messages` rings like a message, which may be too loud for a
reaction. A reaction that notifies is also a notification the reader cannot mute separately unless
it gets a channel of its own. One line to the user settles it.

### NOBODY IS TOLD ABOUT A POST - SHIPPED 2026-09-10, and what is left is the gate it revealed

Reported as two asks in one breath: *"Les gens doivent avoir une notif pour tous les posts
d'associations"* and *"Les gens doivent avoir une notif pour tous les posts de gens ou d'assos
qu'ils suivent"*. Both are DONE - one sweeper with two recipient derivations, see `CHANGELOG.md`
and `apps/social-service/src/posts/post-announce.scheduler.ts`, whose docblock is the design.

**THE VOLUME QUESTION IS ANSWERED, AND IT WAS A MEASUREMENT RATHER THAN A DECISION.** This entry
used to park "368 recipients per post" as a product question owed to the USER. That was the wrong
denominator: what a reader experiences is notifications PER WEEK, and over the seventeen weeks to
2026-09-10 the local copy of production carries **0.53 association posts a week** (9 of 120 posts,
2026-05-13 to 2026-09-10) against **7.01 posts a week in total**. A personal post reaches **2.84
followers on average** (25 edges over 17 followed users). So no digest and no per-association
mute: at one announcement a fortnight, either would be a setting nobody would ever find, and both
can be added later without touching the sweeper - the recipient derivation is two private methods.
**Re-measure before believing this**: the predicate that named the last population is not the one
that names the next, and one `GROUP BY` settles it.

**`association_follows` IS DELIBERATELY NOT CONSULTED.** The first ask subsumes half of the
second: if every association post reaches the whole feed audience, following an association adds
nothing to what you are told. That table becomes the opt-in the day the first rule is narrowed,
which is the one change that would give this sweeper a third derivation rather than a different
one.

#### What this left open - the FEED half is fixed, the POPULATION is not

The feed gate shipped 2026-09-10: `FeedAudienceGuard` on the four read endpoints, one predicate
(`IS_FEED_AUDIENCE_SQL`) built from the same `FEED_AUDIENCE_WHERE` the announcer uses, so the rule
is still stated once per side. Verified on the running estate, not only by test - anonymous 401,
ICM 200, admin 200, neither 403, on all four endpoints, where the first row had been 200 with post
bodies.

### P1 - a FIRST message from someone you have no conversation with notifies, decrypts, and then goes nowhere: the tap does not land and the conversation is invisible until the app is restarted (user, 2026-09-08, on PRODUCTION)

Reported verbatim: *"Quelqu'un m'envoie un message alors que nous n'avons pas encore de discussion. Je
recois bien la notif, et le message est bien dechiffre. Mais quand je clique sur la notif 1) Je
n'arrive [pas] dans la conversation 2) la conversation n'apparait pas directement (apres un
redemarrage de l'app oui a priori, mais pas suite a reception de la notif)."*

**THE CAMPAIGN HAS NEVER ASKED THIS, AND THAT IS THE FIRST FINDING.** All sixteen NOTIF rows are
written against a conversation that already exists - the harness's fixtures pair two accounts that
have talked. First contact is a different path in every layer: the sender creates a group and sends a
WELCOME, the receiver must process it before the message decrypts at all, and a conversation record
has to be MATERIALISED rather than found. A row is owed for it
([cross-client-testing](cross-client-testing.md)).

**A DEVICE THAT IS OFFLINE WHEN IT IS ADDED IS NOT A RECIPIENT OF THE NEXT MESSAGE, AND NOTHING HERE
KNEW THAT** (measured 2026-09-08 building NOTIF-17b). W2 minted a group, added the owner and spoke
into it ten seconds later, with A1 proven dead throughout. The server:

```
10:04:51 [WELCOME][welcome-send-4964245c] ... FCM sent user=f7a9bb80...
10:05:01 [SEND][send-0d4e3672] QUEUED count=2
10:05:01 [SEND][send-0d4e3672] PUBLISHED recipient=f7a9bb80...:web-f7a9bb80...   (x2)
10:05:01 [SEND][send-0d4e3672] DONE queued=2 realtime=2
```

**Two recipients, both WEB. `tauri-f7a9bb80...` is not among them.** The Welcome reached FCM; the
message was never routed to the phone at all, so no push was owed and none arrived - `inMs: null`
after 90 s, and the row correctly recorded `SETUP-FAILED` rather than a product verdict. A device
added while it is dead joins through its queued Welcome on next launch and collects the message from
HISTORY, which is a different path from the one that carries an ordinary inbound message.

**WHY IT MATTERS BEYOND THE ROW.** It means the FCM cache is NOT how a first message reaches a cold
device, so the fixed `mergeFcmMessagesIntoConversations` path is not what a killed phone exercises on
first contact - the history path is. The fix is still right and still needed (it is what a LIVE app
consuming a cached push does), but the cold case has its own route and nothing has measured it.
**Also noted in the same window**: `[PUSH_SEND][welcome-send-4964245c] proto not inlined: 4608B over
a 3716B budget`, so a first-contact Welcome exceeds the FCM data budget and travels without its
payload inlined - unexamined, and the obvious next question for whoever takes this row further.

**HALF ONE IS ALREADY OPEN AND IS NOT SPECIFIC TO FIRST CONTACT.** *"Je n'arrive pas dans la
conversation"* is the P2 two entries down: the app has two notification builders, and the one the
WebSocket path uses posts `ACTION_MAIN` on the launcher, so it lands on whatever the app shows at
startup. A backgrounded-but-alive phone keeps its socket, ACKs the frame, and therefore never gets a
push - so it is the plugin builder that notified, and no tap on it can deep-link. **What first
contact adds is that the landing place is a conversation list that does not contain the
conversation**, so the same defect reads as a much worse one.

**HALF TWO IS THE NEW ONE, AND THE HYPOTHESIS IS PRECISE.** The message was decrypted, which for a
group this device has just joined means the WELCOME was processed - by the native engine, into
`mls.bin`, while the foreground was away. `reloadStateFromDisk` exists and runs on resume; its own
line says `mls.bin reloaded on resume (C2) - group CACHE refreshed`. **A refreshed MLS group cache is
not a conversation.** The conversation list is a separate store, and nothing observed so far says a
group that first appeared in `mls.bin` while the app was backgrounded gets a record in it before the
next full load. That fits the report exactly: present after a restart, absent after a resume.

**WHY THIS IS P1 AND NOT P2.** It is the first thing a new correspondent ever does, it is silent - no
error, no empty state, the conversation simply is not there - and the workaround is a restart the
user has to guess at. Everything else in the queue is about conversations that already work.

**HOW TO MEASURE IT, AND THE PRECONDITION THAT MAKES IT HONEST.** Two accounts with NO shared
conversation and no shared group; the harness's own pair have talked, so a run that reuses them
measures nothing. The sequence is: park A1 backgrounded and alive (the state that guarantees the
plugin builder, not the push one), have the peer start a NEW conversation and send one message, then
read three things separately - the shade, whether the tap lands on the conversation, and whether the
conversation exists in A1's list WITHOUT a restart. The third is the one the report is about and the
one no existing row reads.

**HALF TWO IS FIXED, AND THE CAUSE WAS ONE LINE (2026-09-08, not yet shipped).** The hypothesis
above was right in shape and wrong about which store: `consumeFcmCache` DOES handle a group joined in
the background - it writes the message AND a placeholder conversation row (`lifecycle: 'pending'`,
the sender's name as the label), and its own comment says why. What it did not do is tell the
IN-MEMORY list. `mergeFcmMessagesIntoConversations` was:

```ts
const convo = conversations.get(convoId);
if (!convo) continue;
```

So the row went to the database, the message went to the database, the log said
`[FCM_CACHE] Injection done: 1/1 message(s) injected` - and the list the UI renders, and that a deep
link resolves against, learned nothing. A restart read the placeholder back and both appeared, which
is precisely the shape of the report. **The same drop happened at LOGIN**, where the conversations
are loaded from storage a few lines BEFORE `consumeFcmCache` writes the placeholder.

The merge now creates the conversation from what the writer committed - `consumeFcmCache` returns its
placeholders so the label cannot be re-invented here, a `StoredMessage` carrying a sender id and no
name - and when it has no placeholder it WARNS instead of skipping silently, because the silence is
what hid this. **Neither file had a test**; `fcmMemoryMerge.test.ts` covers the three arrival states
and its two new cases were proven to fail against the old line.

**HALF ONE HAD TWO CANDIDATES. CANDIDATE 2 WAS THE ONE, AND THE REPORT ITSELF SAYS SO.** *"apres un
redemarrage de l'app oui a priori"* - a restart is what made the conversation appear. An app alive on
its WebSocket would have added the conversation to the map the moment the frame arrived, and no
restart would have been needed; the message reached this device through the FCM cache, which is the
killed-or-socketless path, which is the one that posts a Kotlin notification with a real deep link.
So the tap was well-formed and the LANDING discarded it. Candidate 1 below remains a genuine defect
in its own right, and is not this one.

1. The known P2 below - the WebSocket path's builder posts `ACTION_MAIN` on the launcher, so no tap
   on it can deep-link. **Read upstream on 2026-09-08, and it is worse than "no deep link": the tap
   carries no identity of any kind.** `handleNotificationActionPerformed` emits exactly
   `{inputValue, actionId, notification}`; `notification` is parsed from `sourceJson`, which
   `Notification.kt` declares and the plugin assigns NOWHERE; the notification id IS on the intent
   (`TauriNotificationManager.kt:300`) but is read only to dismiss and is never put into the payload.
   `extra` never reaches the intent at all. **So the listener in `useNotifications` cannot be
   repaired in TypeScript** - there is no field to read - and the only routes are a vendored patch to
   the plugin or the native builder this repo should have anyway. **The two builders also cannot
   replace one another**: Kotlin's `getStableNotifId` hands out a SharedPreferences counter from
   1000, TypeScript's `stableNotifId` returns a 31-hash, so when both fire the user gets two
   notifications for one message, one of which is inert.
2. **AN ORDERING - AND IT WAS THE ANSWER. FIXED 2026-09-08, NOT YET SHIPPED.** The deep link is
   resolved 174 ms BEFORE the cache is injected:

   ```
   09:33:28.647  [hooks] Processing URL: fr.emse.canari://chat/2bd5add9...
   09:33:28.821  [FCM_CACHE] Injection done: 1/1 message(s) injected
   ```

   `flushFcmCache` is the LAST step of the resume sequence, behind `reloadStateFromDisk`,
   `reconcileOutboxSent`, `drainNativePendingCallAccept` and `resumeConnection`. For a conversation
   that already exists this costs nothing and nobody would see it. **What the entry above left
   unmeasured - whether the page recovers when the conversation appears afterwards - has an answer,
   and it is no.** `notifNav` holds a target until it is DISPLAYED precisely so a late arrival can
   still be landed, and it would have worked. It never got the chance, because the landing had
   already thrown the target away:

   ```ts
   // landingRecovery, before
   return input.conversationsRestored ? 'abandon' : 'wait';
   ```

   `conversationsRestored` answers "has IndexedDB been read into the map". The landing asked it a
   DIFFERENT question - "is the set of this device's conversations complete" - and the two differ by
   exactly the FCM cache, which runs after the restore and is the only route by which a first
   message from a new correspondent becomes a conversation at all. `loadAndRestoreConversations`
   raises the flag in its own `finally`; `consumeFcmCache` is two awaits further down at login and a
   whole resume sequence away on resume; `setIsLoggedIn(true)` happened hundreds of lines earlier, so
   the landing effect is live for the whole of that window. It saw a settled map without its target,
   concluded the conversation was not on this device, logged `not on this device - abandoning`, and
   cleared it. The placeholder arrived milliseconds later to a landing that no longer existed.

   **This is [a column being read as evidence for a question it was not written to answer](durable-rules.md), and the fix is to answer the real one.** `useConversations` now counts the
   passes that can still ADD a conversation (`pendingConversationSources`), the login sequence and
   `flushFcmCache` each bracket themselves in a `finally`, and the predicate takes
   `conversationSourcesSettled` - the restore AND a quiet counter - instead of the restore alone. The
   input was RENAMED rather than merely re-pointed, so the old premise cannot be re-encoded by
   someone reading the call site. Counted rather than flagged because the same span runs at login and
   again on every resume, and because the next source must be able to declare itself without
   teaching the landing about itself.

   **Both halves of the report are now one mechanism seen from two ends**: half two was the merge
   never telling the in-memory list, half one was the landing giving up before it could be told. The
   first fix is what makes the second one reachable at all - with the placeholder still dropped,
   waiting longer would only have abandoned later.

   Four tests in `useConversations.landingSources.svelte.test.ts` assert INSIDE the window (the end
   state passes on the broken code, since the conversation does arrive in the end); two of them fail
   when the counter is removed from the predicate. `notificationRouting.test.ts` gains the
   first-contact case. **Owed: the hardware run.** A green test is not a working system, and this one
   still wants the third account the row below asks for - which EXISTS since 2026-09-10 and is
   owed enrolment rather than a decision.

**WHAT IS OWED, AND THE ACCOUNT HALF OF IT IS DONE (2026-09-10).** The row named above, run against
a genuine first contact - which needs a THIRD account, because the rig's two have a long shared
history the HEAL rows depend on and staging this by deleting it would cost more than it answers.

**THAT CONDITION IS LIFTED.** The user granted the means rather than performing the click (*"tu as
acces a miconnect pour creer autant de comptes test que necessaire"*, 2026-09-10), so `third`
(`canari-test-gamma`) and `fourth` (`canari-test-delta`) now exist as ordinary Authentik users on
the production identity provider, cloned from the owner's path, type and attributes, and are written
into the out-of-tree `test-accounts.json` with their subjects. **Their passwords were verified
against Authentik's own `check_password`, not assumed** - a created user is not a user that signs
in. No credential passed through a shell argument, a log line or a transcript: they were generated
locally, written straight to the out-of-tree file, and handed to the box on stdin.

**WHAT IS STILL OWED IS ENROLMENT, WHICH IS A DIFFERENT THING FROM AN ACCOUNT** and needs the local
estate up:

1. **A first sign-in through the app**, because a Canari user row - and therefore the DISPLAY NAME a
   member picker matches - is materialised by `findOrCreateFromOidc` and does not exist until then.
   Until it happens the rig can log the account in and cannot make anybody *find* it.
2. **A device each**, which means a Chrome profile plus `PORTS`, `ORIGIN` and `ACCOUNT_OF` entries.
   A profile IS a device here, so this is not configuration, it is enrolment.
3. **A name the rig can ask for.** `names.mjs` exposes exactly two identities - `OWNER_NAME` and
   `PEER_NAME` - and `peerNameFor(device)` is `device === 'W2' ? OWNER_NAME : PEER_NAME`, which does
   not return a wrong answer for a third identity so much as it cannot express the question. See the
   entry below.

**READ IT WITH THE RESUME RELOAD.** If half two is confirmed, it is the same seam as the receive
ratchet and the key packages: the reload installs a `mls.bin` the background engine advanced, and
what the foreground derives FROM that blob is not everything the blob now contains. Three ledgers,
one mechanism.

### P2 - the app has TWO notification builders and only one of them can be tapped (measured on device 2026-09-07)

A notification for the same inbound message is built by one of two entirely different pieces of code
depending on how the message arrived, and until 2026-09-07 nobody had noticed because the split is
invisible unless the two are compared side by side.

**WHY BOTH EXIST, WHICH IS THE PART THAT IS NOT A DEFECT.** The server pushes a message only when
the device has not ACKed it after ten seconds (`scheduleDeferredPush`). A backgrounded Android app
keeps its WebSocket, receives the frame and ACKs it, so **no push is ever sent** and
`CanariFirebaseMessagingService` never runs. The WebView is the only thing that can notify a phone
in a pocket - measured 2026-09-05, `[SEND] PUBLISHED` with no `[PUSH_DEFERRED]` after it, an empty
shade and the app holding the message. Removing the WebView notification would restore that silence.

**WHAT DIFFERS.** Measured on a Mi 9T, both directions, one message each:

| | app KILLED (push -> Kotlin) | app BACKGROUNDED (WS -> plugin) |
| --- | --- | --- |
| small icon | `ic_notification` | `ic_dialog_info`, the framework glyph - FIXED 2026-09-07 |
| channel | `canari_messages`, IMPORTANCE_HIGH, sound + vibration | `default`, IMPORTANCE_DEFAULT, silent - FIXED 2026-09-07 |
| channel for a MENTION | `canari_mentions` - its own mute switch, DND override requested | `canari_messages`: the 2026-09-07 fix taught the plugin ONE channel and it had no mentions branch at all - FIXED 2026-09-08, measured by NOTIF-16 |
| style | `MessagingStyle`, stacked and attributed | `BigTextStyle` |
| quick actions | six (`addAction`) | **none** - our `sendNotification` declares no `actionTypeId` |
| tap | `ACTION_VIEW` on `fr.emse.canari://chat/<groupId>` | `ACTION_MAIN` on the launcher, lands nowhere |

**WHICH BUILDER FIRES IS DECIDED BY THE MESSAGE'S ROUTE, NOT BY THE APP'S STATE - measured
2026-09-08, and it was not what this entry assumed.** NOTIF-14 records the builder for each half it
sends, read out of logcat rather than inferred, and one backgrounded phone produced BOTH within four
seconds:

| what was sent | notified in | built by |
| --- | --- | --- |
| a direct message | 2 223 ms | `tauri-plugin-notification` (WebSocket) |
| a salon message | 2 170 ms | `CanariFirebaseMessagingService` (push) |

Same handset, same HOME-backgrounded state, same session. **The salon push arrived in 2 170 ms, far
inside the 10 s `scheduleDeferredPush` window**, so it was not the backstop firing late - the server
pushed it immediately while the socket was demonstrably up, since the DM had just crossed it. So the
split is not "backgrounded gets the plugin, killed gets Kotlin": a device can get either at any
moment, and which one it gets is a fact about the conversation, not about the phone.

**THIS NARROWS THE USER'S 2026-09-08 REPORT.** *"Je n'arrive pas dans la conversation"* is the tap,
and only the plugin builder cannot deep-link (`ACTION_MAIN` on the launcher). A first message from a
new correspondent is a DIRECT message, and a direct message is what this measurement shows arriving
over the socket and being built by the plugin. **So the report is consistent with the plugin builder,
and the tap half of that P1 most likely IS this entry** - which is testable by reading `builtBy` on
the first-contact row rather than reasoning about it. **The third account exists since 2026-09-10**,
so what stands between this and an answer is enrolment and a run, not a credential.

**AND BOTH TITLES WERE CORRECT**, from both builders, which is worth stating because it bounds the
defect: what these two disagree about is the icon, the channel, the style and the TAP - not what is
written on the notification. A fix aimed at the text would be aimed at the wrong half.

The first two are fixed. **The last three cannot be fixed at this call site**, and the tap is the
expensive one: `tauri-plugin-notification` 2.3.3 puts the notification id on the tap intent, reads it
back in `handleNotificationActionPerformed`, uses it to dismiss the notification and then DISCARDS
it. The identity it does emit comes from `notification.sourceJson`, which its own `Notification.kt`
declares as `var sourceJson: String? = null` and assigns nowhere - so the payload's `notification` is
always `null`. Measured: the app came forward, `PANE_STATE` was `nothing`, and the listener had
thrown on `.id` of `null` inside an async callback, an unhandled rejection nothing logged. It
accuses now instead.

**THE DIRECTION, and why it is one change rather than three.** The WebView must keep the DECISION -
it is the only layer that knows the app state, the route and which conversation is open, which is
exactly what `arrivalVisibility.ts` reasons over. What it must stop doing is the RENDERING. One
native builder posts every notification, and the three remaining differences close at once: the
`MessagingStyle`, the six actions and the deep-linked tap are already written and already correct on
the Kotlin side.

**WHAT IT COSTS.** A new Tauri command - `src/commands/` has none for notifications - carrying
title, body, conversation id and kind to Kotlin, plus the Rust-to-Kotlin hop. Held for the USER's
word rather than done silently, because it deletes a call path rather than repairing one.

**AND IT CHANGES WHAT FIVE CAMPAIGN ROWS MEASURE.** The board treats "backgrounded" and "killed" as
one feature with a state variable, and they are two implementations:

- **NOTIF-6c** ("quick reply from the shade, app BACKGROUNDED") is **unsatisfiable as written** -
  there is no quick-reply button on a plugin-posted notification. Unanswered, so no false verdict
  was recorded.
- **NOTIF-7** (tap -> conversation, backgrounded) is a **FAIL**, measured by hand 2026-09-07 and
  owed a recorded run.
- **NOTIF-7c** (the same into a CHANNEL, backgrounded) inherits it.
- **NOTIF-16** (a mention lands on `canari_mentions`) would have failed in the backgrounded state
  before the channel fix, everything having gone to `default`.
- **NOTIF-11/-12** (stacking and attribution) are `MessagingStyle` questions, so they say nothing
  about the backgrounded path.

A row must state WHICH builder it is measuring, the way `notif.mjs` now states which transport
carries its notification.

### P2 - four tap rows have been unrunnable since OXYGEN, and their failure accused the product (measured 2026-09-07)

`notif7.mjs` shelled out to `python a1.py notif` to read and tap the notification shade. **`a1.py`
was never in git** - it belonged to the LITHIUM rig and was not carried into the OXYGEN
reconstitution - so NOTIF-7, -7b, -7c and -7d had been failing on a missing interpreter script, and
the sentence they produced was `no shade row contains <marker>`: a statement about the PRODUCT, for
a fault in the rig. That is the failure class this repository forbids by name.

**The seam is fixed and committed.** `phone.tapNotification` reads the shade, finds the row carrying
the marker by its `text`/`content-desc`, takes the centre from that node's OWN `bounds` and taps it -
resolved by element, on a surface no CDP can reach. It separates three outcomes where the old one
had two: `dumped: false` is an instrument fault, `found: false` is the row's real answer, `ok` is a
tap. `notif7.mjs` now records `SETUP-FAILED` on the first of those instead of throwing, so the board
says the check could not be attempted rather than saying nothing.

**AND IT STILL CANNOT TAP ON THIS HANDSET.** Both pixel-free rungs are measured dead on the Mi 9T
(Android 16, SDK 36):

- `uiautomator dump` is **SIGKILLed**: exit 137, with the shade open and shut, writing to `/sdcard`
  and to `/data/local/tmp`.
- **D-pad focus traversal never activates a shade row**: six `KEYCODE_DPAD_DOWN` then
  `KEYCODE_DPAD_CENTER` left `mCurrentFocus` on the `NotificationShade` window and the launcher in
  front. (`mCurrentFocus` names the window, not the view, so it cannot even witness focus moving
  inside the shade.)

So a tap needs **uiautomator2's instrumentation agent**, which is what `a1.py` used. On this
workstation that agent exists only inside the `android-mcp` uv tool (its own Python 3.13; the system
3.12.8 cannot install the package). The tap itself is proven to work through that route - it is how
the tap defect above was measured at all.

**WHAT IT NEEDS.** A committed driver for that agent, plus a declared dependency the rig ASSERTS at
startup the way it asserts an NDK path - the loss was never the idea, it was that the file lived
outside the tree. Until then the four rows are `SETUP-FAILED` rather than silently red, and the
product answer for NOTIF-7 (bg) is already known and recorded here: the app comes forward and
`PANE_STATE` is `nothing`.

**AND THE SAME RUNNER WAS ANSWERING UNDER NAMES NO ROW CLAIMS.** It recorded `NOTIF-7-bg` and
`NOTIF-7-killed`; the board names `NOTIF-7` and `NOTIF-7b`. So every verdict it had ever produced
landed in the ledger as an orphan, and both rows read as unanswered while their runner existed -
`bun rows.mjs` reports exactly this and nobody had run it against this phase. Fixed at the runner,
with the two historical ids attributed through the retired-id map rather than discarded. **A runner
whose id is not a board row is a runner that cannot answer anything**, and that is worth checking
for the other phases before their verdicts are believed.

### P3 - an Android phone rotates where an iPhone cannot, and nothing decided that (measured 2026-09-07)

`gen/apple/canari_iOS/Info.plist` conditions orientation exactly as one would want:
`UISupportedInterfaceOrientations` is `Portrait` alone, and `UISupportedInterfaceOrientations~ipad`
carries all four. `AndroidManifest.xml` declares **no `android:screenOrientation` at all** - only
`configChanges`, which is about surviving a rotation rather than allowing one. So an Android phone
turns landscape and an iPhone of the same size does not, and no file records that as a decision.

The user also reports an iPad "not changing the screen rotation when switching from a horizontal
app into Canari". That cannot be diagnosed here - the iPad already declares all four orientations,
so the plist is not the cause, and no iPad is attached to this workstation. It belongs with the
hardware-blocked items rather than with this one.

## CI and the chain that runs unattended

### P3 - two wire contracts are written twice, and `libs/proto` is the mechanism that already exists for exactly that (measured 2026-09-10)

Found by scanning the tree for duplicated blocks after a triplicated comment stripper produced
three CodeQL alerts. **Most of what that scan returned is DELIBERATE and is now asserted** by
`declared-duplicates.test.mjs` - four copies of the CORS allowlist and its test, four of the
NestJS framework-boot assertion, and the 636-line Minesweeper engine the server replays to decide
whether a ranked score is a cheat. Those stay duplicated for the reasons their own docblocks give.

**These two are a different shape and are NOT covered by that gate**, because the copies are not
copies - they are one contract described twice, in two languages of the same repository:

| the shared block | the two places | lines |
| --- | --- | --- |
| the published-carte stage shape | `frontend/src/lib/carte/publish.ts` + `apps/social-service/src/associations/published-carte.ts` | 44 |
| the backend-storage report shape | `frontend/src/lib/utils/backendStorage.ts` + `apps/chat-delivery-service/src/controllers/admin-storage.controller.ts` | 48 |

The rest of each file legitimately differs - one produces, one consumes - so an identity gate
would be wrong. What is duplicated is the SHAPE crossing the wire, and a shape that disagrees
across the wire is a runtime failure no compiler here can see, because the two sides are compiled
separately.

**The repository already answers this question once**: `libs/proto/canari.proto` is a wire
contract with ONE definition and generated bindings on both sides. These two predate that habit
rather than reject it.

**What it owes before anything moves:** whether a `.proto` is proportionate for a 44-line
presentational shape, or whether the honest cheaper answer is a generated type checked into both
trees. **Do NOT answer it by creating a shared TypeScript package** - that was tried
(`libs/shared-ts`), imported by nothing, and deleted on 2026-08-27; the reasoning is in any copy
of `cors-origins.ts` and it has not changed.

### P3 - the Android unit tests run now, and they tried three ways of not running (2026-09-10)

`PushDecryptLadderTest.kt` (now `frontend/src-tauri/android-tests/`) is a
JUnit suite over the order the FCM service tries its recoveries in - MLS behaviour on the platform
where MLS defects are hardest to see - and no workflow and no Makefile target invoked Gradle's unit
tests, so its assertions had never executed on any machine. **First run ever: 2026-09-10, five
tests, all passing.**

**THE REMEDY THIS ENTRY PROPOSED WOULD HAVE BEEN A SECOND INSTANCE OF THE SAME DEFECT.** It said
"`./gradlew testDebugUnitTest` is a few lines". That command **matches no task in the `app`
module**: Tauri's Android template gives it ABI product flavours, so its unit-test tasks are
`testUniversalDebugUnitTest`, `testArm64DebugUnitTest`, `testArmDebugUnitTest`,
`testX86DebugUnitTest` and `testX86_64DebugUnitTest`. Measured before the fix: `BUILD SUCCESSFUL in
16s`, **zero `:app:` tasks, zero tests**. A gate that green is exactly the "read as coverage"
failure this entry was written about, one layer up.

So `android-unit-tests.sh` does not treat the Gradle exit code as the answer. It deletes the
results directory first (a stale report is not this run's evidence), runs the flavoured task, and
then **reads the JUnit XML**: no report, or a report with no tests in it, fails and says why. Seven
assertions in `android-unit-tests.test.sh` drive it against a fake `gradlew`, because the
interesting case - green and empty - is one a real run does not produce on demand.

**WHERE IT RUNS, and the measurement decided it.** The open question was `android.yml` (a
`workflow_call` library reached only from `release.yml`, so a unit test there runs at RELEASE time,
far too late to refuse a merge) against `ci.yml` (a JDK and a Gradle cache on pull requests that
touch the native tree). Measured on 2026-09-10 with the daemon stopped, the build cache off and
`app/build` and `.gradle` deleted: **31 seconds cold, 8 seconds warm**. Well inside the "couple of
minutes" this entry set as the bar, so it is a `ci.yml` job behind a `gen/android` path filter,
inside `ci-passed`, and `android.yml` keeps building only. `make test-android` runs the same script
for a human.

**AND IT STILL COULD NOT RUN IN CI, WHICH THE VERY NEXT PULL REQUEST FOUND.** Everything above
was measured on a developer's own box. `:app` cannot be CONFIGURED anywhere else: its
`settings.gradle` applies `gen/android/tauri.settings.gradle`, which tauri generates with absolute
paths into one machine's cargo registry and `.gitignore` therefore excludes, and the module also
wants a `google-services.json` that lives in a secret. Over the fourteen CI runs after the merge
the job was SKIPPED thirteen times and FAILED the only time a change touched Android files, on
`Could not read script 'tauri.settings.gradle' as it does not exist` - blocking a pull request for
a reason with nothing to do with it. **The 31s/8s figures above are a local machine's, and the
"first run ever" was local too.**

Fixed 2026-09-10 by moving the suite OUT of the app module: it imports `org.junit` and nothing
else - no Android type, no tauri type, nothing from `:app` - so it never needed any of that. It is
now `frontend/src-tauri/android-tests`, a standalone Kotlin/JVM project with its own Gradle 9.1.0
wrapper, whose entire toolchain is a JDK. Measured after the move: **14 seconds cold, 1 second
warm**, and the script's seven self-tests still pass against it.

**AND THE FIX'S OWN FIRST CI RUN FAILED, WHICH IS A FOURTH WAY OF NOT RUNNING.** Five seconds in,
before Gradle: the relocated `gradlew` was committed `100644` beside the `gen/android` copy at
`100755`. **Windows has no executable bit, so no local run can ever produce this failure** - every
invocation here goes through `bash`, where the mode is inert - and `git status` and every editor
show nothing. The first Linux runner to reach `./gradlew` answered `Permission denied`.

Guarded now by `.github/scripts/tests/executable-bit.test.mjs`, in `make test-ci-scripts`: it
derives the set from the tree rather than a list, taking every `./x` in command position across
the Makefile, the workflows and the shell scripts, and demanding mode `100755`. Two things it
learned on the way, both written into its docblock:

- **Command position is the whole discipline.** Matching `./x` anywhere accused nineteen files,
  every one an ARGUMENT - `docker build -f ./Dockerfile.frontend`, a compose volume mount, a
  `cat ./frontend/package.json`. Making those executable would have been nonsense dressed as a fix.
- **Its first draft failed its own motivating case and reported the tree CLEAN.** It resolved
  `./gradlew` against the caller's directory, but the call is `cd "$ANDROID_DIR" && ./gradlew` - a
  variable. Chasing a working directory through variables and `cd` is writing half a shell, and a
  half-written one answers "clean" when it loses track. So it matches by NAME: if a name is run as
  a command anywhere, every tracked file with that name must be executable. That covers both
  `gradlew` wrappers from the single call site, which is what was wanted.

It immediately found three more - `infrastructure/local/{env-from-prod,pull-prod-dump,restore-into-local}.sh`,
all invoked `./x` from the Makefile, all `100644`. The Makefile had been **working around it** with
a `chmod +x` before each call, which is a fallback standing in for a fix and is why the defect
survived. Modes recorded, both `chmod` lines deleted.

**THE REAL REMAINDER, and it is bigger than it looks: THE SUITE TESTS A MIRROR.** `runLadder` in
`PushDecryptLadderTest.kt` is the service's ladder WRITTEN OUT AGAIN in the test file - the
docblock says so, because the real methods are private and JNI-bound. So it cannot fail when
`CanariFirebaseMessagingService` changes, which is the one thing a regression test is for. Making
it exercise the real code means lifting the ladder out of those private methods into a pure
function the app and the test project can share; THAT test would legitimately need the app module,
and would need this whole question answered again. Until then the green tick means "the mirror
still agrees with itself".

**AND WHAT IS STILL UNGUARDED**: every `.swift` in the iOS tree. The same trap covers it - a test
file nobody runs reads as coverage - and nothing here has measured whether an equivalent suite
even exists.

### P2 - a 7.3 TB RAID1 now has a sensor and still has no report, and nothing on that host can reach a human (measured 2026-09-03)

**`mitv`'s mirror was monitored by nothing at all until 2026-09-03** - `mdmonitor.service` had
refused to start on every boot back to at least 9 June, for want of an alert destination. It runs
now, with severity by event class, and its alarm was proved by firing a test event through the real
path. The whole account, including why `MAILADDR` would have made it worse and the stale `spares=1`
that would have cried wolf on every boot, is
[host-updates](infrastructure/host-updates.md#the-73-tb-raid1-nobody-was-watching-found-while-rebooting-for-the-kernel-2026-09-03).

**What stays open is the channel.** The events go to syslog, and syslog on that box is read by
nobody and nothing: postfix and exim4 are inactive, and `monit` runs with no `set alert` and no
`set mailserver`. So a failing disk is now RECORDED and still not REPORTED.

**What retires it:** `/proc/mdstat` read into the daily host report - a degraded array is exactly
the shape that report already handles, and it would name the array and the missing component - plus
that report reaching hosts other than production, which is the row above this one. The two close
together or not at all, and neither needs a new mechanism, only the existing one pointed at one
more fact and one more box.

### P2 - the nine NestJS pull requests were closed IN ONE BATCH, so the suppression question was never measured on one first, and Monday 2026-09-07 is the only thing that can answer it now (updated 2026-09-03)

**THIS ROW WAS WRONG UNTIL 2026-09-03 AND SAID THE OPPOSITE.** It claimed nine of the ten backend
pull-request slots were held by NestJS 12 bumps that could never go green. **They are all closed** -
`#282 #281 #280 #278 #277 #267` and the rest, every one `CLOSED merged=non` at **2026-09-03T08:14**,
the same minute, so this was a batch action. Two backend slots are occupied now, not nine, and the
queue is not the problem any more.

**WHAT THE BATCH COST IS THE MEASUREMENT, NOT THE QUEUE.** The plan written here was explicit: close
**ONE** first, because closing a Dependabot pull request tells Dependabot to stop proposing that
VERSION of that dependency, and nobody had established whether that suppression is per-package or
would also silence the `nestjs` GROUP that is supposed to replace them. Closing all nine at once
removed the control case. There is now exactly one way to find out, and it is to wait: the cargo and
bun ecosystems are on `interval: weekly, day: monday`, so **Monday 2026-09-07** is when Dependabot
next evaluates.

**THE TWO OUTCOMES, AND THEY NEED DIFFERENT FIXES:**

| What appears on 2026-09-07 | Meaning | What to do |
|---|---|---|
| ONE grouped pull request per service, `@nestjs/*` together | the group works and suppression is per-PR-version, not per-group | nothing; merge it through the ordinary gate |
| NOTHING at all | closing the singles suppressed 12.x for those packages | the requirement has to change to un-suppress it - bump the version range in each `package.json` by hand, or re-open one closed pull request |

**THE FOUR openmls PULL REQUESTS ARE THE SAME QUESTION, STILL IN ITS "BEFORE" STATE** - and that is
what makes them worth keeping open rather than tidying away. `#297 #295 #291 #290` bump
`openmls`, `openmls_traits`, `openmls_rust_crypto` and `openmls_basic_credential` from `0.8.1` to
`0.9.0` as four SINGLES, all four red, for the documented reason that none can build alone
(`there are multiple different versions of crate openmls_traits in the dependency graph`). **The
`openmls` group already exists** in `.github/dependabot.yml` with `patterns: ["openmls*"]` and all
three update-types - it simply landed AFTER these four were opened, exactly as the `nestjs` group
did, and Dependabot does not group retroactively.

So they are the control case the NestJS batch destroyed: **close ONE of the four on or after
2026-09-07, once the NestJS outcome is known**, and the pair of observations answers the suppression
question for good. Closing all four now would repeat the same mistake on the one family where
getting it wrong is an ENCRYPTION defect rather than an availability one.

### P2 - two of the six cargo directories are invisible to Dependabot, and 194 updates were waiting behind that silence (measured 2026-09-02, decided and given a trigger 2026-09-10)

**The Tauri app has had no automated dependency update since 2026-08-08, and its security alerts have
no actor at all.** Enabling `automated-security-fixes` (the row above) made Dependabot attempt the
`serde_with` bump within the minute, and the update job FAILED - which is the only reason anybody
learned this. Cargo refused the manifest before considering any version:

```
error: failed to get `tauri-plugin-customtabs` as a dependency of package `canari v0.14.15`
Caused by: failed to parse manifest at `.../plugins/tauri-plugin-customtabs/Cargo.toml`
Caused by: package specifies that it links to `tauri-plugin-customtabs`
           but does not have a custom build script
```

`build.rs` is committed and present in the working tree. **Dependabot materialises a temp checkout of
manifests and lockfiles only** - it stubs declared lib and bin targets and copies no build script -
so a `links` key is a manifest cargo will not read. The key arrived with the Android custom-tabs
plugin on 2026-08-08 (`7cf394f3`, WP-OIDC-TAB-1), and it blocks BOTH declared directories whose graph
reaches that crate: `/frontend/src-tauri` and `/frontend/src-tauri/plugins/tauri-plugin-customtabs`.

**THE POPULATION IS THE PROOF, AND IT WAS SITTING THERE FOR 25 DAYS.** `/frontend/src-tauri` has
produced exactly ONE Dependabot pull request ever - #195, 2026-07-24, two weeks before the plugin -
and the plugin directory none at all, while `/apps/chat-gateway` and `/apps/call-service`, in the
same ecosystem entry, produced eighteen across 2026-08-26 and 2026-08-31. A dependency graph that
stops moving looks exactly like one with nothing to update, which is why the absence has to be
asserted rather than noticed.

**WHAT IS ALREADY DONE: the silence is closed.**
`.github/scripts/tests/dependabot-cargo-reach.test.sh` (in `make test-ci-scripts`, six assertions)
reads the cargo directories out of `dependabot.yml`, follows every `path = ` dependency out of each
root manifest, collects the manifests declaring `links`, and compares the resulting set against a
pinned one - so a NEW blocked directory fails on the day it is committed and these two cannot be
forgotten. The derivation is proven on a fixture in the same file rather than trusted, and both
mutations were checked to fail (removing the `links` key, and pinning a directory `dependabot.yml`
no longer declares).

**THE CHOICE IS TAKEN - OPTION 3 WITH A CRON THAT OPENS AN ISSUE (user, 2026-09-10).** The three
options are kept below because two of them are refutations worth not re-litigating.

**WHAT IS STILL OWED IS THAT CRON, AND IT IS THE HALF THAT MAKES THE CHOICE REAL:** a scheduled job
running `cargo update --dry-run` in `frontend/src-tauri` and OPENING AN ISSUE when the tree is
behind. The gate that stops these two directories being forgotten already exists
(`dependabot-cargo-reach.test.sh`, above); what is missing is the thing that notices the updates
nobody can open a pull request for. **"Somebody remembers" is not a mechanism.**

1. **Remove `links` from the plugin manifest. RULED OUT 2026-09-08 - it is WRONG, not merely risky,
   and the proof is a generated file rather than an argument about cargo.** `links` is what makes
   cargo export a build script's `cargo:KEY=VALUE` metadata to dependents as `DEP_<LINKS>_KEY`, and
   this build script emits exactly the two keys `tauri-build` needs:
   `tauri_plugin::Builder::new(COMMANDS).android_path("android").ios_path("ios").build()`. Without
   `links` cargo does not propagate them at all, so `tauri-build` never learns where the plugin's
   Kotlin lives. `frontend/src-tauri/gen/android/tauri.settings.gradle` is that propagation's OUTPUT
   and says so in its first line (*"THIS IS AN AUTOGENERATED FILE"*):

   ```
   include ':tauri-plugin-customtabs'
   project(':tauri-plugin-customtabs').projectDir = new File(".../plugins/tauri-plugin-customtabs/android")
   ```

   Every one of the nine plugins listed there declares `links`, the two LOCAL ones included -
   `tauri-plugin-customtabs` and the `tauri-plugin-keystore` patch. Drop the key and that `include`
   disappears, the Kotlin never compiles into the app, and `open_custom_tab` fails at runtime on a
   phone while everything still builds green - the exact class three iOS defects already came from.
   **The same is true of the keystore patch**, so "remove `links`" is not available for either local
   plugin and this option is closed for the whole family rather than for one crate.
2. **Take the two directories out of `dependabot.yml`.** Honest bookkeeping, no risk, and it makes
   the shipped mobile artefact permanently unmanaged - the outcome the user's *"un projet qui peut
   'vivre tout seul'"* is against.
3. **Keep both declared and update those two directories deliberately**, which is the state today
   minus the silence. It needs a named trigger, because "somebody remembers" is not a mechanism: a
   scheduled job that runs `cargo update --dry-run` in `frontend/src-tauri` and opens an issue, or
   the release checklist doing it before each mobile build. A routine bump is not visible - and
   **neither is a vulnerability, which this option assumed until 2026-09-04**: see below.

**AND THE ONE THING THAT WAS SUPPOSED TO COVER THE GAP DOES NOT (measured 2026-09-04, same crate).**
Option 3 rested on "`cargo audit` already runs in CI, so a VULNERABILITY there is visible". It is
false. GitHub raised GHSA-7gcf-g7xr-8hxj against `serde_with` 3.19.0 in this very lockfile - a panic
on an empty `KeyValueMap` entry, medium - and `cargo audit`, run by hand on the unbumped tree,
**exited 0**. The advisory is GHSA-only and is not in the RustSec database `cargo audit` reads, so a
green Rust pass is not evidence about GHSA at all. The bump landed as its own commit; what stays
open is the blindness, and it is a THIRD mechanism rather than a variant of the two above:

- Dependabot cannot open the pull request (the `links` manifest, this whole entry).
- `cargo audit` cannot see the advisory (different database).
- ~~**Nothing in CI reads GitHub's own alert list**~~ - **CLOSED 2026-09-04.**
  `.github/scripts/dependabot-alerts-report.sh` runs in the nightly `Scheduled` pass, on the 02:00
  cron beside the analysis it completes, and an open alert makes the run RED. It was found in the
  first place because a `git push` happened to print a line about it.

The alert list is a property of the DEFAULT BRANCH, not of a pull request's tree, so a pull request
can neither be blamed for an open alert nor sensibly blocked by one - which is why the report is in
the nightly pass and nowhere else.

**WHAT THAT REPORT HAD TO GET RIGHT, because it is the same defect class one layer up.** An empty
alert list has four causes and only ONE of them is health: a 200 with no alerts, a 403 (the token
may not read alerts, so NOTHING looked), a 404 (the feature is DISABLED, or the slug is wrong) and
no response at all (a transport failure, which is not an answer). The last three fail the run by
name; a reporter that prints "0 open alerts" when it was refused would be exactly the mechanism this
entry accuses `cargo audit` of being. Both refusal arms were measured against the real API rather
than reasoned about, and `dependabot-alerts-report.test.sh` pins all four plus a response whose
SHAPE changed - valid JSON, right count, none of the fields this reader wants - which must accuse the
reader rather than count as zero. 19 assertions, in `make test-ci-scripts`.

**AND THE JOB HAS STILL NEVER PASSED, BECAUSE NO WORKFLOW SETTING CAN LIFT ITS 403.** `GITHUB_TOKEN`
cannot read Dependabot alerts at any permission level - there is no `permissions:` key for them at
all, and `security-events` is code scanning, a different thing. The job already reads a secret when
one exists (`.github/workflows/scheduled.yml:183`,
`GH_TOKEN: secrets.DEPENDABOT_ALERTS_TOKEN || secrets.GITHUB_TOKEN`) and fails loudly when it does
not, deliberately, per the paragraph above. **Only the user can mint it**, and they asked on
2026-09-10 for the steps rather than the description:

1. GitHub -> Settings -> Developer settings -> Personal access tokens -> **Fine-grained tokens** ->
   Generate new token.
2. Resource owner **`emse-students`**, repository access **only `emse-students/canari`**.
3. Repository permissions: **`Dependabot alerts: Read-only`**, and nothing else.
4. Any expiry is acceptable - note that the job starts failing loudly on the day it lapses, which is
   the correct behaviour and not a regression.
5. Repo -> Settings -> Secrets and variables -> Actions -> New repository secret, named exactly
   **`DEPENDABOT_ALERTS_TOKEN`**.

Nothing is deployed or merged afterwards; the next nightly run picks it up.

**Adding it made `scheduled.test.sh` fail, and the test was wrong.** Two jobs on one cron is legal,
and that test says so in its own note - while comparing declared against claimed with `comm` over
NON-deduped lists, so the second claim on 02:00 came back as a cron no schedule declares. It failed
and passed the "legal, check it is deliberate" note in the same run. Deduped now, with both
directions of the real assertion re-validated by planting an undeclared cron.

**Measured the day it was written**: 0 open alerts, 2 dismissed, 98 fixed - including
GHSA-7gcf-g7xr-8hxj itself, now `fixed`, in `frontend/src-tauri/Cargo.lock`.

**THE TRIGGER EXISTS SINCE 2026-09-10, and the first thing it measured is the size of the hole:
194 pending updates** - 193 in `/frontend/src-tauri`, one in the plugin - which is what 33 days of a
silence nobody could see was worth.

`.github/scripts/cargo-blocked-update-report.sh` runs in the weekly `Scheduled` pass, on the Monday
cron beside `dev-refresh` rather than taking a sixth schedule line. It derives the blocked
directories from `lib/cargo-dirs.sh` - **the same derivation `dependabot-cargo-reach.test.sh`
refuses a new one with, moved into a library rather than written twice**, because a reporter that
derived the set its own way would eventually report on a directory the test does not guard and
nothing would say so.

**THE REPORT IS AN ISSUE AND THE RUN STAYS GREEN, which is a deliberate departure from its two
neighbours.** An open security alert is an anomaly, so `alerts` goes red for one. A Rust tree being
a patch behind is its normal state: a red run for that would be red every week, and *a line its
reader learns to skip is the one that hides the next defect*. So the split is by meaning - **the
issue says there is work, a red run says the reporter is broken.** The issue is found by an exact
title and UPDATED rather than duplicated, and CLOSED with a comment once the directories are level,
because an issue nobody closes is the queue nobody drains this repository refuses everywhere else.

**WHAT MUST NOT LOOK LIKE HEALTH, and all four fail loudly**: a refused issue list (which would
otherwise read as "no issue open" and file a second one every week), a failing `cargo` (which would
read as "nothing to update" - the exact charge this entry lays against `cargo audit`), a creation
that did not land while updates are pending, and a derivation that found no directory at all (a
broken parse reads exactly like a repo where the blockage was fixed). Ten assertions in
`cargo-blocked-update-report.test.sh` drive them against a fake tree, a fake `cargo` and a fake
`gh`, and it also pins that the directories Dependabot CAN reach are left alone - a pull request and
an issue on the same bump would be two actors on one job.

**WHAT IS STILL OPEN IS THE 194 UPDATES THEMSELVES.** They are not taken here: a cargo bump in this
tree moves two committed lockfiles a mobile build reads, so it wants CI's Android artefact and
belongs in its own pull request. Upstream, this is dependabot-core's cargo updater not copying build
scripts; nothing here can fix that.

### P2 - a dev deploy still cannot tell a broken CHANGE from an unreachable REGISTRY, and the conflation MOVED rather than went away (measured 2026-09-02, first day it ran)

**The original measurement.** `deploy-to-server` used to need `deploy-dev` to be `success` or
`skipped`, and the hazard written into the comment above that clause the day it was added - *"a dev
estate broken for a reason of its own would hold production's releases hostage"* - materialised
within hours. Run `33633156004` (workflow_dispatch, 13:00, 17m38s): everything built, every image
pushed, and `Deploy to dev.canari-emse.fr` failed in 16 s on

```
Image ghcr.io/emse-students/***/frontend:dev Error failed to resolve reference ...
  net/http: TLS handshake timeout
```

A TLS handshake to ghcr.io. Production was not deployed because the other estate could not reach a
registry - nothing about the change, nothing about the data, nothing a second environment exists to
catch.

**WHAT THE WORKFLOW MIGRATION CHANGED, AND WHAT IT DID NOT (2026-09-03).** `deploy-to-server` no
longer names `deploy-dev` in its `needs:` at all, and this time that is not a re-routing: **a run
deploys exactly one estate.** A pre-release runs `deploy-dev` and stops; a stable runs
`deploy-to-server` and never touches dev. So a registry timeout on the dev deploy can no longer
block, delay or silently cancel anything production-bound, which is the whole of what the branch
split had merely MOVED.

**The conflation itself survives, one estate smaller.** A `deploy-dev` that fails on a TLS handshake
to ghcr.io still reports the same red run as a `deploy-dev` that fails because the change is broken,
and the cost is now precise: **the dev estate silently did not receive that pre-release**, so the
next alpha tester is measuring the previous build and nothing says so. That is smaller than "a
release that did not happen" and it is the same defect.

**Owed, unchanged in substance:** the dev deploy separates the failures it OWNS (a migration refused,
a container that will not start, `/api/version` unanswered) from the ones it merely observed (a
registry timeout, an SSH drop), and only the first stops the promotion; an observed failure is
re-attempted rather than reported. A retry on the pull is not the fix - it narrows the window and
leaves the conflation - though the pull should retry too.

**And the second half, which the split made newly visible:** nothing reports *"`dev` is green and
`main` was not advanced"*. That is the same shape as the P2 below - a correct mechanism with no
report is found by hand, a day late - and the probe owed there (`/api/version`, hitting the database)
is the same probe. They want doing together. Until then the escape is still one visible variable:
`gh variable set DEV_ENVIRONMENT_ENABLED --body false`, which skips the dev arm and sends releases
by the emergency path, a push straight to `main`.

---

### P1 - production goes dark in the 22h band, and the only thing both boxes share is the School's firewall (measured 2026-09-11)

**Reported by the user, again** (*"il ne faut surtout pas que la prod soit down"*, then *"Il y a des
gens qui utilisent la prod"*, then *"Pas que canari, cercle surtout"*) - which is the third time an
outage has been raised by a human rather than by anything here, and the reason the entry below it
is now the more urgent of the two.

**The measurement, the drop pattern and the shared uplink are on
[cloudflare-edge](infrastructure/cloudflare-edge.md#the-tunnel-drops-in-the-22h-band-and-nothing-on-this-page-can-fix-it),
the only copy.** In one line: every hostname on two different zones, on two different machines,
returned 1033 for six minutes; nothing on either origin moved; 175 `cloudflared` edge-dial timeouts
in seven days, ALL in hours 22 and 23 CEST; and the single element both egress paths cross is
`fw-ste.emse.fr`, the School's Stormshield border firewall.

**WHAT IS NOT YET KNOWN is the only thing that decides who to talk to**, and two TCP witnesses were
installed at 22:48 CEST on 2026-09-11 to answer it. They sample every 10 seconds and **stop
themselves after 24 hours** (8640 samples), so the window they actually cover is the evening of
2026-09-12:

| Host | Ledger | pid | Its LAN peer |
| --- | --- | --- | --- |
| canari `10.0.0.3` | `/home/canari/netwatch/samples.ndjson` | 3425696 | mitv `.4` |
| mitv `10.0.0.4` | `/root/netwatch/samples.ndjson` | 2615688 | canari `.3` |

Each sample is one NDJSON line probing four TCP targets - `gw` `10.0.0.1:443`, `lan` the sibling's
`:22`, `cf` `1.1.1.1:443`, `goog` `8.8.8.8:443` - with per-target milliseconds. ICMP was not an
option: the shell has no `cap_net_raw`, so reachability is a `/dev/tcp` connect. The script is
`netwatch.sh` beside each ledger, its pid in `netwatch.pid`, and it is killed with
`kill $(cat .../netwatch.pid)`.

**The reading, decided before the data exists so the data cannot be read to taste:**

| `gw` | `lan` | `cf`/`goog` | What it means |
| --- | --- | --- | --- |
| 1 | 1 | 0 | the firewall is UP and lost its route out - a **segment** event, and the question goes to the School's network service |
| 0 | 1 | 0 | the firewall is rebooting or failing over while the LAN holds - a **device** event |
| 0 | 0 | 0 | the LAN itself drops - switch or power |
| 1 | 1 | 1 | all four TCP witnesses stay green while `cloudflared` still falls over - then the cut is specific to **UDP/QUIC**, which is a result and not a failed measurement |

**TWO HYPOTHESES ARE REFUTED AND MUST NOT BE RE-OPENED.** A Proxmox `vzdump` freezing the container
was inferred from five missing minutes in `egress-probe`'s per-minute ledger, and it is wrong twice
over: `mitv` is bare metal on other hardware and was hit identically, and BOTH journals carried
entries for every minute of the window, so neither box was frozen. The ledger gap is the probe's own
`AbortSignal.timeout` blocking the sampler - **a gap in a ledger is evidence about its WRITER before
it is evidence about the world** ([durable-rules](durable-rules.md)). And "the whole campus loses
the network every evening" is not what the finding says: the certificate proves the firewall is
School-managed, not that `10.0.0.0/16` is anything wider than the hosting segment, and there were
zero events on 09-05, 09-06 and 09-07.

**What is owed, in order.** Read both ledgers after the next 22h window and classify with the table
above; that verdict, plus the seven-day histogram, is what the School's network service needs to be
asked *what is scheduled on `fw-ste.emse.fr` between 22h and 23h*. Nothing here can shorten the
outage: `cloudflared` already survives the cut and re-dials on its own, which is why the six minutes
are the firewall's and not ours.

### P2 - NOTHING TELLS ANYBODY PRODUCTION IS DOWN, and both outages of 2026-09-01 were reported by the user (owed to the USER: a decision, then one click)

**This is the largest thing the postgres outage exposed, and it is not a code defect.** Production
lost every backend service twice on 2026-09-01, for 33 minutes and then again after a manual deploy,
and on both occasions the thing that raised the alarm was **the user noticing**. Nothing in this
repository or on the box would have said so.

**What DID report, and why it was not enough.** The CD run went red both times, on `Run database
migrations` - so the mechanism worked and the signal existed. Nobody is paged for a red run, and a
GitHub notification in a mailbox is not a page. Worse, the frontend kept answering **200** throughout:
`frontendDist` is embedded and nginx serves it without touching a service, so every external check
that reads the homepage saw a healthy site while `auth_db` was unreachable. **A liveness probe must
hit something that needs the database** - `/api/version` and `/api/chat-delivery-health` both do, and
both returned 502 the whole time.

**WHAT IS OWED IS ONE CLICK, AND THE CHANNEL IS MAIL** (decided 2026-09-06). Not a tool: building a
poller in this repository would be exactly the waste that `CLAUDE.md`'s one-off-actions rule names.
The user asked on 2026-09-10 for the steps to be written out rather than described, so:

| URL to probe | What its failure means |
| --- | --- |
| `https://canari-emse.fr/api/version` | the API is not answering, or answers as the wrong version |
| `https://canari-emse.fr/api/chat-delivery-health` | the API is up but message delivery is not |

Any external service does this. The requirements are only that it runs **from outside the box** (a
probe on the host cannot see the host being unreachable), at an interval of 5 minutes or less, and
that it alerts by mail. Cloudflare's own Health Checks reach the same two paths when a notification
destination is set on the account. **Two settings to get right**: the check must assert the STATUS
of the named path rather than follow redirects and report the final 200, and it should require two
consecutive failures, so a nightly deploy does not page.

**MAIL WAS REFUSED ONCE, ON `mitv`, and this is not a reversal.** There, `MAILADDR` would have
delivered into a spool nobody opens, on a host with postfix and exim4 both inactive and `monit`
holding no destination - *a check that cannot reach its reader reports health*. An uptime service is
a different sender entirely: a real MTA, a mailbox the user reads, and above all **not on the box
that is down**, which is the requirement no probe hosted on `canari` or `mitv` could ever meet.

**One thing that would be code, and is worth doing whichever way the above goes:** CD's health checks
(`Health Check`, `Wait for services to be healthy`) run AFTER the migration step, so a deploy that
fails on migrations never reaches them and reports only "migrations failed" - true, and silent about
the estate being down. Reaching them on the failure path, or asserting the datastores before
migrations, would make the run say what actually happened.

### P2 - PostgreSQL 15 -> 18: AUTHORIZED ON PRODUCTION (2026-09-10), and what it owes before the cutover

**The park is over.** It was a deferral the user chose (2026-09-01: *"remettre 18 est pas si genant
si on fait la migration, mais on verra ca plus tard"*), and on 2026-09-10 they reversed it and
authorized the whole thing, production included. **That authorization is recorded HERE because
nothing else in this repository would carry it**, and the standing rule is that production is
read-only except where the user says otherwise.

**THE ORDER IS NOT NEGOTIABLE, and each step exists because the previous one can fail silently:**

1. A verified `pg_dump` off production - **through Bash, never PowerShell**, which text-encodes
   stdout and destroys a binary pipe, losing a `pg_dump | gzip` in transit
   ([databases](infrastructure/databases.md#reaching-it-from-a-workstation)). `auth_db` is the ONLY
   database.
2. That dump RESTORED on the local estate, proving the dump is readable and not merely written.
3. The upgrade exercised locally end to end, against a data directory written by 15.
4. Only then the production cutover, with the rollback written down BEFORE it starts.

**The reason for the pin was a missing PROCEDURE**, which is what the rest of this entry supplies,
and it is also why a later session must not read `postgres:15-alpine` as neglect and bump the tag.

**What happened, in one line:** the auto-merge shipped `15-alpine -> 18-alpine`, the deploy recreated
the container, PostgreSQL 18 exited on startup against the existing `postgres_data`, and all eight
backend services lost `auth_db` - the only database - for 33 minutes. The full account is in
`CHANGELOG.md`; the rule it left is in
[durable-rules](durable-rules.md#release-and-ci---cicd). The image is refused by name in
`.github/scripts/lib/ceiling.sh` now, so Dependabot's next attempt is declined with its reason
rather than merged.

**Why it is not a one-line bump.** PostgreSQL 18 refuses the data directory for TWO independent
reasons, and a procedure has to answer both:

1. **The catalogue.** A 15 cluster is not readable by 18 - `pg_upgrade` needs BOTH binaries present
   at once, which no single official image carries. Either a `tianon/postgres-upgrade`-style
   throwaway container, or a `pg_dumpall` / restore, which is the simple option and the one with
   downtime proportional to the database.
2. **The mount moved.** The 18+ images expect a single mount at `/var/lib/postgresql` and place the
   cluster in a major-version subdirectory beneath it; this repository mounts `postgres_data` at
   `/var/lib/postgresql/data`. So `docker-compose.prod.yml`, `docker-compose.dev.yml` and
   `infrastructure/local/docker-compose.yml` all change shape, not just a tag - and the `pg_isready`
   / `psql` invocations in `serve-prod.yml`'s migration step run inside that container.

**What retires this entry, and it is the same thing that lifts the refusal:** a test that starts the
NEW major against a data directory written by the OLD one and proves the upgrade path carries it.
That is the gate `lib/ceiling.sh` names, and writing it makes a whole class of datastore update
merge by itself - the same shape as `boot-nest-apps` releasing 22 refusals on 2026-08-31. It also
covers `redis` and `garage`, which sit behind the same arm for the same reason and have never been
upgraded across a major either.

**MEASURED 2026-09-01: `auth_db` is 84 MB.** That settles the choice - a dump and restore of 84 MB
is seconds, not an evening, so `pg_upgrade` and its requirement that both binaries live in one image
buy nothing here and should not be built. The remaining halves of this item are unchanged: 18 also
moved the expected mount from `/var/lib/postgresql/data` to `/var/lib/postgresql` with a
major-version subdirectory, so the compose changes with the image, and the ceiling arm in
`.github/scripts/lib/ceiling.sh` is what holds the bump back until both are done. Re-measure the size
before the window rather than quoting this line - it is a number that only grows.

### P3 - one merge out of three did NOT delete its remote branch, and nothing here refused it (observed 2026-09-03)

**One occurrence, recorded because it is a measurement and not a theory.** The repository has
`delete_branch_on_merge: true` (inventoried in
[MIGRATION.md](../../infrastructure/MIGRATION.md) section 3bis), and on 2026-09-03 three pull
requests merged within twenty minutes of one another, all squash-merged by the same App through
GitHub's auto-merge:

| Pull request | Branch after the merge |
| --- | --- |
| #339 | deleted (404) |
| #340 | deleted (404) |
| #341 | **still present**, twelve minutes later |

`DELETE /git/refs/heads/...` then removed it with **no error and no refusal**, so nothing in this
repository was protecting it - no ruleset, no protection rule, no open pull request pointing at it.
Whatever happened, happened on GitHub's side, and the cause is UNMEASURED.

**Why it is worth a row rather than a shrug:** the remote branch is what tells a workstation its
local branch is finished. `[origin/x: gone]` after a fetch is the signal a session uses to delete
its local copies, and a branch that is never marked gone accumulates silently in every clone - the
exact confusion that had to be explained on 2026-09-03
([workflow-developpement](../user-guide/workflow-developpement.md) section 3.1).

**What retires this row:** either it never recurs - in which case delete the row after a month of
merges - or it recurs and the pattern says what it depends on. Do not write a workaround for one
observation: a sweep that deletes leftover branches would be a destructive control built on an
unmeasured cause, and it would need an allowlist of what it may touch.

### P3 - TWO audit advisories are suppressed because they cannot be reached, and both should stop being

`GHSA-vcc3-ghjq-m6fr` (moderate, denial of service) covers every `decode-uri-component` at or below
0.4.2 and reaches media-service as `minio > query-string > decode-uri-component`. **It is ignored
for that one service only**, because nothing in the chain can move - minio 8.0.7 is the latest
release and pins `query-string: ^7.1.3`, which pins `decode-uri-component: ^0.2.2` - and because the
fixed 0.5.0 is ESM-only where `query-string@7` is CommonJS, so an override would fail at boot
instead of at audit. The reachability argument and the assertion that keeps it honest are in
`.github/workflows/code-analysis.yml`, which is the only copy.

**What retires this row:** minio publishing a release that drops `query-string@7` - or
`query-string` itself depending on a `decode-uri-component` above 0.4.2. Either makes the ignore
unnecessary, and it should be deleted the same day, along with the premise assertion beside it.
Until then the assertion is what stops the suppression outliving its reason: CI fails if minio ever
parses a query string, or if the `stringify` call site the measurement was taken on disappears.

---

### P2 - THREE hosts take security updates that nothing reports on, and a library nothing restarts (the rest closed 2026-09-03)

**The mechanism and the report both exist since 2026-09-03**, installed on the user's decision
(*"unattended-upgrades securite + rapport"*) across all four hosts: security origins only, nothing
reboots, and `.github/workflows/scheduled.yml` fails a daily run on any finding. The whole
write-up - the policy, the `#clear` that the file needs to not be decorative, the 30-second `502`
this scope does NOT incur and the evidence for that, and the two defects the report itself had - is
[host-updates](infrastructure/host-updates.md), the only copy.

**THREE THINGS STAY OPEN and they are smaller than what closed.**

1. **The report covers PRODUCTION and no other host.** It has to be taken on the box, the runner
   lives on the production origin, and the runner's key is authorised on none of the other three
   (measured 2026-09-03). So `mitv`, `cercle` and `miconnect` now apply their security updates with
   nothing saying whether they still are - which is exactly the shape this row was opened about, one
   estate smaller. **Retired by** either a key for the runner on the other three (a privilege
   expansion, so the user's decision), or the Cloudflare Access service token already listed as
   optional in the dev-environment work, which would let an `ubuntu-latest` job reach all four the
   way a workstation does.
2. **`mitv` has needed a REBOOT since 12 July**, for `linux-image-6.12.95+deb12-amd64`, with 8 weeks
   of uptime. The report names it now; only a human reboots it. A kernel security update that is
   installed and not running is a security update you do not have.
3. **A library security fix is installed, not in effect.** `unattended-upgrades` restarts no
   services, so an `openssl`/`libssl3t64` upgrade leaves every long-running process mapped to the
   old library until something restarts it. Nothing measures that. **Retired by** reading
   `needrestart -b` (or `/usr/lib/needrestart/`) into the same report - which turns a silent gap
   into a named finding without deciding to restart anything.

## Security - blocked upstream

### P3 - the two libcrux crates that ARE compiled are pinned by `openmls_rust_crypto 0.5.1`

`libcrux-sha3` and `libcrux-secrets` reach this build through `hpke-rs`, and their advisories are
the ones that survive. Both are pinned by `openmls_rust_crypto 0.5.1`, and a `0.0.x` requirement is
exact in Cargo semver - only a stable `openmls_rust_crypto 0.6.0` moves them. Each case is an entry
in the crate's `.cargo/audit.toml` naming why it cannot be honoured and what lifts it, so
`cargo audit` is green with none of them forgotten. A scheduled dependency upgrade, not a live
defect.

The rule the `libcrux-chacha20poly1305` measurement left - **a lockfile entry is not a
dependency**, because `cargo audit` reads the lockfile while `cargo tree -i` reads what is actually
compiled - is in [durable-rules](durable-rules.md). That alert is dismissed (user, 2026-08-31) and
no Dependabot alert is open.

### P2 - no iOS build reaches a test device without shipping a pre-release, and the one artifact that exists refuses to install (measured 2026-09-07)

**The `ios-release` artifact cannot be installed on any iPhone.** `.github/workflows/ios.yml` writes
one `ExportOptions.plist`, `method: app-store-connect`, `signingCertificate: Apple Distribution`,
resolving the two named distribution profiles. That signing carries no device UDID and no
`get-task-allow`, so `installd` refuses the `.ipa` - App Store Connect is the only endpoint that
accepts it. [device-verification](device-verification.md) told a reader to install that artifact
until this was measured; the instruction was impossible on the day it was written.

**So an iOS pass costs a PRE-RELEASE.** A `workflow_dispatch` uploads nothing, which is deliberate,
but it means a dispatch puts an iOS build on no hardware at all. Android has no equivalent problem:
`tools/cross-client-harness/a1apk.mjs` builds a debug APK against the LOCAL estate and `adb install
-r` puts it on the phone in one gesture.

**The second consequence is the one that blocks the campaign, not the pass.** Without
`get-task-allow` the WKWebView is not inspectable, so `ios-webkit-debug-proxy` has nothing to attach
to and no iOS row can read the webview the way `cdp.mjs` reads a browser. The app's console does
survive - `+layout.svelte` calls `attachConsole()` gated on `isTauriRuntime()` rather than on
Android, so webview logs reach `tauri-plugin-log` and the device syslog - but reading logs is not
driving a client.

**What closes it: a second export from the SAME archive**, `method: development`, against a profile
naming the test device's UDID, published as its own artifact. It is one job step and two one-off
gestures owed to the USER - register the device UDID in the Apple Developer portal, and store the
resulting development profile as a repository secret beside the two distribution ones. The same
profile is what would let WebDriverAgent be signed for UI automation, so one gesture unlocks both.

**The rule this leaves:** *an artifact that cannot be installed is not a delivery path.* A build
step that produces a file nobody can run has not delivered anything, and a green job is what hides
it.

### The rest of what an iPhone will find, named by the user before it was looked for (2026-08-27)

**Not a defect and not scheduled - a standing expectation, recorded so it is not re-discovered as a
surprise.** Said while the first iPhone was still in front of a log, verbatim: *"Il y aura d'autres
problemes graphiques et peut-etre memoire aussi, sur le fait de mal gerer la mise en arriere plan par
exemple, la reconnexion qui ne se fait pas etc."*

**Why it deserves a line rather than a WP.** Every iOS defect found so far - the CORS allowlist, the
third-party refresh cookie, the FCM ordering - was invisible to every gate in this repository and
became visible the moment a device ran the app. Three of three. The classes the user names are the
ones the platform's own lifecycle owns and the ones a compile can least speak to: suspension and
resume, the WebView being evicted under memory pressure, and a socket that does not come back. Two
mechanisms already exist and neither has been observed on iOS - the reconnection ladder
([auth](frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it))
and `didBecomeActive`, which the FCM fix has just made load-bearing.

**How it gets closed: by hardware, one check at a time.** Each class becomes a lettered check in
[device-verification](device-verification.md) when someone has an iPhone in hand, not a speculative
entry here. **What must NOT happen is a fix written against a suspected iOS lifecycle bug that nobody
has seen** - the repo has no way to tell whether it worked.

### P3 - a media object that is gone reads as a hard error unless one JSON file survived, and that file is known to be losable (found 2026-09-05)

`MediaService.download` answers `purged` - which the controller turns into a 410 and the client into
a calm *"media expired"* label - only when `media_metadata.json` still holds an entry with
`purgedAt` and `purgeReason === 'retention_expired'`. If the object is gone and that entry is not,
the answer is a 404, and `PostMedia` renders the red failure and writes `console.error`. The two are
the same event to the user.

**The metadata file is known to be losable, in this very service**: `downloadPublic` carries an
explicit *"metadata lost after a container restart"* fallback that backfills an entry from storage.
`download` has no equivalent, so the private path depends on a file the public path is written not
to trust.

**What is NOT known** is how often a 404 on this endpoint means "purged" rather than "never existed
here" - that is a measurement on production's media service, not a reading. **A predicate that named
the last incident is not the predicate that names the next one**, and this one has not been measured
on the population it would run on. Cheap and worth doing before deciding anything: count 404s and
410s on `/api/media/:id` over a week.

### P2 - a device reconciles history for a group it has not joined yet, and learns by 403 what its own store already knew (measured on DEL-1, 2026-09-05)

**The line.** `[HISTORY_STATE] Send failed for b0b436ed...: SenderNotActiveError: This device holds
no leaf in group b0b436ed... (membership pending)`, on W2, seconds after W1 added it to a group and
before its Welcome had been processed.

**Nothing is lost, and that is why this is a P2 and not a P1.** `sendHistoryStateKey` returns
`false`, and its contract says what that means - *"the caller treats that as 'this group was not
reconciled', never as 'we agree'"* - so the sweep simply has not happened yet and happens later. The
server is also right to refuse: a device with no leaf encrypts frames no member can open, which is
the defect `SenderNotActiveError` was typed for after production turned six messages into thirty
unopenable rows on 2026-09-02.

**What is wrong is the ASKING.** The reconciliation sweep audits every group the device has a row
for, including one it has been given a roster seat in and has not yet joined - and the only thing
that tells it so is a round trip that ends in 403. That is
[durable-rules](durable-rules.md)' *"never learn by failing what a fact could have told you"*: whether
this device holds a leaf in a group is answerable from the local MLS store, at the point the sweep
picks its candidates, with no network at all. Carrying that discriminator into the sweep's predicate
removes a frame, a refusal, and a line that reads like a delivery defect to anybody who meets it.

**Where.** The candidate set is chosen by the `[HISTORY_RECONCILE]` sweep (`auditing N group(s) that
never have been`); the refusal is thrown in `mlsDeliveryApi.ts` and reported by
`sendHistoryStateKey` in `groupActions.ts`. The row that produced it keeps it ACCUSING on purpose -
`del1.mjs` forgives its own group creation and its own cut, and deliberately not this.

### P3 - `[BUFFER] welcome_request sent for unknown group` announces a send that has not happened and may not happen (found 2026-09-05, DEL-6)

`handleUnknownGroup` logs that line immediately after calling `startRecovery`, which is `void`-ed
on purpose - an await there stalls the whole inbound drain. So the sentence is written before
`requestReAdd` has looked at anything, and that seam has several early returns: a throttle inside
`RECOVERY_TIMEOUT_MS`, a group already held locally, a tombstone, a membership still `pending`.
In each the line claims a `welcome_request` that never went out.

**The case that mattered is FIXED and this is the residue.** A frame for a conversation at
`lifecycle: 'removed'` is now acknowledged and dropped before any of this runs, which is where the
real cost was - a queue row nothing would ever take out. What is left is wording.

**It is not changed inline because the sentence has three consumers**, and one of them is a
predicate of a rung that has not run yet in this campaign: `heal-w2.mjs` requires the line to have
fired, `classify-selftest.mjs` pins its bucket, and `chat-delivery.md` quotes it. Renaming it to
what it can honestly claim - a recovery STARTED - moves the instrument and the subject in the same
commit, before HEAL has produced a single verdict. It belongs in the same pass as the HEAL rung.
### P3 - a device with no key package is refused with 400, and the endpoint's own docblock says 404 (found on HEAL-NEW-12's dirt, 2026-09-07)

`GET /api/mls/devices/:userId/:deviceId/key-package` documents itself as "only revoked / missing
devices 404" and then throws `BadRequestException` when `resolveKeyPackagePayloadForDevice` returns
nothing (`devices.controller.ts`). A 400 accuses the CALLER of sending something malformed; the
request was well formed and the answer is that the row is not there.

**The code carries meaning in this file and that is why the mismatch matters.** Sixty lines above,
the device-cap refusal is deliberately a 400 with `code: DEVICE_LIMIT_REACHED`, and its comment
states the contract: *"a 400 here is TERMINAL (the account must lose a device first) while other
400s and every 5xx are retryable, and a client must not tell those apart by reading prose"*. A bare
400 for "no key package" sits on the retryable side of a line drawn by code alone.

**It is not what makes HEAL-NEW-12 dirty, and swapping the status would not clean it.** The client
returns `null` on any `!res.ok` (`mlsDeliveryApi.fetchDeviceKeyPackage`), so 400 and 404 are the
same to it; the repeated GETs in that row's `badHttp` are a pending invitation naming a device that
can never be served, which is the P1 above about a device asking for a Welcome for ever. This entry
is the honesty of the answer, not the loop.

### P2 - an inviter that dies between sending a Welcome and registering the joiner leaves a member in the MLS tree with no server-side membership, and nothing repairs it (measured 2026-09-05)

`groupCreation.ts` delivers Welcomes and THEN calls `registerMember` for each user whose Welcome was
delivered. Between those two the joiner is cryptographically in the group and unknown to the
delivery service, so nothing routes to it.

A line in `setupMessageHandler.ts` claimed to cover this - the joiner registering ITSELF, described
as a "safety net ... if the inviter has not yet called registerMember" - and it could not: the
server's `assertCallerMayMutateMembership` refuses a caller who is not already a member, exempting
only the creator of an empty group. It has been deleted (see `CHANGELOG.md`), which removes a 403
on every join and changes nothing about the exposure.

**What would actually close it** is registering before delivering rather than after, so the server
knows the member before the Welcome can arrive - which is the order the delivery service's own
docblock already assumes ("Freshly-invited joiners are registered as members BEFORE their Welcome").
The reason it is not that way is visible in the code: only users whose Welcome was DELIVERED get
registered, so inverting the order also changes which users end up registered when a delivery fails.
That is a real design decision and wants measuring, not guessing.

### P3 - the @mention dropdown offers you yourself, and mentioning yourself can do nothing at all (measured 2026-09-05)

Typing `@` in a channel composer lists the signed-in user among the suggestions. Picking it inserts
a chip and puts your own id in `mentionedUserIds`, and then nothing happens - `notifyChannelRecipients`
skips `member.userId === input.senderId` before it looks at any notification level, so a self-mention
cannot produce a notification for anybody, including you. It is a control whose only possible effect
is on the message text.

**It was measured because it broke an instrument, not a user.** `mentionInComposer` clicked the top
suggestion; from W2 the top row for the owner's first word was W2 ITSELF, so MENTION-2 mentioned the
sender, the server correctly pushed to nobody, and the row recorded `FAIL` against a notification
level that worked. That half is fixed on the rig's side (the row is addressed by id or by whole
display name, and an ambiguous list is a refusal). What is left is the product question.

`UserAutocomplete` already takes `excludeIds`, and the composer already knows who is signed in, so
excluding self is one argument. **Whether it SHOULD be excluded is a judgement, not a bug** - some
chat apps allow a self-mention as a way to bookmark a message - which is why this is a P3 and not a
fix applied inline: it is the user's call.

### P3 - the gateway logs a client that merely went away at ERROR, and a clean goodbye at INFO, so the level says nothing about whether anything is wrong (measured 2026-09-04)

`handlers.rs:529` ends the receive loop with two arms and one of them is unconditional:
`Ok(Message::Close(c))` logs `info!("Client closed connection")`, and `Err(e)` logs
`error!("WebSocket Error from {user_id}: {e}")` whatever `e` is. **A browser that reloads,
navigates away or is killed sends no close frame** - the socket resets - so the ordinary end of a
web session is recorded at the same level as a genuine protocol fault.

**Measured, and the cause is visible in the timestamps.** Three ERROR lines at `16:19:49.602`,
`.603490` and `.603505` - three sockets dying inside a millisecond of each other, which is
`make local-frontend` recreating the nginx container in front of them, not three clients
misbehaving. The one `Client closed connection` line in the same window carries `code: 1001`
("going away"), the polite version of the same event.

**The fix is a classification, not a demotion**, which is the distinction
[durable-rules](durable-rules.md) draws when it says never to demote a line: `axum` 0.8 surfaces the
tungstenite error, so `ProtocolError::ResetWithoutClosingHandshake` is a TYPE and reading it is
reading a discriminator rather than prose. A reset with no handshake from a web client is the
expected end of a connection and belongs at `info!`/`debug!` beside the clean close; everything else
stays `error!` and finally means something when it appears.

**The rate here is NOT the rate that matters and must be measured before the name is believed.**
This estate is idle apart from one operator, so three lines is all it produced; on production the
line fires once per client that ever closes a tab without a handshake, and nobody has counted that.
Measure it on the production gateway first - if it is the dominant ERROR line there, that alone is
the argument.

### P3 - the dirt classifier fails a row on the OIDC callback that row performs on purpose (2026-08-28)

**Measured.** `healnew.mjs --row 0` recorded `FAIL` on `03d015fd` with **no unmet condition and no
unobservable** - dirt only. Its seven `unexplained` lines: six ordinary `debug: [auth] core-service
response status: 200` / `got access_token` / `handleOidcCallback complete` / `[callback] goto -> /`
lines, and Chrome's accessibility hint that a password form wants a username field. The primitive
succeeded; the classifier is what failed the row, and it did so on the one row whose whole job is to
re-enrol a device through the IdP.

**The disposition is NOT to widen the classifier globally.** Those six lines are expected on a row
that logs in and are the visible end of something upstream anywhere else - which is the noise rule
exactly. The mechanism that already fits is `ignoringExpectedLog`, per row, naming them.

**The accessibility hint is a separate, real, small finding**: the PIN field is a bare
`type=password` with no username field in its form. It belongs with the P2 above, in the same pass.

**IT RECURRED ON HEAL-NEW-15, `038c7e8d`, and that run is why the disposition above is now owed
rather than merely correct.** It is the rung's FIRST verdict to have passed `gate()` at all, and the
gate demoted it to `PASS-DIRTY` on three shapes, none of them the row's subject and all three the
MINT's own signature: `POST /api/auth/refresh?clientVersion=0.14.12 -> 401` from a client that had
just deleted every cookie it owned, which is the wipe working; the OIDC callback's `debug:` trail
(`code length: 32`, `savedState present`, `redirectUri`, `got access_token`); and the purge's
`[DevicePanel] Found/Deleting/Deleted`. **Every HEAL-NEW row will produce all three, every time**, so
the per-row `ignoringExpectedLog` list is what stands between this rung and a wall of `PASS-DIRTY`
verdicts that say nothing about the product. Name them per row, never widen the classifier.

**SHIPPED FOR THE HEAL-NEW ROWS ON 2026-08-29, and only for them.** `healnew.mjs` carries
`withoutTheMintsOwnNoise` - `ignoringExpectedRefusal` for the `POST /api/auth/refresh -> 401` and
then `ignoringExpectedLog` for the OIDC trail and the purge's three lines, in that order, because
`ignoringExpectedLog` recomputes `clean` over `badHttp` as it finds it. Every needle names a SUCCESS
spelling - the status pinned to `200`, the state check to `matches: true`, and none of
`[DevicePanel]`'s five `console.error`/`console.warn` spellings named at all - so a `500` from
core-service, a mismatched OIDC state or a failed device deletion stays dirt.

**CLOSED FOR THE HEAL-REVOKE ROWS TOO, and the claim that it was open was WRONG** (checked in the
source 2026-08-30, after this file and `CLAUDE.md` had both carried "`healrevoke.mjs` ... has no such
list" for two days). That runner ships FOUR lists, one per OBSERVER rather than one per row, which is
the finer cut: `asAReturningDevice` forgives the OIDC trail and a cold client but not the panel it
never drove; `asAFreshlyMintedDevice` adds the purge; `asTheWipedVictim` is the only one handed
`AUTH_TEARDOWN_NARRATION`, because a session clearing itself is its subject and everyone else's
finding; and `asTheActor` forgives NO refusal at all, so a `401` on `/api/auth/refresh` - the wipe
working, on the victim - stays a finding on the one client that wiped nothing. The wipe's own three
sentences are deliberately in no list: `NOTABLE` already claims them, so a list would forgive nothing
and report three dry needles on every row of the rung.

**Two lines from that run are explained and must NOT be re-opened.** `History msg error: Group not
found: 642f389a...` is the amber probe's own doing - the row clicks a SYNCING tile on purpose, and a
conversation with no MLS state is exactly a group the history reader cannot find. `[WS] Disconnected.
Code: 1006` is a browser the row killed by construction.



### P2 - iOS carries none of the window-layout work Android already has (user, 2026-08-28)

**Named by the user from real use on an iPhone**, and one of the three is already fixed. The Android
half of each of these took a measurement and a comment to get right (`MainActivity`,
[mobile](frontend/mobile.md#the-window-layout-the-keyboard-and-the-orientation-lock)); iOS inherited
none of it because `gen/apple` is a different generated project nothing compared against `gen/android`.

- **DONE 2026-08-28 - the keyboard.** WKWebView was never resized, so the shell was pinned to the
  visible height inside a full-height document and a keyboard-tall empty band opened below it.
  `CanariApplyKeyboardLayout` shrinks the WebView's frame; no web change was needed. Written up on
  [mobile](frontend/mobile.md#ios-shrinks-the-webview-and-that-is-the-same-decision-taken-twice).
- **OPEN - the bars at the top and the bottom.** The user reports black bands, or none at all, where
  the status bar and the home indicator are, with the interface colliding with system text and
  controls. Android's answer is an explicit inset contract; iOS has `env(safe-area-inset-*)` scattered
  across `app.css` and a dozen components and no single owner. **This wants ONE pass over `app.css`
  with a device in hand**, not local patches - the same conclusion the emoji / dead-row / device-row
  items reached, and the same pass.
- **ANSWERED 2026-08-28 - the question "what else has no iOS peer" now has a written answer.** The
  audit is [android-ios-parity](frontend/android-ios-parity.md), the only copy: six graphical
  findings, six software ones, eight concerns confirmed already at parity so nobody re-derives them,
  and one asymmetry closed by construction that must NOT be given a peer. The orientation lock and the
  bottom nav's reservation are both fine. **The three structural candidates for the bars the user
  reports are 1.1 (iOS hides the status bar where Android keeps it edge-to-edge), 1.3 (the launch
  background is Apple's, not the product's) and 1.4 (the WKWebView background is never set, so the
  mechanism that kills Android's startup flash has no iOS peer).** Ranking them is a DEVICE
  measurement; the audit deliberately refuses to rank them from source.

**This closes by HARDWARE, one item at a time**, like every other iOS finding: three of three defects
so far were invisible to every gate here.

### P3 - nothing records which BUILD each device runs, though two mechanisms already carry it (2026-08-27)

Asked by the user while debugging the iOS session: is there one place naming the version of every
device? There is not, and the two pages that look like it are not it - `/admin/platform` WRITES
`minClientVersion` (a policy, not an observation) and `/admin/status` reads live presence out of the
gateway (no version at all). The question mattered immediately: every `Refresh refused` line from an
iPhone was ambiguous until the user stated by hand that all of them were on 0.14.5.

**Two mechanisms already receive the value.** `GET /users/me/announcement?clientVersion=` takes it from
every client on every launch and uses it only to decide an announcement's audience, then discards it;
and since 2026-08-27 `POST /auth/refresh?clientVersion=` carries it for the refusal log. Meanwhile
`push_token` already holds exactly one row per `(userId, deviceId)` with a `platform` and an
`updatedAt`. Recording the version against a device is therefore a column and a write, not a feature -
and it would have answered both this question and the iOS FCM one above without asking anybody.

Not done tonight because the cheap version is genuinely cheap and the useful version is a decision:
which table owns it, whether a web session counts as a device, and what a dashboard should show
(distribution by version, or the laggards below `minClientVersion`).

**AND A THIRD MECHANISM ALREADY HAS THE COLUMN, WRITES IT ON ONE PLATFORM AND LEAVES IT NULL ON THE
REST - measured on prod 2026-08-28.** `key_package.deviceAppVersion` exists, `register-device`
sanitises it, and both client services accept it. Over the last 21 days, by `deviceOs`:

| `deviceOs` | enrolments | carrying a version |
| --- | --- | --- |
| android | 58 | 36 |
| ios | 48 | **5** |
| windows | 40 | **0** |
| macos | 12 | **0** |
| linux | 6 | **0** |

Two separate causes, and the population is what separates them. **The web never sends it at all**:
`WebMlsService.publishKeyPackage` passes `deviceName` and `deviceOs` and stops there, while
`TauriMlsService.publishKeyPackage` awaits `getRuntimeAppVersion()` and includes it - so windows,
macos and linux read 0 out of 58 by construction, and that half is one line. **The iOS half is not
that**: it goes through the Tauri path, which does send the field, and still 43 of 48 enrolments
carry nothing - so `getRuntimeAppVersion()` is answering empty on that platform, which is a
different defect and the one worth measuring before writing anything. Android's 22 missing rows say
it is not purely iOS either.

**Why this is worth more than a column being tidy: `minClientVersion` is raised BY HAND and is
supposed to be reasoning about what devices actually run.** On the evidence above, the one table that
records a device's build is empty for every desktop browser and for 90% of iPhones - so raising the
floor is a decision taken against no data at all, which is exactly what
[legacy-compatibility](legacy-compatibility.md) warns about from the other side. Found while checking
the per-user device cap on a real account, not by a gate.

**A REAL ACCOUNT IS AT THE CAP, AND IT IS NOT A DEFECT - it is what the cap looks like from the
inside.** `39b96d7e` holds 15/15 `key_package` rows: **14 `ios` between 2026-07-21 and today**, plus
one `windows` taken today, and 13 `auth_sessions` all created between 2026-08-26 and 2026-08-28 with
12 distinct iPhone user agents. That is the iOS debugging campaign - every install minted a device
and nothing ever deleted one - and the next install on that account will be REFUSED. The mechanism is
complete and behaves: the server logs `[REGISTER_DEVICE] REFUSED device cap`, throws
`DEVICE_LIMIT_REACHED`, the client classifies it as `DeviceLimitReachedError` at the fetch and
`chat_device_limit_reached` tells the user in French to delete a device in Settings. Recorded because
the failure LOOKS like "iOS cannot enrol" and cost a HEAL rung a night once already, on the test
account, for exactly this reason. **A device is only reclaimed by the 90-day retention window or by a
person deleting it**, so an account debugged through fifteen installs stays capped for three months.

### P3 - the native refresh credential could live in the platform keychain, on BOTH platforms (2026-08-27)

**Not a defect - a strict improvement, deliberately not bundled with the fix that needed shipping.**
Today the credential sits in a file inside the app sandbox: the Chromium cookie file on Android, a
`@tauri-apps/plugin-store` file on `tauri://localhost` ([sessions](sessions.md#the-credential-a-client-carries-itself)).
Both are protected by the OS at the container level and neither is encrypted as a secret. The
platforms both offer better - iOS Keychain, Android Keystore / `EncryptedSharedPreferences` - and the
same argument applies to each, which is why this is one item and not two.

**What blocks it from being trivial:** `patches/tauri-plugin-keystore` already reaches the iOS keychain,
but its `ios/Sources/CustomTabsPlugin`-style path builds `SecAccessControlCreateWithFlags` with
BIOMETRIC flags, because it guards the MLS device key - reading it raises Face ID, which cannot sit in
front of every cold start. So this needs a second, non-biometric command in the vendored plugin
(`kSecAttrAccessibleAfterFirstUnlock`), Kotlin parity so the Android build still links, a permission
entry, and an iOS build to verify - none of it measurable from this machine.

**Do not start it as a security fix.** The current posture is the one Android has had all along and
which the user has accepted; this is an upgrade to both, worth doing when native work is being done
anyway rather than as an emergency.

### P3 - the last node runtime: four jest suites that will not run under bun (decided 2026-08-27, AFTER the campaign)

**Scheduled, not parked, and the decision behind it is the user's** (2026-08-27): npm leaves now,
node leaves later. npm is already gone - `node --run test` replaced the one `npm test` in
`ci.yml` and the one `bun run test` in the Makefile's `test-history`, so nothing in this repository
invokes a package manager other than bun. What survives is the node RUNTIME, in three places:
`actions/setup-node` twice in `ci.yml` (once for the backend suites, once for the harness
self-tests) and once in `code-analysis.yml`.

**The measured blocker, and it is one file.**
`apps/chat-delivery-service/src/controllers/admin-storage.controller.mls.spec.ts` passes 8/8 under
node and fails under the bun runtime. That single spec is why CI installs, lints and builds with bun
but TESTS with node, and both call sites say so in a comment. **Do not collapse the two runtimes
without re-running that spec** - the note has been in `CLAUDE.md` since the bun migration and it is
the only thing standing between a green pipeline and a silently weaker one.

**What the work actually is.** Porting four NestJS services from jest to `bun test`: `jest.fn()` and
`jest.spyOn` to bun's `mock`/`spyOn`, `ts-jest` (which TypeScript 7 already could not load - see
[ecosystem-convergence](ecosystem-convergence.md) section 9), the `moduleNameMapper`, and the
`@nestjs/testing` module fixtures. It is days, not hours, and it touches suites that guard MLS
storage - the wrong place to discover a mock that silently stopped asserting.

**Sequencing, and why it is not now.** The campaign is running and prod is the test server. A test
framework migration changes what "green" means for every rung still to be taken, so it waits until
the ladder reaches the bottom. Until then the honest description of this repo is: **bun is the
package manager and the runtime everywhere except one test invocation, which runs on node on
purpose, for a reason that has been measured.**

### P1 - the SFU runs SIX webrtc majors it has never placed a call on (2026-08-27)

**This is not a bug report. It is the absence of one, which is worse.** `apps/call-service` was
brought back to compiling on 2026-08-27 after two Dependabot majors had merged onto `main` through a
CI hole (story in `CHANGELOG.md`; the hole itself is closed - the crate is in the Rust matrix now).
The bumps were `webrtc` 0.11 -> 0.17 and `axum` 0.7 -> 0.8. **What is verified is that it builds,
that clippy is clean under `--all-features`, and that its ten unit tests pass. Not one of those runs
the ICE stack, and not one of them places a call.** The repository's own rule names exactly this
distance: a green gate is not a working system.

**Six majors of webrtc-rs is not a version bump, it is a different library.** One behaviour change is
already known because it caused a compile error: `RTCIceServer::credential_type` is gone, and the
rule it carried moved inside the crate - `RTCIceServer::urls()` now returns `ErrNoTurnCredentials`
for a `turn:`/`turns:` URL whose username or credential is empty, where 0.11 accepted the same input
with an `Unspecified` credential type. A misconfigured TURN entry therefore used to degrade quietly
and now fails the WHOLE ICE configuration for that peer connection. `build_rtc_ice_server` warns and
names the offending server, which is the only thing that can be done from here without a call.

That one surfaced because it broke the build. **The ones that did not break the build are the reason
this entry exists**, and they cannot be enumerated by reading a diff - between 0.11 and 0.17 the
crate reworked ICE gathering, DTLS and the RTP/RTCP interceptor chain, none of which this crate's
types force it to acknowledge.

**What settles it is one call, and only one call.** Two peers, audio and video, over the SFU, with
TURN configured as production configures it - the relay path specifically, because that is the path
the `ErrNoTurnCredentials` change sits on and the path a STUN-only test never touches. Watch for: the
peer connection reaching `connected` at all; the terminal ICE line the crate already logs; whether
renegotiation still lands (`main.rs` has a renegotiation path that no test covers either).

**AND IT IS TAKEN BY HAND, WITH NO CALL RUNNER WRITTEN** (decided 2026-09-06). This is rung 15 of
the ladder, CALL, one of the three phases with no runner - and building one is not what the single
call above needs. `CALLS_ENABLED` is flipped in the LOCAL tree only and put back; the five switches
that move together at a real revival stay untouched. **The twenty CALL rows stay NEVER RUN,
deliberately**, the user's ranking being unchanged since 2026-09-01 (*"les appels video et audio ne
sont pas la priorite"*) - so the campaign cannot be called finished, which is an honest state rather
than a gap. Until the call is placed, calls are UNVERIFIED on this build, not broken: nothing
observed them failing, because nothing observed them at all.

**SETTLED 2026-09-01 BY HOLDING THE SURFACE OFF, not by taking the measurement** (user: *"les appels
video et audio ne sont pas la priorite, et n'ont pas ete testes en bonne et due forme"*). The
paragraph that stood here said a release must not carry this unplaced; `CALLS_ENABLED = false`
(`frontend/src/lib/features.ts`) is how 0.14.15 carries it instead - the buttons are not rendered,
`handleCallSignal` refuses an invite a legacy peer still sends, and the two system ring surfaces are
uninstalled at their choke points (`CanariReportIncomingCall`, `showIncomingCallNotification`). The
platform declarations went with it, because each is a claim about a feature the store can check: the
iOS `voip` UIBackgroundModes entry (refused by App Review under 2.5.4 on 2026-08-31) and Android's
`USE_FULL_SCREEN_INTENT`.

**What is still owed is unchanged, and now has a name to flip.** One relay-path call, two peers,
audio and video, with TURN as production configures it - prod HAS it configured
(`CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_CALLS_API_TOKEN`, TTL 7200, read off the container
2026-09-01) and has never once used it. The revival is one commit: `CALLS_ENABLED`, the plist entry,
the manifest permission, `kCanariCallsEnabled` and Kotlin's `CALLS_ENABLED` all move together, and
`CallService.callsEnabled.test.ts` is the test that already asserts the on state.

### P2 - what made the profile fetches fail on that device at that moment

**The MECHANISM is closed** (2026-08-16): the swallowed `catch` now accuses, a reconnection clears
`failedAt` because a failure recorded while the network was down is evidence about the network rather
than about the user, a failed lookup answers `null` instead of the label that overwrote names the
caller already had, and `displayName.spec.ts` pins all of it.

**What is owed is the DENOMINATOR, and it is a measurement rather than a change.** The log line that
makes it countable did not exist when the symptom was seen - twice on 2026-08-16, on both platforms,
nine of ten sidebar rows carrying "Utilisateur inconnu" for twenty seconds. Do not assume it is the
same fault as the avatar endpoint, and do not assume it is not.

**The denominator now rides ON the accusation (2026-08-19).** `displayName.ts` counts the lookups
that actually reached the network - a cache hit, the current user, the `system` sender and a lookup
already suppressed by the backoff are all excluded, because counting them would drive the rate
towards zero exactly as the cache warmed and measure the cache rather than the fault - and every
warn now ends `(failed/attempted lookups failed this session, X%)`. One line answers both "did a name
get lost" and "how often does that happen here", which is the question the backoff turns on.
`displayNameLookupStats()` exposes the same numbers to a test or a debug surface.

**Where the number will come from:** the campaign run logs, on both platforms. Nothing here is sent
anywhere - there is no client telemetry and this did not add any - so the rate is read from a device
or a browser console during a run, which is exactly where the symptom was seen. Server-side is not
an option: `GET /api/users/:id` is not request-logged, and a client that never reached the network
would not appear there anyway.

**Then decide about `FAILURE_BACKOFF_MS`.** A high rate argues the two-minute suppression is doing
real work against a refusing server; a rate near zero argues it is a clock hiding a name for two
minutes over a blip that the reconnection listener already handles.

### P2 - measure EGRESS over time, because two unrelated upstreams stalled in one window

The code half is fixed: `UpstreamUnreachableError` classifies at the throw, so an unreachable host is
a **502 `no-store`** never remembered, while an answer about the URL stays a cacheable 400; and
`OUTBOUND_BUDGET_MS` is the single budget, set on the `AbortController` AND on the undici dispatcher,
so the stated budget is the one that fires. Pinned by `security.controller.link-preview.spec.ts`.

**What is owed is not a code change.** Within one three-minute window on 2026-08-15, two unrelated
upstreams timed out from two different containers (`chat-delivery-service` → Wikipedia at 14:37:02,
`core-service` → gallery at 14:39:58). That is not evidence about either upstream, and it is the
second time this shape has been mistaken for one - the IPv6 reading was refuted by measuring the
components, which all came back healthy. **Measure EGRESS over time rather than the endpoints again**:
the component probes already say each is fine at the moment it is asked, so what is left to establish
is whether these stalls are CORRELATED, which a one-shot probe cannot answer by construction.

**ARMED 2026-08-19.** [`infrastructure/egress-probe/`](../../infrastructure/egress-probe/README.md)
takes a sample a minute - both stalled upstreams, the tunnel back to ourselves, a control at 1.1.1.1,
and the same target from inside `chat-delivery-service` through Node's own fetch - with DNS, connect
and TLS recorded apart from the total. `report.py` prints each conditional rate beside the base rate
it has to beat. Installed in the `canari` crontab, verified writing, `probe.err` empty.

**This item cannot be closed by working on it.** A report over a quiet week says the week was quiet.
Read the ledger the next time a stall appears in a service log; that is the moment the two
hypotheses differ, and the stall will already have been measured.

---

## Communities and permissions

### P3 - three server line families are the routine consequence of enrolling a device, and nothing has ever classified them (measured twice, 2026-09-07)

Every `roster.mjs` row that enrols a second web device ends `SERVER NOT CLEAN`, and the same three
sentences are why. All three were read and none is a defect:

| Line | What it is |
| --- | --- |
| `[DEVICE_MEMBERSHIPS] user=… count=5 stranded=4 → 3 → 2` | the convergence the row exists to watch, printed as it happens - and going the RIGHT way |
| `[PubSub] …:… not connected to this gateway - message stays in DB queue, will be fetched on reconnect` | the designed queueing path for a device that is offline |
| `Refresh refused: no canari_refresh cookie. cookies=[] x-canari-refresh=absent` (DEBUG) | a browser seconds old, before it has one |

**`notable` is the right home for all three and `BENIGN` is not.** A notable line is printed and does
not break `clean`; a benign one is dropped, and dropping `Refresh refused` would silence on the
LOCAL estate a sentence that is a real signal on production - it is what named the iOS session
defect. Surfaced rather than judged is exactly the distinction that bucket exists for.

**Not done inline**: `srvlog.mjs`'s four rule lists are shared by every phase, and
`srvclassify-selftest.mjs` exists precisely so a rule is proven to fire on the line it claims and on
nothing else. Adding three rules without their three cases would be the drift that selftest was
written to prevent. It blocks no row verdict today - a row is judged on its client reports and its
logcat half - so it is P3, and the cost of leaving it is that the next genuinely new server line
arrives among five a reader has learnt to skip.

### Question - does an invitation into a community notify somebody the inviter has never spoken to? (user, 2026-09-05)

Verbatim: *"Inviter dans communaute sans avoir discussion prealable : notification ?"*

**A QUESTION, NOT A DEFECT REPORT - and its first task is to answer itself.** Nobody here has asked
it, so the current behaviour is unknown rather than wrong, and an entry that guessed would be worse
than one that does not.

**WHY IT IS WORTH A ROW RATHER THAN A READ OF THE CODE.** "No prior conversation" is not a cosmetic
variation on the invitation path - it is the state in which the two parties share the least. Reading
the source can say which call is made; it cannot say whether a device with no prior anything is
addressable at the moment the invitation is sent, which is a fact about the server's roster and the
push token, not about the branch. The campaign has already found one defect of exactly that
shape - a device given a roster seat and never a Welcome - and it was invisible to every reading.

**WHAT WOULD ANSWER IT.** One row: a fresh peer with no conversation history with the inviter, the
app backgrounded, invited into a community. Three outcomes to tell apart, and they want different
fixes: no notification is raised at all (the push was never sent, or the device holds no token), one
is raised but carries nothing readable (the decrypt failed - the
[community notification P2](#p2---a-community-message-is-not-decrypted-in-a-background-notification-and-the-killed-case-is-unmeasured-for-both-kinds-user-2026-09-05)),
or it works. The logcat is what separates the first from the second; the shade alone cannot.


Six entries came out of ONE audit on 2026-08-17, prompted by a user question rather than by a
failure. **All six are closed as of 2026-08-19** and are not repeated here - the last one, two communities
sharing a name, the user closed by decision rather than by code (2026-08-19: it is not a defect).
The five that shipped on 2026-08-18: the mechanism is on
[social-service](services/social-service.md#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18),
the audit and its prod figures on [community-rework](services/community-rework.md), the rule in
[durable-rules](durable-rules.md), and the story in `CHANGELOG.md`. Those six are closed; the entry
below them, a private salon's seed being sealed to the whole community, closed on 2026-08-20.
WP-REGRANT-1, opened 2026-08-21 by the campaign, shipped and was verified on production the same day -
its entry below is kept as CLOSED because the second attempt at the fix is the interesting half. **One
thing IS open here, and it is an observation rather than a finding:** the past-epoch seed frame below.
**The association permission audit, asked for on 2026-08-26, SHIPPED the same day** - all three
parts. Its measured flag table, the one predicate that replaced four disagreeing spellings, and the
seven findings D1-D7 are on [association-permissions](association-permissions.md), the only copy;
the rules it paid for are in [durable-rules](durable-rules.md), the story in `CHANGELOG.md`, and the
French user page it owed is `docs/user-guide/permissions-association.md`.

### P3 - an epoch-0 seed frame is delivered on every rotation, and nobody can open it (observed 2026-08-21, did not reproduce)

**COMM-22, six cycles, six of these** - one per cycle, both clients seeing the same frame at the same
second, `group_epoch` 3/5/7/9/11/13 and `msg_epoch` **0 every time**. So a frame sealed at the group's
first epoch is presented again on every rotation.

**Not a loss, and the product says so:** the frame is acknowledged and the seed arrives through the
history request instead - 12 markers of 12 warm AND cold. What is unexplained is why an epoch-0 frame is
delivered at all: `queued_message` held no publish matching it, which points at a REPLAY rather than a
sender sealing under a stale handle, and "points at" is not a finding.

**AND IT DID NOT REPRODUCE** - the next run on the same build, after `cleanup.mjs` swept three debris
communities, recorded `pastEpochFrames: []` over six cycles. The other half of the original observation
WAS real and is closed (a deleted community's seed carrier held for ever - see
[graine](protocols/channel-encryption.md#a-community-deleted-left-its-seed-carrier-held-for-ever---fixed-2026-08-21)),
and it accounts for the redelivery bursts but not for these frames, which appeared on a salon whose
community was alive.

**P3 and not higher because it may already be gone.** Settling it needs ONE probe that publishes a seed
and reads back what the server fanned out - a different instrument from the COMM runners. `comm22.mjs`
records `pastEpochFrames` verbatim on every run, so every future run says whether it is back, and the
cheapest next step is to read those rows rather than to build the probe.

### P3 - a Welcome is repaired by kick + re-add, and nothing records which of the two causes it was

Found 2026-08-25, while attributing GRP-8's `PASS-DIRTY` of 2026-08-24 (the run is on the
[board](cross-client-testing.md); the environment half is a methodology rule and is not repeated
here). A device of the group's creator was fanned into a new group, then sent a `welcome_request`
for a group whose leaf was ALREADY in the MLS tree. `actions.ts:956` handles that the documented way
- read the tree, kick the stale leaf, re-add - and logs `[KICK] Stale leaf ... removed`.

**The repair is right; what is missing is which situation it repaired.** Two reach this line and they
are not the same event:

- the Welcome was **lost or never delivered**, and the device's request is the retry that recovers
  it. The mechanism working exactly as intended.
- the Welcome was **still in flight**, and the device asked before it arrived. Then the push and the
  pull overlap, the repair is reconciling two paths that produced the same leaf, and the standing
  rule applies: *a race that heals cleanly is still a defect - name what makes the two paths overlap
  and delete the overlap; a ledger that reconciles them afterwards is a witness, never a fix.*

Nothing at the kick site can tell them apart, and the client that would know is the one being
repaired. **What would distinguish them:** the requesting device's own log - whether it had received
and failed to process a Welcome for that group, or had never seen one - and the elapsed time between
`sendWelcome` for that (group, device) and the `welcome_request` arriving. Neither is recorded today.
Carry the discriminator to the decision from where it is already known, rather than learning by
failing: the handler knows when the Welcome was sent, so the line can say which case it is.

Not raised above P3 because the repair is correct either way and no user-visible loss has been
observed - but it is the reason a group-creating check can go dirty on a device nobody touched, so
whoever reads the next `[KICK]` needs this page.

### P3 - the seam that forgets a conversation forgets it silently

Found on 2026-08-25 in the same reading. `historyReconcile.ts:756` is `forgetGroupReconciliation`,
the one seam every deletion path calls so that state describing a conversation cannot outlive one -
`conversations.ts:193` and `:228`, `groupActions.ts:151` and `:362`. Its own doc comment says why it
is one seam and not a line in each path: *"the old registry learnt the hard way: state describing a
conversation may not outlive one, and three separate pieces of it once did, one of them
user-visible."*

It clears three maps - `asked`, `deferred`, `coverageStated` - and logs nothing at all. So the
mechanism that exists BECAUSE this state once leaked past a deletion leaves no evidence that it ran,
which is the one thing a reader would want when it leaks again. Every rule this project has about
observation says the same: a correct mechanism with no report is found by hand, a day late.

**One line at entry, naming the group and what it held** (`asked`/`deferred`/`coverageStated` all
carry a value worth printing - a deferred reason, a peer count), plus the rule to classify it. Two
sibling exports read the same maps and are called only by `historyReconcile.test.ts` -
`deferredReconciliations()` and `statedCoverage()`. That is a legitimate test seam, not dead code,
and it stays.

**Why it is deferred.** Same reason as the entry above and filed with it: a product log line changes
what the classifier sees on four deletion paths at once, so it lands after the ladder, with its rule
written in the same commit.

### P2 - a bundle of pure DECLINES still goes out as transport, and a dropped decline strands a requester

**The measured case shipped 2026-08-25** - an answer carrying seeds is now `DELIVERY.keyMaterial`,
silent AND durable, so the server queues it without consulting presence. Story in `CHANGELOG.md`, rule
in [durable-rules](durable-rules.md), and COMM-18 is a clean `PASS` on it.

**What is left is the same shape, smaller, and has never been observed.** A bundle of PURE DECLINES
still goes out as transport, deliberately: it carries no key material and restates a fact the requester
could derive. But a dropped decline strands a requester exactly as permanently as a dropped seed did -
it is the fact that sends them to the NEXT member, and nothing re-asks.

**Why it is not fixed with the other half.** It needs the ability to deliver a frame to a device that
presence reports offline WITHOUT appending it to the group's log - the fourth combination `DELIVERY`
does not have (`silent` and `durable` were one boolean until 2026-08-12, and `durable` still gates both
the presence filter and the history append server-side). Splitting them is a wire-level change, so it
waits for a measurement that needs it rather than being guessed at now.

### P3 - a poll whose deadline passes while the card is on screen flips only on reload

Left behind by the COMM-15 fix of 2026-08-25, and stated here so it cannot hide behind that defect a
second time. The closure of a channel poll is now the SERVER's statement (`ServedChannelPollMeta.closed`,
[social-service](services/social-service.md#channel-polls-and-who-decides-one-is-over)), which fixes
the case that mattered - a poll closed by a human, whose card used to stay open for ever because two
clocks answered the question. It does not fix the case where the deadline simply arrives: `closed` is
stamped when the poll is handed out, and nothing re-reads it afterwards.

Two things stop at that instant, and only one of them is worth anything. The FOOTER (the vote form
giving way to the ended label) is the one that matters, and it is wrong for as long as the card stays
mounted - a person can still submit into a poll the server will refuse with a 403, which is the same
class of "the server enforces a rule the client has never heard of" the write-policy work already
named. The COUNTDOWN is cosmetic: `pollCountdown` renders whole minutes and does not tick, so it is
already stale between renders, and it now floors at zero rather than claiming an ended poll is still
open.

**The fix is NOT a timer in the card**, which is what "make it tick" would buy, and would put a
per-poll interval in a list that scrolls. The deadline is KNOWN, so the moment it becomes interesting
is known too: one `setTimeout` per mounted poll, at `endsAt - now`, that flips the poll's own state
once and never fires again for an already-closed poll (and never at all for one with no deadline).
Even that has to state whose clock it used, so the delay is computed from the same server statement
the card is already given rather than from a comparison this side makes. Alternatively - and cheaper -
the vote submission's own 403 is a fact the card can act on, which is the one path where being wrong
actually costs a person something.

**Why it is deferred.** It is a rendering item behind a defect that is fixed, nothing on the ladder
asserts a deadline arriving live (the campaign closes polls with the close control), and MUT-20 aside
no check waits on wall-clock time at all. It belongs with the rendering pass, not with a rung.

## Messaging convergence

### P1 - the repair of a rewound sender lands on a coin flip, the ask cadence is identical either way, and a peer 21 messages behind was told "same state - nothing to do" (measured 2026-09-08, ten runs across three builds)

**THE ROW IS HEAL-repair, AND ITS `PASS` OF 2026-09-06 WAS ONE DRAW OF A THREE-SIDED COIN.** Ten
runs, three builds, one runner, one estate swept before each:

| build | outcome, in order | asks | swallowed | re-elections |
| --- | --- | --- | --- | --- |
| `9cf5191cc`, as shipped | HEALED, PARTIAL 7/14, PARTIAL 7/14, HEALED | 3 | 13 | 0 |
| + the live path escalating instead of coalescing | HEALED, PARTIAL 9/14, PARTIAL 8/14 | 11 | 0 | 10 |
| `9cf5191cc` with the checkpoint-bound marks DISARMED | HEALED, PARTIAL 7/14, PARTIAL 7/14 | 3 | 13 | 0 |

**TWO CANDIDATE CAUSES ARE REFUTED BY THAT TABLE, and neither is to be re-opened without new
evidence.** Disarming the checkpoint-bound history marks reproduces the shipped build's distribution
*exactly* - same verdicts, same counts - so that change is not the cause and stays. And the 30 s
coalescing window is not the cause either: removing it entirely (row two) changed every mechanism
counter and healed nothing.

**WHAT ACTUALLY SEPARATES A HEALED RUN FROM A PARTIAL ONE, and it is not the asking.** The cadence is
identical in both: three asks, about 33 s apart, `escalated: true` every time. The difference is
whether any one of them is ANSWERED.

    healed    01:44:32  asked ... whether we hold the same history     <- nothing comes back
              01:45:06  asked ...                                     <- nothing comes back
              01:45:39  asked ...
              01:45:40  [HISTORY_BUNDLE] 18 messages received         <- 172 ms later

    partial   01:48:53  asked ...
              01:49:27  asked ...
              01:50:00  [HISTORY_REQ] same state as <W1> - nothing to do
              01:50:00  asked ...                                     <- no bundle, ever

Every PARTIAL run contains ZERO `[HISTORY_BUNDLE]` lines. Every HEALED run contains exactly one, and
it answers the LAST ask rather than the first.

**AND THE FIRST LEG HAS BEEN WRONG AT LEAST ONCE, WHICH IS THE HARDEST FACT HERE.** On the healed run
of 01:07:

    01:07:46.524  [HISTORY_REQ] 2bd5add9... same state as <W1> (287cc8e5...) - nothing to do
    01:07:46.689  [HISTORY_DIGEST] Sent for 2bd5add9... - ids mode, 837 id(s), asking from 2026-06-10
    01:07:46.791  [HISTORY_BUNDLE] 21 messages received for 2bd5add9... from f7a9bb80

The state-key leg answered *we hold the same history* and a digest found **21 missing messages 267 ms
later**. Both keys are computed over the ASKER'S window (`historyStateKeyFor(groupId, probe.since)`),
so this is not two devices measuring different spans. The stale-cache explanation is already
excluded: `invalidateHistoryStateKey` is called on every write path of BOTH backends
(`indexeddb.ts`, `sqlite.ts`). What is NOT excluded, and is where to look first, is the window -
`historyRangeStartFor` - and whether an empty or clipped span makes two different stores hash alike.

**THE SAME DEFECT IS WHY TAB-3b IS `PASS-DIRTY`, and that is how long it has been standing.** W1
reports the *same two frames* on reload after reload - r2, r3, r4, r5 of one run - as `[History]
frame never read here and unreadable for good (secret-reuse); will reconcile`, group `2bd5add9`,
frames `7e:4yhgc8` and `5p:1s1iuic`. The reconciliation is promised four times and never happens. A
row that stays dirty across reloads is not noise: it is this P1, seen from a check that was not
looking for it.

**WHAT THE INSTRUMENT COULD NOT SHOW UNTIL THIS SESSION.** None of the above was visible.
`escalated` matched three strings the app had deleted, so it read FALSE on every run including the
healed ones; and the printed excerpt filtered out `[HISTORY_RECONCILE]`, `[HISTORY_STATE]` and both
solicitation lines, so a human reading a PARTIAL row saw the loss and the silence with the entire
repair conversation removed. All three are fixed (`CHANGELOG.md`); the tables above are the first
measurements taken with an instrument that can see the mechanism.

**THE DIRECTION, AND IT IS ALREADY WRITTEN DOWN.** [durable-rules](durable-rules.md) says of this
exact handshake that *a deadline is not a termination proof* and *a leg that needs no remembered
state to answer must not require a live waiter to answer it*. An answer that arrives only when the
responder happens to be idle is the live waiter, and three asks 33 s apart is the deadline. Neither
half is fixed by asking more often, which row two of the table proves by trying.

**ROOT CAUSE, FOUND 2026-09-08 AFTER THE ABOVE, AND IT IS ARITHMETIC.** The server elects a RANDOM
online member. Over the A/B window the twenty history requests were routed:

    10  ->  mtnci3lc-7mhd   (W3 - same user as W1, real and active, 5 groups, seen the same day)
     7  ->  mtry8bhy-u3tl   (W1 - the ONLY device that holds the messages)
     3  ->  mtmp9dha-9nia   (W2 - these are W1's own asks)

**Half the asks go to a member that cannot help, and the run heals only when one draws W1.** Three
candidate responders, one holder: `P(draw the holder)` is about a third, and the row heals three
times in ten. The stale-device theory is dead - `bun devices.mjs` shows W3 idle `0d` with five
groups, so it is a legitimate member, not a ghost in Redis. It cannot help for a good reason: the
rewind is on W1's SENDER ratchet, so every receiver fails those frames identically, and W3 is
missing exactly what W2 is missing.

**AND THE WALK TERMINATES ON A FALSE PROOF, at a line that says so itself.** `actions.ts`, the state
leg: when `ourKey === probe.key` the responder logs `same state - nothing to do` and answers with its
COVERAGE. Coverage that is adequate is signalled by SILENCE - *"a member whose coverage turns out to
be adequate simply says nothing"* - so the asker reads *we agree, and this member is complete* and
stops. Both halves are individually right: W2 and W3 really do hold the same messages, and W3's
coverage really does span the window. The defect is the INFERENCE. The comment above that branch
already says **AGREEMENT IS NOT COMPLETENESS** and then addresses only the window case - two peers
missing the years below - never the case measured here, where two peers agree while a THIRD member
holds what both lack.

**What makes this fixable rather than philosophical: the asker holds POSITIVE PROOF it is
incomplete** - frames it has and cannot read - which is the same evidence `escalateReconciliation` is
already gated on. So the rule is *a peer's agreement is not a termination while this device holds
frames it cannot read; it is a reason to EXCLUDE that peer and elect another*. That drives the
exclusion walk from an ANSWER rather than from an absence, which is the only safe form of it - the
2026-09-08 attempt that drove it from an absence excluded W1 two hundred milliseconds after electing
it (see [durable-rules](durable-rules.md)).

**NOT ATTEMPTED IN THIS SESSION, DELIBERATELY.** The three previous attempts to carry "this group is
incomplete" across an exchange were all wrong in subtle and different ways - a durable marker read as
"have I already asked", a coalescing clock, an absence read as silence - and each was measured wrong
only after shipping. This one needs its state specified before it is built: WHAT is remembered, for
HOW LONG, and WHAT discharges it, with the discharge being the repair landing rather than any peer
saying anything.


### P3 - the pull and the socket hand the SAME row in, and the queue notices afterwards instead of the overlap not existing (measured 2026-09-08)

**SEEN ON THE PHONE FOR THE FIRST TIME, 2026-09-08, AND IT IS WORSE THERE.** NOTIF-7 (backgrounded,
push, tap, foreground) left six `severe` lines on A1: two frames at ONE epoch - group 2bd5add9,
`msg_epoch=196 group_epoch=196`, generations 7 and 8 - each refused with
`Ciphertext generation out of bounds` / `SecretReuseError` and
`MLS decryption failed at exactly its own epoch, so no redelivery can help`.

A same-epoch `SecretReuseError` means the generation was ALREADY CONSUMED, so these are duplicates
and not losses - which the row's own count confirms: it displayed exactly one message and passed
every assertion it makes.

**The asymmetry is the point.** On the web the same overlap is caught by the queue and files
`[QUEUE] delivery ... arrived twice`, a notice. On the phone nothing catches it and it reaches
openmls, which reports at ERROR - so the same defect costs a `PASS-DIRTY` on the web and SIX SEVERE
LINES on a handset, in a log a user's crash reporter would carry. It is one more reason the overlap
has to stop existing rather than be reconciled afterwards.

**THAT HYPOTHESIS IS NOW REFUTED FOR THE PHONE, 2026-09-08, AND THE REAL MECHANISM IS NOT A RACE AT
ALL.** This entry said the pull/socket overlap was *"not established"* and that what would settle it
was a pair of timestamps *"which the phone does not currently log with enough precision to compare"*.
It does log them - as `queuedMessageId` in `CanariFCM` and `qId` in `[QUEUE]` - and they are the SAME
two ids, so the frames can be followed end to end:

```
18:44:36.353  CanariFCM  onMessageReceived   queuedMessageId=98a3aef2  (c3586791 at :37.998)
18:44:54.867  CanariFCM  tryDecrypt          generation 117 CONSUMED (state loaded, 10 580 182 B)
18:44:55.115  CanariFCM  showNotification    the user sees the message
18:45:05.467  [PENDING]  Fetched 2 pending   THE SAME TWO ROWS - so neither was ever ACKed
18:45:05.476  [QUEUE]    Processing qId=98a3aef2   (c3586791 at :06.516)
18:45:06.496             SecretReuseError on generation 117
18:45:06.501  [MLS]      LOST frame ... "the sender's ratchet rewound"
```

**The background handler decrypts the frame and does not acknowledge it.** Decrypting consumes the
ratchet generation, durably - the FCM service writes the advanced state back, and `recharger_mls_au_resume`
(C2) then loads it on foreground **exactly as designed**, because a background engine advancing
`mls.bin` is the whole reason that reload exists. The row, meanwhile, is still pending server-side, so
the catch-up pull offers it again, and the second attempt CANNOT succeed. Nothing races: this is the
deterministic consequence of one path consuming a generation and another path being told to consume it
again.

**SO THE DEDUP LEDGER IN THIS ENTRY CAN NEVER FIX THE PHONE CASE.** `BaseMlsService.deliveries` keys on
the queue id and catches two JS callers handing in one row. The two consumers here are the KOTLIN
service and the JS client - different layers, and on a cold push different processes - so no map inside
the JS client can see what the background already spent. *Carry the discriminator to where the decision
is made, from where it is already KNOWN*: `writeFcmCache` already records `messageId` and `groupId` per
handled push, so the foreground drain has a durable record it could consult before handing a row to
MLS, and take the plaintext from that cache instead. The pull/socket overlap on the WEB is a separate,
genuine thing and the rest of this entry still describes it.

**AND THE LOUDNESS IS NEW, WHICH IS A GAIN AND MUST NOT BE READ AS A REGRESSION.** Before the resume
reload took the manager lock across its whole operation (2026-09-08), a reload could install a snapshot
predating the background decrypt and **put the receive ratchet back** - this entry's sibling recorded
exactly that, `2625 -> 2624` with the epoch unmoved. A rewound ratchet lets the re-delivered frame
decrypt a SECOND time and the duplicate disappears silently. With the ordering fixed the reload always
installs what the background advanced, so the re-delivery is now correctly refused and says so. NOTIF-7
went `PASS` -> `PASS-DIRTY` on that day for this reason: a silent double-spend of a ratchet generation
became a loud, correct refusal of a row that should never have been offered twice.

**AND THE REASON THE ROW IS NOT ACKED IS A SAFETY THAT DOES NOT EXIST.** Leaving it pending is the
conservative choice on its face: if the background handler died between decrypting and persisting, the
server would still hold the message and the foreground would get it. **But the foreground CANNOT get
it** - decrypting is what consumed the generation, and that consumption is durable the moment the FCM
service writes the state back. So the re-delivery this design preserves is one that can only ever end
in `SecretReuseError`. The pending row buys nothing and costs two ERROR lines on a real user's device
for every backgrounded message, deterministically.

That is what makes the fix tractable rather than a trade-off. **The hand-off has to be made atomic at
the point that already happens**: the background handler writes the plaintext to the FCM cache
(`writeFcmCache`, durable, keyed by `messageId` + `groupId`) and it consumes the ratchet - two
durable effects that must stand or fall together. Either it acknowledges the row once that cache write
has landed, or the foreground consults that cache before handing a row to MLS and takes the plaintext
from it. Both make the second hand-in stop existing; neither is a ledger reconciling it afterwards.
What must NOT happen is a retry or a suppression of the log line - *a fallback is a signal, never a
path*, and this line is the visible end of exactly the thing that needs deleting.

**THE MEASUREMENT THIS PARAGRAPH OWED IS ANSWERED BY READING, AND IT ANSWERS YES.** `consumeFcmCache`
(`utils/chat/fcmCache.ts`) invokes `read_and_clear_fcm_cache` and injects EVERY entry returned - no
bound, no filter beyond a missing-field skip - and `sessionAuth` calls it inside the startup span *"at
login as much as on resume"*. So the cache does drain completely on both paths.

**AND READING IT TURNED UP THE ARGUMENT THAT SETTLES THE TRADE-OFF.** `read_and_clear_fcm_cache`
CLEARS BEFORE THE JS HAS PERSISTED ANYTHING - the name says so - and the writes that follow are per
entry, inside a `try`. So a crash between that clear and `saveMessage` already loses the message
**irrecoverably today**: the cache is gone, the ratchet generation is spent, and the still-pending
server row can only come back as `SecretReuseError`. The unacknowledged row is not protecting against
that loss; it cannot. Acknowledging at the cache write therefore moves an existing window rather than
opening a new class of one, which is the objection that made this look like a trade-off.

**Still not attempted in this session, and now for a smaller reason.** The change is in the Kotlin
service, nothing this campaign's runners can A/B in a minute, and the honest next step is the narrower
one the reading exposes: make the clear and the persist one operation (read, persist, THEN clear)
before or alongside moving the acknowledgement. Two durable effects that must stand or fall together
are currently three that can fall apart in two places.

**What is seen.** One line on W3, on every HEAL-NEW run that has a fresh device pulling while a
socket is already live:

    [QUEUE] delivery 32db7fea... arrived twice - the pull listed a row the socket had already
    handed in and this device has not drained yet - the ordinary crossing, and nothing is wrong;
    not decrypting it again. Further ones of this shape are counted, not printed.

**Why it is filed rather than declared expected.** Nothing is lost and nothing is decrypted twice -
the line is the app correctly recognising its own duplicate. But it is the visible end of two
delivery paths overlapping BY CONSTRUCTION, and *a race that heals cleanly is still a defect*: the
reconciliation after the fact is a witness, not a fix. Declaring it `ignoringExpectedLog` on the
rows that meet it would demote a real overlap to keep a cell green, which is the one disposition
[durable-rules](durable-rules.md) refuses. So HEAL-NEW-2 stays `PASS-DIRTY` until the overlap goes.

**The direction, and it is small.** The duplicate is caught at the DRAIN, by a queue that already
holds the row the socket handed in. The pull that lists it again could ask that same question one
step earlier - a row already queued for this device is not a row to queue - which deletes the
crossing rather than absorbing it. Both halves are in-memory and in the same module, so this is a
membership test, not a new ledger.

**What is owed before the change.** The RATE, against the population: this is currently known from
one row on one client shape. `notableCount` on the same record was 91, so the counted-not-printed
tail is where the real number is. Measure it before believing the shape is as narrow as it looks.


### P1 - a backgrounded phone is never told about a message it has already received, because the JS layer waits for a push the server never sends (measured on device 2026-09-05)

**THIS ENTRY SAID SOMETHING ELSE UNTIL 2026-09-05 EVENING, AND THE MECHANISM IT NAMED WAS THE
WRONG ONE.** It read the `SecretReuseError` below as the reason a backgrounded phone shows no
notification. It is not: that error belongs to a SILENT frame that was never going to notify
anybody. The reason is one early return in the client, and it is worse than what was filed. The old
account is kept below because the observations in it are all real - only the conclusion moved.

## What actually happens, correlated across all three sources on ONE message

The phone was backgrounded with HOME (LIFE-2's premise, app alive), W2 sent one text message.

```
client   POST /api/mls/send  {"proto":"<348 chars>","silent":false,"durable":true}   <- the message
client   POST /api/mls/send  {"proto":"<276 chars>","silent":true, "durable":true}   <- a mutation frame

server   17:57:40 [SEND][send-cc0b716e] PUBLISHED recipient=<owner>:tauri-...       <- and NOTHING after it
server   17:57:42 [SEND][send-2bf6df35] PUBLISHED recipient=<owner>:tauri-...
server   17:57:52 [PUSH_DEFERRED][send-2bf6df35] still unACKed after 10 s -> FCM fallback
server   17:57:52 [PUSH_SEND][send-2bf6df35-def] FCM sent ... platform=android

phone    19:57:53 onMessageReceived: queuedMessageId=eaab3c04...   <- the MUTATION, not the message
phone    19:57:53 thread: ... silent=true
phone    19:57:57 Silent push decryption failed -> returning silently

result   notifiedInMs=null, shade empty, and `A1 holds the message: 1`
```

**The visible message never became a push at all.** `scheduleDeferredPush` fires only for a message
still unACKed after 10 s, and a backgrounded Android app keeps its WebSocket, receives the frame and
ACKs it - so the server correctly sends nothing. The push that DID arrive was for the silent
mutation frame beside it, which by definition raises no notification whatever it decrypts to.

**And the client had already decided not to speak.** `notifyInbound` opened with:

```ts
// Native mobile (Android + iOS) posts its own OS notification from the background push handler,
// so the JS layer must NOT also fire one - the user would get two.
if (isMobileTauriRuntime()) return;
```

The premise holds only when there IS a push. For the ordinary backgrounded case there is none, the
push handler never runs, and **nobody notifies at all**. The app has the message the whole time; the
user is simply never told.

**It also explains the pair this campaign had backwards.** **LIFE-8** (`am kill` - the user killing
the app) measured a decrypted push in 4.7 s: a killed app cannot ACK, so the deferred push fires and
the Kotlin handler notifies. *The phone in a pocket was the failing case and the phone the user had
killed the passing one*, which the earlier account noticed and attributed to a spent ratchet
generation. The generation is spent, and it is not why.

**AND THE ROW FIRST CITED HERE WAS THE WRONG ONE - twice, by two different readers.** The original
entry said *"LIFE-3, which KILLS the app, passes: a killed app has spent no generation, so its push
decrypts and notifies"*, and the first correction of this entry repeated it. LIFE-3 **force-stops**,
and `life.mjs` says why that is a different question: a force-stopped package sits in Android's
STOPPED state and the framework cancels every FCM broadcast to it, so the row records
`notification: {expected: false, afterMs: null}` and PASSES because nothing was owed. It is evidence
about nothing here. Re-run 2026-09-05 20:24 to check this fix for a regression - `PASS-DIRTY`,
unchanged - and that run is what caught the citation. **A row's verdict means what the row asserted,
and "it passes" is not a mechanism.**

**FIXED 2026-09-05**: the early return is gone. Native mobile now notifies on
`visibilityState === 'hidden'` - not on "hidden or unfocused", which is the desktop rule: a WebView
reporting no focus while its activity is on screen would interrupt somebody reading the message.
Five tests pin both directions, and two of them fail if the early return comes back.

**What is still owed, and it is the overlap rather than the defect.** When a message is unACKed for
10 s AND the app is alive, both paths can now notify, and they cannot merge into one banner because
they compute the notification id differently - see the table below. The window is narrow, the
failure mode is one extra banner rather than a lost message, and it is strictly better than the
silence it replaces. The id unification is the follow-up.

## The older account, whose observations stand and whose conclusion does not

On the phone, for every message:

```
E/openmls: Ciphertext generation out of bounds 433 / SecretReuseError
E/mls_core::messaging: MLS decryption failed at exactly its own epoch, so no redelivery can help
   group=2bd5add9 msg_epoch=12 group_epoch=12
E/mines_app_lib::mobile::background: [PushBG] key-based: process_incoming_message Err(... same-epoch refusal ...)
W/CanariFCM: decryptProto: ok=false -> decryption failed
D/CanariFCM: fetchCommitsFromBackend: 0 commit(s) since epoch=12
D/CanariFCM: catchup: no commit to catch up (epoch=12) -> fallback
W/CanariFCM: Decryption failed -> MlsBackgroundWorker enqueued
D/CanariWorker: doWork: background cleanup completed          <- 60 ms, and it decrypts nothing
```

**What the user sees**: `Nouveau message de <name>` with no preview. NOTIF-10 cuts the RADIOS rather
than backgrounding the app, so the app is alive, decrypts over its socket when the radios return,
and the push loses - `notifiedInMs: null` for all five messages there. That row is the one place
this noise becomes a verdict, and the fix above is what should now carry it.

**Why the generation is already consumed, from the server's own log.** The push is not
unconditional: `[PUSH_DEFERRED] queuedId=... still unACKed after 10 s -> FCM fallback`, then
`[PUSH_SEND] FCM sent`. So the server pushes only what the device has not ACKNOWLEDGED.

The phone had DECRYPTED the message - spending the generation - and had not ACKED it, because its
network was failing in exactly that window: `[OUTBOX] a461056f... transient failure (attempt 1..3):
error sending request for url (http://localhost:8081/api/mls/send)`. Ten seconds later the server
pushed a message the device already held, and the push could not decrypt it, because a ratchet
generation can be spent once.

**The notification falls into the gap between DECRYPTED and ACKNOWLEDGED**, and the ACK is being
asked a question it was not written to answer: it says whether the SERVER's copy was collected, and
it is read as whether the DEVICE needs telling. On a phone whose uplink is degraded - the ordinary
case for a backgrounded app - those two come apart on every message.

**LIFE-2 is the same defect and it is worse there.** Backgrounded via HOME (not killed), the shade
held nothing but the USB notice, `notification.afterMs: null`, and the message took 95 s to appear.
~~LIFE-3, which KILLS the app, passes: a killed app has spent no generation, so its push decrypts and
notifies.~~ **Both halves of that sentence are wrong** - LIFE-3 FORCE-STOPS, which cancels FCM
outright, so it expects no notification and passes because nothing was owed; and the row that does
measure the killed case is LIFE-8 (`am kill`, a decrypted push in 4.7 s), where the reason is the
missing ACK rather than an unspent generation. **A phone in a pocket is the failing case and a phone
the user has killed is the passing one** - that part held, for a different reason than the one given
here.

**Three rules this sits on.** *A race that heals cleanly is still a defect* - and this one does not
heal: the preview is gone for good. *A fallback is a signal, never a path* - this one is taken 100%
of the time and leads to a worker that only runs `background cleanup`. *Never learn by failing what
a fact could have told you* - `queuedMessageId` is in hand before the decrypt is attempted.

**The discriminator already exists one layer down and is thrown away one layer up.** `mls_core`
names this exactly - "same-epoch refusal", distinct from an epoch gap - and `CanariFirebaseMessaging-
Service` collapses both into `decrypted == null`, then answers with a commit catch-up whose own
comment says it is for "an epoch gap (a commit arrived while the app was closed)". For a same-epoch
refusal the catch-up cannot help by construction, and it costs a backend round trip and a worker
enqueue per message.

**What a fix owes.** Two halves, and they are independent - the first stops the waste, the second
restores the preview:

1. Carry the kind to Kotlin as a TYPE - *never branch on an error message* - so a same-epoch refusal
   stops costing a backend round trip and a worker enqueue per message, and can be answered from the
   copy the device already holds.
2. **When the JS layer is the path that decrypted, the preview must reach the notification the
   platform already has.** `notifyInbound` excludes native mobile wholesale, on the ground that "the
   background push handler posts its own" - true only when the push CAN decrypt, and by the ratchet
   argument exactly one of the two ever can.

**THE SHAPE FILED FOR (2) ON 2026-09-05 WAS WRONG, AND IT WOULD HAVE SHIPPED A SECOND NOTIFICATION.**
It said the two sides "already key their notification per conversation (`stableNotifId` / tag
`canari-<id>`), so the app's would REPLACE the contentless fallback". They key per conversation and
they key it DIFFERENTLY - measured 2026-09-05 by reading both:

| | how the id is computed | what else the notification carries |
| --- | --- | --- |
| Kotlin, `CanariFirebaseMessagingService.getStableNotifId` | a **SharedPreferences counter from 1000**, one per `groupId`, `commit()`ed under a lock so two conversations cannot collide | `MessagingStyle`, the reply and mark-as-read actions, the channel, the group summary, the launcher badge |
| JS, `useNotifications.stableNotifId` | `Math.abs(hash31(conversationId)) \|\| 1` | title and body |

Two id spaces that coincide only by accident, in one `NotificationManager` namespace - so
`sendNotification({ id })` from the WebView posts a NEW notification beside the contentless one,
with no actions, no style, no summary and no badge. **Keying "per conversation" is not the same as
keying on the SAME conversation key**, and the entry above read the first as the second.

**So the shape is a bridge, not a second surface.** The JS layer hands the decrypted preview to the
native side - one Tauri command reaching the `showNotification` path that already exists (it is
`private` in the service today, and it already suppresses itself when the app is in the foreground,
which is the guard this call needs anyway). One notification surface on Android, keyed by the id the
platform is already using, so a push that DID manage to decrypt and an app that decrypted the same
message update one notification rather than racing to post two. **Idempotent by construction rather
than by a check**, which is the only version of this worth shipping.

**Why none was written on 2026-09-05.** A rule rather than a budget: **a green gate is not a working
system, and three of three iOS defects were invisible to every gate here.** Both halves change
notification behaviour on a surface only hardware can judge, and **the phone went behind its
credential lock screen mid-phase** (`deviceLocked=1`, `wm dismiss-keyguard` refused, no credential in
the rig), so LIFE-6/7/8 never ran and nothing could be re-measured. A notification fix verified only
by unit tests is exactly the shape that has cost this project three times. **The phone answered again
later the same day**, so the blocking condition is lifted.

**THE HARDWARE PASS IS DONE FOR THE CELL THIS ENTRY IS ABOUT, 2026-09-08.** An APK was built against
the local estate and installed (`1600603`, source `edb9d7653`), and LIFE-2 - the exact premise, app
alive and backgrounded with HOME - came back **`PASS`, `"clean": true`**:

| | 2026-09-05, before the fix | 2026-09-08, on hardware |
| --- | --- | --- |
| `notification.afterMs` | `null` - shade empty | **6 359 ms, with the FULL decrypted text** |
| the message in the conversation | present the whole time, unannounced | `count: 1` - the foreground path did not re-add what the notification stored |
| the app's pid across the run | - | unchanged, so it really was alive and backgrounded |

`fcmLinkMs: 4200`, so the push precondition was measured rather than assumed - the failure that cost
four verdicts before. **The user-facing half of this P1 is therefore closed on the surface only
hardware can judge**, which is the bar this class was given after three of three iOS defects went
invisible to every gate here.

**WHAT IS STILL OPEN IS THE WASTE AND THE OVERLAP, NEITHER OF WHICH LIFE-2 CAN SEE.** Half (1) above
- carrying the same-epoch refusal to Kotlin as a TYPE - is untouched: a refusal that cannot be helped
by a catch-up still costs a backend round trip and a worker enqueue per message. And the id
unification (the table above) is still the follow-up: when a message is unACKed for 10 s AND the app
is alive, both paths can notify and they cannot merge into one banner. The remaining rows are the
salon cells in the COMMUNITY entry below, which LIFE-2 says nothing about - a salon is not the same
key path.


### P2 - a COMMUNITY message is not decrypted in a background notification, and the KILLED case is unmeasured for both kinds (user, 2026-09-05)

**Reported by the user, who has seen it**, and asked in the same breath for the question the campaign
has so far half-answered: *"Notification non dechiffrees en background - Communaute"*, and *"Les
messages sont ils bien dechiffres en notification quand l'app est tuee OU en background ?"*

**FOUR CELLS, AND ONLY TWO HAVE EVER BEEN MEASURED.** The two axes are the conversation's encryption
and the app's lifecycle state, and they are independent - so the answer to one cell says nothing
about any other.

| | app BACKGROUNDED | app KILLED |
| --- | --- | --- |
| DM or group (per-conversation MLS ratchet) | **FAIL** - LIFE-2, no notification at all. **Cause found and fixed 2026-09-05**; owed a re-run | **PASS-DIRTY** - LIFE-3, and it passes *because* a killed app cannot ACK |
| Community salon (the community's shared key) | **PASS, measured 2026-09-05** - full plaintext in the shade in 2 244 ms, seed mirrored | **UNMEASURED** |
| Community salon, seed NEVER mirrored | **UNMEASURED - and this is the user's report's likeliest home** | **UNMEASURED** |

**THE DM ROW'S CAUSE IS ESTABLISHED AND IS NOT THIS ENTRY'S.** It is
[the backgrounded-phone P1](#p1---a-backgrounded-phone-is-never-told-about-a-message-it-has-already-received-because-the-js-layer-waits-for-a-push-the-server-never-sends-measured-on-device-2026-09-05):
a backgrounded app receives the message over its WebSocket and ACKs it, so the server never sends a
push at all, and the client had an early return refusing to notify on native mobile. **The phone in
a pocket is the failing case and the phone that was killed is the passing one** - a killed app
cannot ACK, so its push does fire. *(Until 2026-09-05 evening this paragraph blamed a spent ratchet
generation. That was measured and is real, and it is not why the notification is missing.)*

**AND THE SALON HALF DOES NOT REPRODUCE.** Measured on device 2026-09-05, app backgrounded with
HOME, one message into `Canari Test Venue / #general`: the shade held
`Canari Test Venue - #general | <the full plaintext>` after **2 244 ms**, and the phone logged
`handleChannelMessage: showNotification title=... body=<the text> mentionsMe=false`. So the salon
path decrypts in the background, and it does so through a mechanism that has nothing to do with the
MLS ratchet: `lookupGraineSeed(channelId, sessionId)` against `graine_seeds.json`, a mirror the
FOREGROUND writes. **That is where the user's report most likely lives**, and it is a different
question from the one measured: the run above had A1 open the salon first, which is exactly what
mirrors the seed. The unmeasured case is a session whose seed was never mirrored - a sender who
started a new Graine session while this device was away - and its symptom is
`handleChannelMessage: no seed/ciphertext -> generic notification`.

**That line cannot say which of its four conditions failed**, and it is one `if` with four terms
(`seedB64`, `ciphertext`, `nonce`, `messageIndex`). A seed that was never mirrored and a ciphertext
the server declined to inline are opposite problems - one is a mirroring bound, the other a 4 KB FCM
budget - and they print the same sentence. Naming the term is a one-line change and it is what turns
the user's report into a diagnosis.

**A COMMUNITY SALON CANNOT INHERIT THAT ANSWER, BECAUSE IT IS NOT THE SAME KEY PATH.** A salon is
encrypted with the community's shared key
([channel-encryption](protocols/channel-encryption.md)), not with a per-conversation MLS ratchet, so
the spent-generation argument that explains the DM failure may not apply to it at all - and if it
does not, the cause is a second, unrelated one wearing the same symptom. **Two causes that produce
the same screen want opposite fixes**, so the two rows are measured apart before either is touched.

**WHAT IS OWED, and it is measurement first.** Four NOTIF rows - salon x {backgrounded, killed} and
the two DM cells re-taken on the same build so the comparison is from one afternoon rather than from
two. All four need the phone, which is
[owed a human unlock](#owed-to-the-user---decisions-rotations-and-one-off-clicks). Read the salon
rows with the invitation question in
[Communities and permissions](#communities-and-permissions): a notification that never arrives and a
notification that arrives undecryptable are different failures, and only the logcat separates them.

### P2 - a history repair still costs THREE MINUTES on a large mailbox; only the LOSS half of it was fixed (measured on the local estate 2026-09-05)

**The loss is fixed and what is left is a duration.** HEAL-REVOKE-7 `--order last`, on the build
carrying all three fixes:

    23:47:34  W1 asks the returning device to describe its store for 31101692
    23:50:43  the returning device answers - THREE MINUTES AND NINE SECONDS later
    23:50:43  W1 sends the diff, 3 of 3, immediately

Nothing is lost: the same run's reference device answered in **three seconds**, and the returning
device does get its messages - after 189 s. The row's budget had to be raised twice in one evening,
60 s to 180 s to 300 s, chasing a mechanism that works and is slow.

**THE BARRIER IS GLOBAL WHERE THE QUESTION IS PER-GROUP.** `answerAfterMailboxDrained` waits on
`waitForMessageQueueIdle`, which is idle only when the device has applied EVERYTHING - and a device
that has just rejoined is applying twenty-nine external joins plus every frame queued behind them.
The reason the barrier exists is sound and is written beside it: *"a digest computed while this
device is still applying its own queue describes a store it is in the middle of completing"*. That
is a claim about the frames of THE GROUP BEING DESCRIBED. Frames for twenty-eight other
conversations cannot change this group's manifest, and waiting for them is a cost with no
correctness behind it.

**What the fix needs**: a barrier scoped to a group. `waitForMessageQueueIdle(reason, groupId)`
already takes a group id, but it means *"the group whose catch-up session I am INSIDE"* - a
different question, and passing this group there would claim a nesting that does not exist (the
paragraph in `reconcileGroup` explains what that cost the last time). So this is a new capability on
the queue, not a new argument: *are there frames pending for THIS group*.

**DONE, 2026-09-06.** The scheduler was already per-group - `buckets` is a Map keyed by group with
its own control/welcome/message tiers - so the capability was one method away rather than a
redesign: `isGroupIdle` / `waitUntilGroupIdle`, woken after EVERY frame instead of only at the end of
a drain, and `answerAfterMailboxDrained` now takes the group it is answering about. Three details
carry the correctness: a frame that has been PICKED is out of its bucket and not yet applied, so the
drain records which group it is inside; the UNTAGGED bucket is waited for too, because nothing in
the scheduler can say whose an untagged frame is; and a handler that throws still clears the marker,
or that group would never read idle again. Five tests on the barrier, one per claim.

**The cost stays visible either way**: `reachedInMs` is recorded on every reading, so a repair that
starts taking longer shows up as a number in the ledger instead of as a row that suddenly fails.

### P3 - a browser report has no notion of a FOREIGN origin, so every row that logs in reads the identity provider's console as the application's (measured 2026-09-05)

`login.mjs` drives the real login, so the observed TAB navigates to Authentik and back - and a
console observer follows the tab, not the origin. Everything Authentik's front end prints while it
renders its password stage therefore landed in `unexplained`, attributed to Canari. HEAL-REVOKE-9
collected ten such lines on its first run, and **every row that logs in collects them**.

The phone report already has the idea: `logcatReport` buckets other Android applications as
`foreign`, with a count and a tag list rather than an inline dump, precisely because a device writes
hundreds of lines this rig did not cause. The BROWSER report has no equivalent at all.

**Disposed of for now, not fixed.** `IDP_CONSOLE_NARRATION` names the five sentence shapes and the
three login dispositions in `healrevoke.mjs` take it - which is a per-row disposition, the campaign's
own rule, and it works. **The fix is to attribute a console line to the ORIGIN that emitted it** and
classify anything that is not `SITE` (or `tauri.localhost`) as foreign, at which point no row needs
the list at all.

**Why it was not done inline**: it rewrites the classifier every runner shares, so it ages a large
part of the ledger - the same reason the `unlockPin` de-duplication is parked. It belongs between
rungs. Note that `watch.mjs` was already touched twice on 2026-09-05, so the ledger has been aged
today regardless; what makes this different is that the earlier edits were ADDITIVE constants and
this one changes what `clean` means.

### P3 - the read-receipt half of the visibility fix is unit-tested and OWED a hardware pass, and the probe that would give it needs a different precondition (2026-09-05)

The notification half was verified on the device (shade carries the decrypted text 2 218 ms after
the send, LIFE-2 `FAIL` -> `PASS`). **The read-watermark half was not**, and it is the same one-term
guard reading the same `isAppInForeground()` whose value WAS measured flipping correctly on hardware
(`{"foreground":false}` backgrounded, `true` in front) - so the residual risk is that the watermark
path behaves differently, not that the fact is wrong.

**Two instrument problems stopped the probe, and both are worth having written down.**

**`openConversation` CANNOT BE A PRECONDITION ON A PHONE THAT IS ALREADY IN THE CONVERSATION.** It
waits for the peer's row in the SIDEBAR, and on a mobile layout the list and the conversation are
different screens - so it reported `listedEntries: 0` for three and a half minutes about a client
sitting inside the very DM it wanted. A screenshot settled it in one look: the app was in the
conversation, showing every probe message including the one the probe thought had gone nowhere. **It
was one step from being filed as "the phone's sidebar comes back empty after a reinstall"**, against
an app doing exactly the right thing. The rig's own rule - LOOK AT THE SCREEN when something does
not work - is what caught it.

**And a raw `/api/mls/send` count is the wrong observable.** The watermark is an MLS control frame
among other control frames, so the count cannot name it; and the probe's own positive control came
back ZERO in the foreground, where a watermark IS owed, which correctly made the whole run
`INCONCLUSIVE` rather than a pass. Whether that zero is "already at its target" (`if (target <=
held) return`), a watermark sent before the observer attached, or a path this probe does not see, is
not established.

**What a real row needs**: the peer's view, not the sender's traffic. W2 holds the read state for
its own message, and that is the fact a user cares about - `A1 read it` appearing for a message
nobody looked at. That is one DOM read on W2 against a marker, and it is falsifiable in both
directions without counting anything.

### P2 - eleven more decisions read a visibility API that lies on every phone, and two of them look like they matter (measured 2026-09-05)

`document.visibilityState` and `document.hasFocus()` are both permanently true in a backgrounded
Android Tauri WebView - measured, see [durable-rules](durable-rules.md). Two consumers were fixed
the day it was found, because each had a user-visible defect behind it: the inbound notification and
the read watermark. **The rest were not touched, and they were not measured either.**

| call site | what it decides | what a permanently-`visible` phone does instead |
| --- | --- | --- |
| `mlsStatePersisterLifecycle.ts:16` | persist the MLS state when the page goes hidden | **never persists on backgrounding** - the case the hook exists for is the one it cannot see |
| `TauriMlsService.ts:173` | reconnect the socket when the page becomes visible | the edge never fires, so a socket dropped while away is not re-opened by this path |
| `backgroundPausableInterval.ts:29,38` | pause timers while hidden | never pauses - battery, not correctness |
| `ChatBackgroundService.svelte:881,953,1218,1237` | four guards around login and reconnection | unmeasured |
| `MainChatPage.svelte:266` | a guard on a periodic refresh | unmeasured |
| `useMessaging.svelte.ts:750` | the batch-notify log line | says `visible` about a backgrounded phone in the log, which is misleading rather than wrong |
| `LoginPage.svelte:85` | a retry on becoming visible | unmeasured |

**The first two are the ones worth measuring first**, and the first is the one that could cost
something durable: a state persister whose trigger never fires on the platform where the process is
most likely to be killed without warning. That is a hypothesis from reading, not a measurement - the
phone may well persist on another trigger, and **saying which needs one run, not an argument**.

**The fix shape is settled and cheap**: `isAppInForeground()` already exists and is `true` on every
runtime that has a working visibility API, so each site becomes one extra term and web and desktop
keep their current behaviour exactly. What is NOT settled is which sites should change - a guard
that is merely wasteful on mobile is not the same as one that loses state, and they want different
urgency.

### P2 - the false LOST-frame accusation is fixed but UNSHIPPED, and the duplicate delivery inside this entry is still open (2026-09-07)

**WHAT IS STILL OPEN HERE, SO THIS ENTRY IS NOT A CLOSED ONE.** The false accusation has a cause
and a fix, and a merged fix is not a shipped fix. The OTHER half - `[QUEUE] delivery ... arrived
twice`, which alone holds three cells at `PASS-DIRTY` and is forgiven on none of them - was refiled
on 2026-09-08 with its own measurement as *the pull and the socket hand the SAME row in*. Read that
one for the current account; what follows is the evidence trail that produced both.

TAB-3b runs five cold starts. Each one printed `[History] frame never read here and unreadable for
good (secret-reuse); will reconcile` - and the later runs re-printed **the same row keys** as the
earlier ones (`row 1788591833954-0` appears in run 1 and again in run 2), alongside
`Ciphertext generation out of bounds` and
`MLS decryption failed at exactly its own epoch ... msg_epoch=12 group_epoch=12`.

**Same-epoch `SecretReuseError` means the generation was already consumed, which means this device
already decrypted that frame.** So the verdict is a false alarm, and it is the loudest line the
history replay has: the harness's severity rule fires on it, and its reader is being taught to skip
the one line that would name a real loss.

**THE CAUSE IS TWO DECRYPT PATHS THAT SPEND A GENERATION AND RECORD NOTHING, and the ledger the
entry suspected is innocent.** Measured on W1's own localStorage, 2026-09-07: the seen-ciphertext set
for that group holds **3 491 entries - 1 800 row keys and 1 691 frame fingerprints** - and its stream
cursor is past every accused row. The ledger persists, the thunk is reached, and
`[WARN] History replay failed` appears nowhere (it is now `SEVERE` in `watch.mjs`, so a run cannot
contain it invisibly again). What is missing is exact: **not one of the accused frames' fingerprints
is in a set holding 1 691 of them.**

`setupMessageHandler` records consumption in a private `noteConsumed`, under a docblock stating
"both call sites below reach here" - both call sites of ITSELF. **Four other places hand bytes to
`processIncomingMessage`**, and two spend generations silently:

- the **buffered-message replay** that runs when a Welcome lands (frames held from before the join);
- **`attemptCommitReplay`**, which re-applies missed commits - and whose own comment says a commit
  consumes its generation exactly like a message does.

Both are frames the shared archive also holds, so the replay walks the row later, MLS refuses the
spent generation, and the client reports a permanent loss and asks a peer to reconcile history it
already has. `noteFrameConsumed` in `history.ts` is now the one gesture; the distribution-frame path
records too (cheap insurance, and the direction it can be wrong in is the safe one).

**THE OBLIGATION IS ASSERTED RATHER THAN REMEMBERED**, because "call this too" is exactly what
produced it - the durable rule about a precondition applied to a helper's callers. `historyFrame
ConsumptionSeam.test.ts` enumerates every `.processIncomingMessage(` call site in the tree and fails
unless each records or is listed with the reason it must not. Measured in both directions.

**THE RE-RUN IS DONE (2026-09-07, `__sveltekit_19q322l`, source `6001eadefa09b125`) AND THE ROW IS
STILL `PASS-DIRTY`.** The fix was necessary and is not sufficient, and the re-run narrows what is
left far better than the first run did:

- **The accusations ACCUMULATE by exactly two per run.** Run 3 accuses two rows, run 4 accuses those
  two plus two more, run 5 accuses those four plus two more - exactly the pair of messages W2 sends
  while W1 is down each time. Nothing forgets an accusation; every run re-makes all the earlier ones
  and adds its own.
- **The generations are consecutive and they are W2's**: `Ciphertext generation out of bounds` 11 and
  12 (run 3), 13 and 14 (run 4), 15 and 16 (run 5), all at `msg_epoch=145 group_epoch=145`.
- **W1's durable set holds all six accused ROW keys and NOT ONE of the six frame fingerprints.**
  Read directly out of `localStorage` after the run: 3 511 entries, 1 696 of them fingerprints, the
  six row keys sitting at the very end - written by the LAST run's own accusation, since a run that
  is killed straight afterwards never commits its thunk.

**AND INSERTION ORDER PROVES IT RATHER THAN SUGGESTING IT.** The set is serialised `[...set]`, so
position IS insertion order, and all six accused rows sit at the very END - after entries from
earlier in the same group's history. Had run 3 committed its two, they would appear earlier in the
array, not beside run 5's. They do not. **So runs 3 and 4 wrote nothing durable at all**, while the
generations they consumed stayed consumed - which is the whole claim: the ratchet advanced durably
and the ledger did not. It also explains the missing fingerprints exactly. The six frames were
decrypted SUCCESSFULLY by an earlier run's replay - that is where the generation went - and that
run's marks died with it, so the only durable trace any run ever leaves for them is the row key its
successor writes while accusing them.

**So the cause is the ORDERING, not another silent call site.** The replay's marks become durable
only in the commit thunk at the end of the walk, on purpose, so the ledger never runs ahead of the
persisted ratchet. But the converse is unguarded: `flushEncryptedInternal` is NOT gated by
`bulkIngestDepth` - only `persistNow` is - so any structural mutation during the walk lands a
checkpoint that makes the ratchet durable while the marks are still in memory. Kill the page there
and the ratchet is ahead of the ledger, which is the one direction that manufactures a false loss.
**The fix has to bind the two: the marks belong to whatever writes the checkpoint, so that they
become durable together in both directions.**

**WRITTEN 2026-09-08.** `persistCheckpoint` is the single place this device's state becomes durable,
so it is the single place that may DECLARE something durable - and it already did exactly this for
the send ledger (`snapshotEmitted` / `commitPersisted`). The replay's marks now get the same
declaration: the walk registers a group the moment it marks anything (`noteReplayMarksPending`, at
the mark rather than at the top of the walk, so a checkpoint never rewrites a set nothing touched),
and `commitPendingHistoryMarks` drains it right after the checkpoint write lands. The end-of-walk
thunk is NOT replaced - it stays as the case where no checkpoint fired at all.

**AFTER the write, never before, and the two orderings are not symmetric** - which is the part a
later refactor would get wrong. A ledger ahead of a ratchet SKIPS a frame whose generation was never
spent: a message lost for good. A ratchet ahead of a ledger re-accuses a frame that was in fact read:
noise, and a pointless reconcile ask. Only the second is survivable, so shrinking the window is the
fix and inverting it would not be. The window that remains - a kill between the write returning and
the declaration - is now microseconds rather than a whole archive walk, and it is the same window
`commitPersisted` has always accepted, for the same reason.

**Ten tests, two files, and the decisive one was PROVED to fail without the change** rather than
assumed to: disarming the single registration call makes
`history.checkpointBoundMarks.test.ts::ARE made durable by a checkpoint, with no thunk run at all`
fail and leaves the other five green. `BaseMlsService.checkpointLedgers.test.ts` pins the seam
itself - that the declaration happens, that it FOLLOWS the write, and that a write which THREW
declares nothing.

**AND THE MEASUREMENT IS IN: IT DID NOT CLOSE THE ROW.** TAB-3b re-run 2026-09-08 01:52 on
`__sveltekit_1bh2y1p` (source `c74d156d347d`, the estate verified to be serving it), five cold starts
on a swept estate: **`PASS-DIRTY`, and the accumulation is UNCHANGED** - run 2 accuses two rows, run 3
those two plus two more, run 4 six, run 5 eight, generations 7 through 14 all at
`msg_epoch=165 group_epoch=165`. The catch-up is 61 648 / 61 680 / 61 756 ms, a 108 ms spread, so the
60-second timer is unchanged too and the board's 77.7 s outlier still does not reproduce
(`reproducedTheOutlier: false`).

**So the fix is NECESSARY AND NOT SUFFICIENT, and it must not be recorded as more than that.** What it
closes is a real window - a checkpoint mid-walk no longer leaves the marks behind - and that window is
evidently not the one this row falls into.

**WHAT THE RE-RUN NARROWS, and it is a contradiction worth stating plainly.** A row already in the
seen set is SKIPPED at the top of the walk (`if (seenCipherHashes.has(rowKey)) { advancePast; continue }`),
and the accusation path adds exactly that row key before it warns. So run 5 re-accusing run 1's rows
proves those marks are not durable when run 5's replay hydrates - **while the 2026-09-07 reading found
all six accused row keys present in the durable set.** Both cannot hold, and only one of them was taken
from a build carrying this change.

**THE NEXT MEASUREMENT IS THAT SET, READ BETWEEN TWO COLD STARTS**, and it is the whole question: does
the accusation's mark reach `localStorage` at all in this scenario? Two candidates, and they want
opposite fixes:

1. **no checkpoint fires between the accusation and the kill.** The page is idle for the whole 62 s
   wait, and the checkpoint the arriving message triggers races the runner's kill two seconds later.
   If so the mark needs a durability path that does not depend on a checkpoint at all - which is SAFE
   for this mark specifically, because a row key on an UNREADABLE frame asserts *"I walked this row"*
   and not *"I consumed its generation"*, so unlike a fingerprint it has no ratchet to run ahead of;
2. **the write happens and the next start does not read it back.** Then the fault is in hydration or
   in the 5 000-entry cap, and nothing about checkpoints would help.

**A CDP probe of W1's `localStorage` HUNG twice while trying to settle this** - the same hang the
harness has met before - so the read needs a route that is not `evaluate` on a live client. That is the
next step, and no further code should be written for this row until it answers.

**THE PROBE IS NO LONGER BLOCKED - THE READ WORKS AND IS AN ATOM (`seenset.mjs`, 2026-09-08).** The
hang was in HOW it was asked, not in the client. `Runtime.evaluate` hands back a remote object handle
for anything structured, and paging a 4 800-entry array through one is where the wait came from;
returning `JSON.stringify(...)` from inside the page makes the answer a primitive that arrives whole
in the first reply. Attaching with `focus: false` is the other half, so the read is safe to take while
something else is being measured - which is the only time its answer is interesting. Three reads, no
hang.

**AND IT REFUTES THE CAP AS THE EXPLANATION, WHICH WAS CANDIDATE 2.** W1, group `2bd5add9`, read
immediately after a TAB-3b run that had just accused three frames:

```
2bd5add9   4835 entries (2073 frames + 2762 rows) = 96.7% of the 5000 cap
needle 7e:1kk0lis: ABSENT from every ledger on this client
needle 5p:1xc4y4j: ABSENT from every ledger on this client
needle 5p:1jxfhal: ABSENT from every ledger on this client
```

The set is BELOW the cap, so nothing was evicted, and hydration plainly works - 4 835 entries were
read back. **The three accused fingerprints were never written at all.** That leaves candidate 1: the
mark does not reach `localStorage` in this scenario, and the fix has to be a durability path that does
not wait on a checkpoint. It does not say WHICH path spent the generations without recording them,
and that is the next question rather than a settled one.

**AND TAB-3b IS THE SAME DEFECT, MEASURED WITH A COUNTER THAT MAKES THE MECHANISM UNAMBIGUOUS
(2026-09-08).** TAB-3b takes W1's window DOWN and UP - `down 2ms, up 316ms` in its own per-run line -
so its five "reloads" are five COLD STARTS, which is this entry's scenario and not a page reload.
Read across the five, the accusation set grows by exactly three generations per start and re-accuses
every earlier one:

```
r2:  47,48        19
r3:  47,48,49,50  19,20
r4:  ...,51,52     ...,21
r5:  ...,53,54     ...,22
```

Two sender leaves, two frames from one and one from the other per cycle - the shape of a peer's
message plus its read receipt plus a third device's read watermark. **The accusations therefore grow
QUADRATICALLY in cold starts**, and each pass fires `[HISTORY_RECONCILE] asked 2bd5add9... whether we
hold the same history` - the loudest thing the app does, once per start, for frames it already holds.

**THE INCONSISTENCY, STATED EXACTLY, BECAUSE IT IS NOT THE ONE THIS ENTRY ASSUMED.** If neither the
mark nor the ratchet advance survived, the next cold start would restore a state where the generation
is UNSPENT and the frame would decrypt. It does not decrypt - `SecretReuseError`, at its own epoch.
**So the advance IS durable and the mark is NOT**, and that is the whole defect: the two are supposed
to be tied to one checkpoint, and the mark's commit is a thunk the caller invokes AFTER the flush.
Everything that dies in the window between them keeps a durable advance and loses the record of it.

**WHY THE OBVIOUS FIX IS THE OPPOSITE DEFECT.** Writing the mark eagerly - which is right for a ROW
key, as this entry already argues, because *"I walked this row"* has no ratchet to run ahead of -
is wrong for a FINGERPRINT: a fingerprint asserts *"I consumed this generation"*, and one written
before the advance is durable tells the next replay to SKIP a frame nobody has read. That trades a
false accusation for a silent real loss, which is strictly worse.

**SO THE ANSWER IS ARCHITECTURAL AND IT IS ATOMICITY, NOT ORDERING.** The mark and the advance are one
fact and must be one write - the mark belongs INSIDE the checkpoint, or the question *"have I already
consumed this ciphertext"* should be answered FROM the MLS state instead of from a parallel ledger
that can disagree with it. A ledger beside the ratchet duplicates what the ratchet already knows, and
every defect on this entry is the two copies drifting. **No smaller fix should be attempted**: this
was measured with the cap and hydration both exonerated (`seenset.mjs`), so there is nothing cheaper
left to try.

**WHAT IS STILL UNMEASURED** is which path spends the three generations - live delivery, the queue
drain, or the archive replay's own successful pages. A persistent console tailer CANNOT answer it: the
row destroys the CDP target it would be attached to, which is how the cold-start reading above was
found in the first place. It needs a purpose-built reproduction that brings W1 down between a known
send and a known decrypt, not a tail of TAB-3b.

**TWO GROWTH HAZARDS THE SAME READ SURFACED, NEITHER PREVIOUSLY MEASURED.**

1. **The cap is shared by two namespaces and the wrong one is winning.** `frames` are ciphertext
   fingerprints and mean *"I consumed this generation"*; the rest are message ids and mean *"I walked
   this row"*. Both go into one array capped at 5 000 and `saveSeenCipherHashes` keeps the LAST 5 000
   - so on the busiest conversation **2 762 message ids are crowding out 2 073 fingerprints**, and the
   first thing evicted will be the marks whose loss produces exactly the accusation above. The other
   168 groups on the same client hold 3 to 7 rows each, so this is a property of a long conversation,
   not of the design being wrong everywhere.
2. **The cap is PER GROUP and nothing bounds the number of groups.** 169 ledgers on W1, 247 kB. That
   is comfortably inside the origin quota today and the arithmetic is the point: 169 groups at the cap
   would be several megabytes, against a quota of 5-10 MB. **The failure is silent by design** -
   `saveSeenCipherHashes` catches the write error and warns that *"this replay is repeated in full
   next time"*, which is a permanent regression to re-walking history on every boot, reported once per
   failed write at `warn`.

**AND THE CATCH-UP IS A TIMER, WHICH IS A SECOND FINDING THE ROW WAS BUILT TO SURFACE.** Five cold
starts took 61 863 / 61 865 / 61 889 / 61 930 / 62 019 ms to show a message sent while the browser
was down - a **156 ms spread over five runs**. A duration that stable is not work, and the board's
unexplained 77.7 s outlier did not reproduce. Something waits about sixty seconds before an offline
device is given a message the server already holds; `PHASE_STUCK_MS` is 60 s but only REPORTS, so it
is not that. Worth a row of its own: on a phone this is a minute of an empty conversation.

The ledger that should prevent it is `seenCipherHashes` (`utils/chat/history.ts`), which IS durable -
localStorage, capped at 5 000 - and the unreadable path does `seenCipherHashes.add(rowKey)` before
warning. But the save is a THUNK returned to the caller and committed only "AFTER the encrypted
checkpoint flush", deliberately, so the cursor never runs ahead of the persisted ratchet. **A session
that ends before that flush keeps the accusation and loses the record of having made it**, which is
exactly what five cold starts manufacture.

**THE SECOND HALF IS ANSWERED AND FIXED, 2026-09-06.** The duplicate delivery is gone and its cause
was not subtle once the population named it - the race is SCHEDULED, not incidental. `onDrainEnd`
acknowledges the rows it just drained with a `void`ed `ackMessages(ackIds)`, and then, in the SAME
TICK, `refetchFramesLeftBehind` calls `void this.fetchPendingMessages()` whenever a Welcome landed.
The server has not recorded the ack yet, so it lists those rows again and the device meets its own
frames a second time. **`HEAL-NEW-1` is what made it certain**: an equally empty store, the same
pull, and no duplicate - because nothing was online to deliver anything, so there was no drain, no
ack and no re-fetch.

The fix deletes the overlap rather than tolerating it, which is what WP-DUPDELIVERY-1 did to the
mirror-image race in 2026-08: every ack now goes through `announceAck`, which chains them and
publishes `ackInFlight`, and `fetchPendingMessages` awaits it before pulling. **Fire-and-forget was
never the problem and is kept** - a drain must not wait on a round trip - it was fire-and-forget
*unannounced*. A FAILED ack deliberately does not hold the pull: the server really does still hold
those rows, so a pull that lists them again is telling the truth. Asserted in
`BaseMlsService.ackBarrier.test.ts` on the ORDER rather than on a count, since a count would pass on
a sleep.

One thing is still owed on the FIRST half: whether the thunk is reached at all on these runs -
`[QUEUE] delivery ... arrived twice`
(**seen four times on 2026-09-05, and the three new ones narrow it**: TAB-3b, then HEAL-REVOKE-9 and
HEAL-REVOKE-2 on a device that had just been WIPED and logged back in, then HEAL-REVOKE-3 on a device
FRESHLY MINTED and never revoked at all. So it is not the tab-leadership path TAB-3b exercises - one
tab reproduces it - and it is not revocation either: **what the three have in common is a client with
an EMPTY store pulling a backlog it has never acknowledged before**, which is where an ack still in
flight has the most rows to race. On each of those three rows, once the row's own noise was named, it
is the ONLY dirt left, so this one line alone holds three cells at `PASS-DIRTY`. **It is deliberately
forgiven on none of them**: a row made clean by widening a needle is worse than one reporting
honestly, and a defect costing three cells is easier to justify fixing than one nobody can see)
recognises one class of duplicate and acknowledges it without decrypting, so this one took a
different path. **A race that heals cleanly is still a defect**, and this one heals by asking the
peer for history it already has.

### P2 - the MESSAGE store has the same stale device key the MLS persister just lost, and nothing has measured it (found 2026-09-07, NOT reproduced)

**The MLS half is fixed and this half is the same shape, untouched.** `setupMessageHandler`
destructures `deviceKeyB64` from its deps once, at login, and hands that value to everything that
seals a message: `storage.updateMessage(..., deviceKeyB64)`, `storage.saveMessages(..., deps.device
KeyB64)`, and `republishKeyMaterial(deps.deviceKeyB64)`. `performPinChange` re-encrypts every stored
message under the new key and calls `setDeviceKey`, but it cannot reach that closure - so a message
arriving AFTER the PIN change is sealed with the key the store has just been migrated off.

**WHY IT IS FILED AND NOT FIXED HERE.** The MLS fix had one owner to move the key to - the service
whose state is being sealed. The message store has no equivalent: the key is threaded to the storage
API from every call site that writes, and picking the owner is a design decision rather than a
mechanical change. Doing it badly would be worse than the defect, which is recoverable.

**WHAT WOULD SETTLE IT, and it needs no phone:** change the PIN in W1 with the conversation open,
have W2 send one message, then reload W1 and see whether that message renders. If it does not, the
entry is a P1 and the message is unreadable rather than merely mis-sealed. The rung already exists -
the PIN rows are the four the board keeps last precisely because they change a PIN.

**Its sibling is fixed**: the persister no longer holds a key at all, `CHANGELOG.md` carries the
account, and [durable-rules](durable-rules.md) carries the rule both halves are instances of.

### P3 - HEAL-W2's break cannot take, because the live client writes its MLS state back over the restore (measured 2026-09-06)

The row makes a group unknown by restoring an MLS blob that predates the join. On `60432d09` the
restore is immediately undone: `digest after restore` and `digest after reload` differ, which is
exactly the discriminator the runner already carries - **the live app checkpointed its in-memory
state back over the restored blob before the reload**. `brokeForReal: false`, so it records
`SETUP-FAILED` and asserts nothing downstream. That refusal is correct and is not the work.

**THE WORK IS ARRANGING FOR NOTHING TO BE EXECUTING BETWEEN THE RESTORE AND THE LOAD**, and the two
obvious ways do not survive contact:

- park the page on `about:blank` first - the origin changes, so `mlsdb.mjs` can no longer reach the
  `localhost:8081` IndexedDB it has to write;
- `Emulation.setScriptExecutionDisabled` - freezes the page's own scripts, but the restore tool
  drives the same page through `Runtime.evaluate`, which it would also be freezing.

A same-origin document that boots no app (a static text path) is the shape that satisfies both
constraints, and whether IndexedDB is scriptable from one is the thing to measure before writing it.

**AND A SECOND, INDEPENDENT GAP IN THE SAME ROW**: `markerReason: UNRESOLVED GROUP ID` - the runner
could not map the group NAME to its uuid, so the awaiting-history marker could not be read for the
group under test even if the break had taken. Two fixes, not one, and neither is the app.

### P2 - FIVE rows watch a responder heal a device that no longer needs one, and the rung has to be redesigned around a group the device cannot self-serve (four HEAL-NEW 2026-09-06, MULTI-9 2026-09-07)

**MULTI-9 IS THE FIFTH, AND IT IS THE SAME MECHANISM SEEN FROM THE MEMBERSHIP TABLE.** The row asks
what a message sent to a `pending` device is worth once that device activates - written after a
device sat `pending` for 134 minutes while messages were accepted, fanned out and lost. Measured
2026-09-07, on its FIRST EVER EXECUTION (`roster.mjs` had died at module load since it was written):
the new device reached `active` in **105 ms**, with the peer deliberately killed, because the owner
held FIVE devices in that group and one of them committed the add immediately. There is no window to
send into, so all 5 of 5 messages arrived at an ACTIVE membership and the row proved nothing about
its own question.

It records `VACUOUS` for exactly that case - the sole unmet expectation being the window itself -
and never for the two failures it must not absorb: a device that never activates, and a message
lost in a window that DID exist, are separate expectations checked first. Recording `FAIL` would
have been the board accusing the product of the fix that closed the window.

`HEAL-NEW-11`, `-12` and `-15` were written for a product where a fresh device sat AMBER until some
member served it. They wait up to 90 s for an "amber alone" state, then start the responder, then
watch it heal. On `c643a411` that state never arrives:

```
 11 749ms  the client is LIVE on /chat - the mint hands over
102 008ms  never went amber alone within 90s: rows 36, ready 36, syncing 0   (+90 114ms)
102 008ms  starting the late responder w1
133 992ms  watching the sidebar ...  settled (+3ms)
```

**HEAL-NEW-1 is the measurement that explains it, and it is a PASS**: with the phone force-stopped,
both browsers down and the GATEWAY confirming `extra: []`, a fresh device reaches **36 of 36 ready in
8.0 s**. It serves itself through the external-join seam - `roster seat with NO queued Welcome and NO
add in flight - nobody owes us anything; serving ourselves`. **A device holding a roster seat does
not need a responder**, so a rung built on watching one arrive has nothing left to watch.

  THE LATE WATCH IS A SYMPTOM, NOT THE FAULT, and this matters because the runner already carries a
  comment about having fixed a 49 s lateness by moving work below the watch. It is 122-166 s now, and
  every extra second of it is the 90 s amber poll plus the responder boot that the dead premise makes
  the row wait for. Fixing the arming point would not make these rows observable; it would only make
  them fail faster.

**WHAT WOULD MAKE THE QUESTION ASKABLE AGAIN is a group the device CANNOT let itself into** - one it
is owed a Welcome for rather than one it holds a seat in. The product distinguishes them in its own
log (`already in tree for <id> - skip (will join via queued Welcome)` against the self-service line
above), so the discriminator exists; what does not exist is a fixture that puts the subject in that
state deliberately. That is the piece of work, and it is a rung redesign rather than a row edit.
**Deliberately NOT rescued with a second probe**: `healnew.mjs` says `never a PASS over an unasked
question, and never a second probe invented to rescue it`, and clicking a healed sidebar to report a
number would be exactly that.

**THE WINDOW CAME BACK ON 2026-09-08, ONCE, AND NOTHING HERE EXPLAINS WHY - so this entry stands.**
All three rows passed clean on `9cf5191cc` with `healed: true` and `watchOpenedAfterLiveMs` of
**24.2 s** against the 122-166 s above, which is the signature of the amber-alone state arriving
promptly instead of never: the row is no longer paying the 90 s poll it used to lose. The board cells
are updated because a verdict is a verdict and the runs were clean and unchanged. But **one record
is one draw** - the tool that would say otherwise now exists (`rows.mjs` reports a row that answered
twice on one build) and it has ONE record for each of these - and a premise that returns without an
explanation is not a premise that has been restored. Two things are owed before this closes: WHY the
device sat amber here when it self-serves in 8 s on HEAL-NEW-1, and a re-run that shows the window is
reliable rather than lucky. Until then the fixture described above is still the piece of work.

**~~A SEPARATE AND SMALLER RIG DEFECT SAT UNDER `HEAL-NEW-2`~~ - FIXED, AND THE ROW PASSES
(2026-09-07 19:14, `unmet: []`, 4 of 4 rows in the subset, all ready).** It was `INVALID` on `W2
shares no group with this device's 0 row(s)`: the subset was `splitBySubset(before.tiles, ids)` with
`before = await sidebar(cx)` read moments after the mint handed over - `rows: 0, tiles: []` - so the
question *which of my rows can this responder serve* was asked of a device that had none yet and
could only answer "none". **HEAL-NEW-12 was the control that proved it an ordering fault and not the
account's membership**: same computation, same peer, 4 of 36 rows in the subset, because a LATE
responder is measured after the device has enumerated. The subset is taken against what the device is
OWED (`activeGroupIds`, the server's list), which answers the same before the first tile is painted
as after the last. **The verdict was three days older than the fix, which is the reusable lesson: a
row whose instrument changed is not a row that has been re-measured, and `rows.mjs` says which those
are.** The four rows above are untouched by it - their premise is still gone.

### P2 - the leader tab does not render a message the follower tab sent, until it re-reads (measured 2026-09-05)

TAB-4b: with two tabs of one account open, a message sent from the SECOND tab renders there, reaches
the peer, and does NOT appear in the first tab - `counts.tab1: 0`, against `tab2: 1, peer: 1`. The
reverse direction works (TAB-4c measured `tab2: 1` for a message sent from the first tab), and an
inbound message reaches both (TAB-4a). It is not loss: a reload of the leader shows it, so the row IS
persisted - measured directly, the message survives closing the follower and reloading.

What is missing is a live fan-out. `tabMessageSync` carries three events - `outbox_flush_request`,
`outbox_entry_sent`, `outbox_entry_cancelled` - and the second is a STATUS echo: the follower uses it
to settle a row it already shows (`patchStatus` needs `findMessage` to succeed). There is no
"a message was composed" event, so the sibling tab has nothing to render from. The symmetric fix is
one more event carrying the optimistic row; the throttle question is whose copy wins if both tabs
hold one.

The row does not assert it - TAB-4b expects the sending tab and the peer - so this is recorded rather
than failing a cell.


### P1 - twelve of sixteen messages were FETCHED AND DROPPED, and the commit log has a PERMANENT HOLE at epoch 121 (measured on prod 2026-09-02)

**Reported by the user as an impression - *"j'ai l'impression de n'avoir qu'une petite partie des
messages qu'il m'envoie"* - and it is exact.** DM `7da231f8-119c-4ce2-884f-55f5c94c903f`, created
2026-08-27, two members (`d82cd226...` / `0acc3ab9...`), not deleted, `activeEpoch` 130.

**What was sent, against what the phone shows** (Paris time; server rows are UTC + 2):

| When | Sent by the peer | Displayed on the Android phone |
| --- | --- | --- |
| 30/08 15:11 | 1, from his iPhone | **0** |
| 02/09 10:44 | 6, from a `pending` web device | **0** |
| 02/09 11:28 | 2, from his iPhone | 1 |
| 02/09 13:10-13:11 | 7, from his iPhone | 3 |
| **total** | **16** | **4** |

**Twelve is a FLOOR, not a total.** `queued_message` is a queue, so only sends still holding an
undelivered copy on one of the four stale web sessions can be audited at all - nothing before 30/08
is measurable. The phone FETCHED all sixteen: its queue for this group is empty, it is `active`, and
it was still being fanned to in other groups at 11:16 the same day. **Every loss is therefore after
the fetch.**

**The ciphertexts are still on prod** (`proto` non-null, 3-4 copies each, in the web sessions'
queues), and they are NOT recoverable through them: [group.rs](../../frontend/mls-core/src/group.rs)
sets `max_past_epochs(2)`, so only the 13:10 batch (epochs 129/130) is still inside the phone's
retention window and two further commits close it for good. The one path that recovers them is the
diff against the peer's iPhone, which holds the plaintext.

**FOUR DEFECTS, ALL FOUR FIXED 2026-09-02 - and the entry stays open, because the fixes stop the
NEXT loss and recover none of these twelve.** (C) and (D) each lose messages on their own, (A)
strands a device at an epoch nothing can ever refill, and (B) turned all three into a timeout instead
of an answer:

- **(A) THE CATCH-UP LOG IS BEST-EFFORT WHILE THE EPOCH ADVANCE IS AUTHORITATIVE, and that is why
  epoch 121 does not exist.** `mls_commit_log` for this group runs 0..129 with **121 missing**:
  epoch 120 committed 31/08 16:00:12, epoch 122 on 01/09 02:29:46. `IDX_mls_commit_log_group_epoch`
  is UNIQUE on `(groupId, baseEpoch)`, so **nothing can ever fill it**, and any device stopped at 121
  is stranded for the life of the group. The cause is the commit path in
  [messaging.service.ts](../../apps/chat-delivery-service/src/services/messaging.service.ts): the
  comment claims the insert happens "UNDER THE LOCK (atomic with the advance)", but it sits OUTSIDE
  the `transaction(...)` that advanced `activeEpoch` four lines above, wrapped in `try`/`catch` ->
  `logger.warn`, with the reasoning spelled out - *"Storing is best-effort: a failure must not undo
  the accepted epoch advance."* **The inversion IS the defect**: the record that makes the advance
  survivable for every other device is optional, while the advance is not. And `if (body.proto)` is a
  SECOND path to the same hole - a commit carrying no `proto` advances the epoch and records nothing
  at all, without even the warning.
  **FIXED 2026-09-02.** The insert is inside the `transaction(...)`, so the advance and the record
  that makes it survivable share one fate, and a commit carrying no `proto` is refused with a 400
  before anything moves. A rejected commit costs the committer one round-trip, a lost one costs the
  conversation. Two tests in `messaging.commit-log.spec.ts`: a rejecting insert fails the whole
  commit and fans nothing out, and a protoless commit advances no epoch.

- **(B) `getCommitsSince` ANSWERS "IS THE FLOOR TOO HIGH" AND IS ASKED "IS THIS REPLAY APPLICABLE".**
  Same file. It computes `belowFloor` for a gap at the START and returns every row at or above
  `sinceEpoch` untouched. A hole in the MIDDLE passes that check: a device at 120 receives
  `[120, 122, 123, ...]`, `belowFloor` is `false`, and
  [commitReplay.ts](../../frontend/src/lib/utils/chat/commitReplay.ts) applies 120, fails on 122,
  breaks, and returns `healed=false`.
  **This is NOT a permanent stranding and the first draft of this entry wrongly said it was**: the
  group stays in the epoch-gap registry, and `sessionWatchdogs.ts` forces the forget + re-Welcome
  once `STUCK_EPOCH_GAP_MS` has passed. So the hole is survivable - **by a CLOCK**, after a failed
  decrypt, a wasted round-trip and a frozen outbox, when the server could have said so in the
  response it was already writing. That is the rule about never learning by failing what a fact could
  have told you, and a termination that is a budget rather than a proof.
  **FIXED 2026-09-02.** `getCommitsSince` walks for contiguity from `sinceEpoch`, truncates at the
  first hole and names it as `gapAt` - from either end, a hole in the span or a log stopping short of
  `activeEpoch`. `belowFloor` suppresses it, PRUNING and a HOLE being different defects and only one
  of them accusing anybody. `attemptCommitReplay` treats `gapAt` as terminating and applies nothing;
  `setupMessageHandler` escalates to rung 2 on that proof instead of after `EPOCH_GAP_ESCALATION_MS`,
  which is where the frames arriving during those 30 s were being ACKed and dropped.

- **(C) A SEND FROM A `pending` DEVICE IS ACCEPTED AND FANNED OUT TO EVERYONE.** `status = 'active'`
  gates recipient resolution twice in that file, and nothing gates the SENDER. The peer's
  `web-...-mtbep8vs-5oxb` is `pending` in this group - registered 2026-08-27, still holding two
  undelivered Welcomes queued 02/09 at 11:07 and 11:10 - and it sent six messages between 10:44:20
  and 10:44:44 that were fanned to five devices: **30 rows of ciphertext nobody in the group can ever
  open**, the device not being in the MLS tree. The server held the discriminator at the moment it
  accepted them, which is the rule about never learning by failing what a fact could have told you.
  **FIXED 2026-09-02.** `sendMessage` reads the sender's own membership row before resolving any
  recipient and answers `403 sender_not_active` with the status, so the client learns the fact the
  server already held. Handshake frames (Welcome, Commit) are exempt - they are the path OUT of
  `pending`, and refusing them would make the gate a deadlock. A missing row is logged, not refused:
  that is an external join in flight.

- **(D) A DEVICE EMITS APPLICATION MESSAGES BETWEEN ITS OWN COMMIT AND THAT COMMIT'S ACCEPTANCE.**
  Measured to the millisecond, `mls_commit_log` against `queued_message`:

  ```
  13:10:43.234  commit baseEpoch=128
  13:10:43.270  message                 36 ms later
  13:10:44.302  commit baseEpoch=129
  13:10:45.120  message
  13:10:47.480  message
  13:10:51.901  message
  13:10:53.965  message
  13:10:58.783  message
  13:11:00.750  message
  ```

  Seven messages racing two epoch advances the peers cannot have applied yet; three arrived, four did
  not. A race that heals cleanly would still be a defect, and this one does not heal.
  **FIXED 2026-09-02.** [epochSendBarrier](../../frontend/src/lib/utils/chat/epochSendBarrier.ts):
  a frame is encrypted AND on the wire before a local commit starts, or it is encrypted after that
  commit merged. There is no third ordering and no clock in it. The barrier is raised only under the
  MLS mutex, which is what makes it deadlock-free - a send that observes it provably does not hold
  the mutex the advance needs. The overlap is deleted rather than reconciled: a re-encrypt-on-stale
  retry would have been a race that heals cleanly, which is still a defect.

**WHICH ARM OF `process_message` DROPPED THE 13:10 FOUR IS NOT ESTABLISHED, and the logcat cannot say
retroactively.** The buffer on the Pixel 6a spanned 08-31 17:57 to 09-02 14:40, but the app's OWN
lines reached back only to 14:33 - the 13:10 window was already gone. Settling it needs a reproduction
with `clearLogcat()` first, through
[phone.mjs](../../tools/cross-client-harness/phone.mjs) (`console_`, `clearLogcat`) and the tag list
in [verify-on-device.py](../../tools/android/verify-on-device.py) (`LOGCAT_TAGS`). **Do not write a
fix against a suspected arm** - the candidates in
[messaging.rs](../../frontend/mls-core/src/messaging.rs) are the epoch-gap fast-fail, the past-epoch
application arm and the same-epoch refusal, and they carry different fixes.

**And the UI asserts the opposite of the truth**: "Infos de la discussion" shows a green shield
reading "SÉCURISÉ & SYNC" on this conversation, with twelve messages gone. A device that dropped an
application frame must say so there.

**WHAT IS STILL OPEN, none of it closed by the four fixes:** the twelve messages themselves, whose
plaintext exists only on the peer's iPhone; the hole at epoch 121, which is permanent by construction
and now merely *survivable at once* rather than after 30 s; the arm of `process_message` above; the
green shield below; and the two entries after this one, which are what would have named all of it
without a user's impression.

**State left on prod: NOTHING was modified.** The four stale web sessions still hold 87 undelivered
message rows since 30/08, one of them (`web-...-mtd1d1fc-m84y`) 96 commits behind and therefore
permanently stuck below the 121 hole. The peer's second iPhone (`tauri-...-mtc0al5c-9hny`) has been
`pending` since 2026-08-27 with zero one-time KeyPackages - the same signature as the Welcome livelock
P1 below, and the two want reading together.

---

### P2 - nothing measures a RE-KEY RATE, and nothing would ever report a HOLE in a commit log (2026-09-02)

**129 epochs in six days on a TWO-PERSON DM, and no mechanism said a word.** Group `7da231f8` above:

| Window | Epochs | Committer |
| --- | --- | --- |
| 30/08 02:43 -> 03:31 | 89 -> 104, **16 commits in 48 minutes** | one web session |
| 30/08 04:22 -> 06:36 | 105 -> 116, 12 commits | the Android phone |
| 31/08 -> 02/09 | 118 -> 129, 12 commits | both peers |

Every commit is a re-key, every re-key is an epoch a lagging device must cross, and this churn is what
makes the P1's four defects fire at all. Nothing counts commits per group per hour; nothing counts
sends that are undecryptable by construction (defect C produced thirty such rows in 24 seconds); and
nothing detects a gap in a commit log - one `GROUP BY` would have named epoch 121 on 31/08.

**Owed:** a counter on the fanout for undecryptable-by-construction sends, and two lines in the hourly
report - commits per group per hour, and any hole between `min(baseEpoch)` and `activeEpoch - 1`. A
correct mechanism with no report is found by hand a day late; this one was found by a user's
impression, four days late.

---

### P3 - the phone prints eight warning lines a minute that mean nothing, and polls presence every ten seconds (measured by logcat 2026-09-02)

Read off the Pixel 6a with `adb logcat` - 147 app lines over seven minutes of an otherwise idle
session:

- **56 occurrences of `[WS RCV] frame type "pong" reached no handler - the server is sending
  something this client does not route (see channelEventTypes)`**, at **W** level. A keepalive pong is
  expected and needs no handler, so the line is the visible end of either a server routing it as a
  payload frame or a client that should consume it silently. At WARN it pollutes exactly the level a
  reader scans for real defects.
- **45 `GET /api/presence` in seven minutes** - one every ten seconds, on a mobile client that already
  holds a live WebSocket. A clock where a push belongs, and it costs battery and data on every phone.

Both fall under the rule that noise is never acceptable: a line is either expected AND necessary, or
it is the visible end of something upstream. The first is also part of why the P1's 13:10 window was
no longer in the buffer when it was needed.

---

### P2 - a device holds a distribution group the group holds no row for it, and heals by rejoining (measured 2026-08-29)

**Handed back by HEAL-NEW-15's branch on `038c7e8d`, deliberately unacted on because its blast radius
leaves that row.** Sixty seconds after external-joining the community distribution group `315b8a1d`
at epoch 56, the fresh device logged:

```
this device holds the distribution group but the group holds NO row for it (3 device(s) for this user)
 - the local group is stale, rejoining
```

and joined again at epoch 57. **A race that heals cleanly is still a defect**: if the mechanism needs
a heal in THEORY it is wrong whatever it does in practice, and the thing to find is what makes the
two paths overlap, not to admire the repair.

**Two facts from the same run belong with it and may or may not be one cause.** `315b8a1d` is the
ONLY group of eleven the reconciliation did not ask about - `reconciliation pass complete - 10/11
group(s) asked in 794 ms` - and it is also the only group that was external-joined twice, at 56->57
and 57->58, both before the late responder arrived. Whether the skipped reconciliation is a
CONSEQUENCE of the membership row being absent, or a second symptom of the same stale local state, is
undetermined and is the first question to ask. **Do not assume the correlation is causation**; one
`GROUP BY` over `dm_device_group_memberships` for this device and this group settles which row
existed when.

**RECURRED ON BOTH ROWS OF THE 2 / 12 PAIR, same build `038c7e8d`, so it is not a one-run
coincidence and the population is "every freshly minted device", not "a device that waited for a late
peer".** Stamps, which is all these two rows owe it: row 2 logged the stale-group line at 15:09:47
and `externalJoin succeeded for 315b8a1d...` at 15:09:48; row 12 logged both at 15:14:31. In both,
the community is `fbddc890` and the device count in the line is 3. **Two of the reading conditions
differ from row 15's and rule nothing out:** each of these rows external-joined `315b8a1d` TWICE and
no conversation group at all, and the reconciliation asked 0 of 1 and 0 of 2 rather than skipping one
of eleven - so the "only group the reconciliation did not ask about" correlation cannot be tested at
this fleet size and is neither confirmed nor refuted here.

**RECURRED ON A DIFFERENT RUNG, AND THE DEVICE COUNT IS NOT A CONSTANT.** HEAL-REVOKE-5 on
`96bdd1bb`, 2026-08-29: the wipe window logged the line at 23:00:52 with `(3 device(s) for this
user)` and the reference device logged it at 23:02:55 with `(2 device(s) for this user)` - **two
different counts in ONE run, two minutes apart**, tracking the live device population as devices were
revoked and minted. So the `3` recorded above is not part of the shape and nothing should be read
into it; what is constant across every sighting is the community, `fbddc890`. The population is
therefore wider than "every freshly minted device": a device that RETURNS from a revocation wipe
produces it too, which is a second rung and a second build. Not chased here, per the row's brief.

### P2 - a membership is REFUSED for want of a KeyPackage one second after the device external-joined that very group (measured 2026-08-29)

**It heals, and by the standing rule that is still a defect:** a race that needs a heal in THEORY is
wrong whatever it does in practice, and a ledger that reconciles the two paths afterwards is a
witness, never a fix.

Seen twice in HEAL-NEW-15's run on `dc8bf000` / runner `56090443`, on a device that had been minted
seconds earlier: the client logs `externalJoin succeeded` for a group, and roughly one second later
the server logs `[MEMBERSHIP_ACTIVE] REFUSED ... reason=no_key_package` for the SAME group. The
membership goes active shortly afterwards, so no row went amber for it and nothing in the sidebar
records that it happened.

**What has to be named before a fix is written** is which of the two orderings is the real one - a
KeyPackage published after the external commit, or an activation read that runs before the
publication it depends on has committed. The two are indistinguishable from the refusal line alone,
and this is the second time on this rung that a `no_key_package` refusal has meant something other
than what it said (see the entry below, where it meant the device cap). The discriminator is the
publication's own timestamp against the refusal's, both of which exist.

**It cost nothing here** because W1 was online and serving; the concern is the population where
nothing is. Nobody has measured how often it happens outside this rig.

**RECURRED ON BOTH ROWS OF THE 2 / 12 PAIR, on `038c7e8d`, and the refused group is the SAME ONE the
entry above is about.** Row 2: `[MEMBERSHIP_ACTIVE] REFUSED group=315b8a1d... reason=no_key_package`
at 13:09:20, then `[MEMBERSHIP_ACTIVE] group=315b8a1d...` at 13:09:47 - 27 s. Row 12: refused
13:13:36, active 13:14:31 - 55 s. **In both, the group is the community distribution group and NOT a
conversation**, and in both the client external-joined that same group twice and logged the stale
local group of the entry above within a second of the activation. Two P2s, one group, one second
apart, twice: **treat "are these one defect" as the first question, not two independent
investigations.** The discriminator both entries name is still unmeasured - the KeyPackage
publication's own timestamp against the refusal's.

**RECURRED ON HEAL-REVOKE-5, `96bdd1bb`, 2026-08-29 - same group `315b8a1d`, on the SEED device, at
21:00:41.** This sighting cannot measure the interval the entry asks for: **no `[MEMBERSHIP_ACTIVE]`
line for that device appears in the window at all**, and that is explained by the ROW rather than by
the defect - HEAL-REVOKE-5 revokes the seed roughly ninety seconds later, so the activation had no
opportunity to happen. Recorded so the absence is not later read as a refusal that never healed. The
population now includes "a device minted as a revocation row's seed", which is a third rung.

**And on those two rows the refusal was invisible from the client half.** `healnew.mjs` records only
`observers: { w3 }`; the server window is taken by `run.mjs` per PASS and printed, not written to the
ledger row - so `bun rows.mjs` and every HEAL-NEW cell are silent about it, and it was found by
reading the run's stdout. Nothing here is wrong, but a HEAL-NEW verdict says "clean on the web
client", never "clean on the server".

### P1 - a device asks for a Welcome for ever, and the member that answers RESETS the row that would have let it heal itself (measured on prod 2026-09-01)

> **THE "FOR EVER" HAS A MECHANISM NOW, FOUND ON 2026-09-06, AND IT IS FIXED.** The loop above
> describes a device asking and a responder answering; what nobody had asked was why the ANSWER did
> not land. The delivery service serves a device's static `key_package` row to every caller once its
> one-time pool is empty - the same bytes, until that device next connects - and MLS deletes an
> ordinary KeyPackage's private bundle at the first Welcome built on it. So a device re-entering
> several groups at once could join exactly ONE: the Mi 9T at 18:01:27 got ten Welcomes on one
> fallback, joined the first and answered nine with `NoMatchingKeyPackage [n_secrets=3..5]`,
> nineteen times over. It then re-asked, the responder kicked and re-added it on the same dead
> package, and the loop had no exit. The fallback is now minted with the MLS `last_resort` extension
> (`mls-core/tests/last_resort_key_package.rs`, `CHANGELOG.md`,
> [mls-protocol](protocols/mls-protocol.md#the-two-kinds-of-key-package)). **This does not close the
> entry**: the reset-the-healing-row half and the prod measurement below are untouched, and the
> `[KICK] Stale leaf` sighting is still a device asking for something it should not need. It does
> mean the local reproduction the entry asks for was standing on a second defect the whole time, so
> anything measured before 2026-09-06 was measuring both.

**SEEN AGAIN ON THE LOCAL ESTATE, 2026-09-06 01:03** - the first sighting outside production, and it
is the only line of dirt on an otherwise clean HEAL-REVOKE-5: `[KICK] Stale leaf <the phone> removed
from ba048e26…` on W1. That is the documented answer - a `welcome_request` for a group whose leaf is
already in the tree is kicked and re-added - so the line is W1 behaving correctly and the phone
asking for something it should not need. **The prod measurement this entry is waiting for now has a
local reproduction to be taken against**, which is cheaper to instrument and does not need a
production window.

**AND IT HAS A COST NOBODY HAD PRICED, MEASURED ON HEAL-REVOKE-8 THE SAME NIGHT.** In one run, in
one group, thirteen seconds apart:

```
01:15:09  [KICK] Stale leaf <the phone> removed from d4dc24a2...
01:15:22  [HISTORY_RECONCILE] d4dc24a2... still holds frames it cannot read
          while <the same phone> answers nothing - electing somebody else
```

**A device whose leaf has just been kicked cannot answer a history solicitation for that group**,
and the server's responder election is RANDOM among the members it sees online. So every group
this loop touches carries a member that is elected like any other and is silently a dead end. That
is not a second defect - it is this one's blast radius, and it explains why the history exchange
looked intermittent rather than broken: the run's outcome depended on which member the dice named.
~~**The escalation shipped on 2026-09-06 rotates past a silent responder, so the repair no longer
depends on the election being lucky**~~ - **REFUTED BY MEASUREMENT 2026-09-08, and the reason is one
wire.** That escalation is reached from the REPLAY path only (`history.ts`, once at the end of a
walk); a loss detected LIVE calls the plain coalescing entry point instead, and HEAL-repair's whole
subject is a live burst. So the dice still decide it: ten runs, three builds, **three healed**, with
the window's twenty history requests routed 10 to a member that cannot help, 7 to the only holder and
3 back to the asker. Wiring the live path to the escalating entry point was tried the same day and
made it worse - a per-frame trigger judged the holder silent 200 ms after electing it and excluded
it - so the rotation is not the fix either, and both are recorded as refuted in the HEAL-repair P1
above. What survives from this paragraph is its observation, which was right and is now
quantified: a kicked leaf is elected like any other member and is silently a dead end. It does NOT
close this entry: a dead responder is still a member losing its seat, and the wasted round trip is
real.

> **A FIFTH HALF WAS FOUND ON 2026-09-04 AND FIXED THE SAME DAY, AND IT IS THE ONE THAT MADE THE
> OTHER FOUR UNREACHABLE FOR PART OF THE POPULATION.** Everything above negotiates what a `pending`
> row MEANS; none of it runs for a device whose local WASM still holds the group, because
> `requestReAdd` returns at its `holdsGroupState` guard before any of it is read, the connection sync
> and the SYNC_WATCHDOG both skip such a group, and the watchdog additionally calls `cancelReAdd` on
> it every 5 s. The outbox held the only proof - the server's own `SenderNotActive` - and merely
> logged it. `recoverRosterDisagreement` now converts that proof into the forget the guard asks for
> and re-enters the seam. Measured end to end on the local estate: refusal at 18:28:34, rejoined by
> external commit and the held message sent at 18:28:37, `MEMBERSHIP_ACTIVE` in the server log. Story
> in `CHANGELOG.md`, rules in [durable-rules](durable-rules.md), residual scope in the P2 below.
>
> **ALL FOUR ARE FIXED, 2026-09-04. WHAT IS LEFT IS ONE MEASUREMENT ON PROD AFTER THE RELEASE THAT CARRIES THEM.** `pending` no longer decides anything on its own: the endpoint answers per row with
> `welcomeQueued` and `addInFlight`, a device owed nothing serves itself an external-commit join and
> clears its own seat. **The residual window (A) was not allowed to ship without is closed by
> `addInFlight` - the group's `mls:addlock:<groupId>` held right now - and NOT by the inviter's own
> refusal as this entry proposed**: the lock is held for the whole of the `registerMember` ->
> `addMembersBulk` interval, which is exactly the interval in which the queue is legitimately empty,
> so it needs no second party to answer and no new failure to classify. **It was reproduced first**,
> on the local estate on four groups with the production signature line for line, and then measured
> twice green - two fresh devices each joining all four groups in the same second, rows promoted,
> epochs advanced, fresh bases republished. Tests:
> `invitations.controller.device-memberships.spec.ts` (6) and `recovery.test.ts` (21).
> **(C) IS FIXED TOO, AND ITS CAUSE WITH IT.** The `stale_base` arm no longer asks for a Welcome - it
> asks for a republish, which is read-only, takes no lock and changes no epoch. But the ask was the
> band-aid: the CAUSE is that a base is minted only as a fire-and-forget follow-up to a commit
> (`void refreshGroupInfo`), whose own comment already said the loss was permanent. Measured across
> prod that day: four of forty-three bases stale, every one by EXACTLY ONE epoch. Any holder now
> repairs a stale base on the read it already makes on every connection
> (`GET /mls/users/:id/groups` carries both epochs), one implementation in `staleBase.ts` shared with
> the distribution-group repair, 11 tests validated against three silent mutations. **So the
> `4f87267a` base this entry has been waiting on since 2026-08-30 gets a cure it never had** - it
> heals the next time any member of that group connects, with nobody asking.
>
> **(B), the same day, because (A) made it worse rather than better.** `kickStaleLeaf` cleared the
> routing row whether or not the leaf came out of the tree, and a `pending` row over a LIVE leaf now
> tells that device to external-join beside it - GRP-4 from the other side, the repair manufacturing
> the fault it cleans up. The row is cleared only when the tree is genuinely without the leaf, and
> "the leaf was never there" is a TYPE (`MlsError::NoSuchMember`) rather than a substring of an
> OpenMLS message, because it is the one refusal that means the caller's goal is already met.
> `groupActions.kickStaleLeaf.test.ts` (5) pins the order and was validated in negative against the
> unfixed function; `roster_removal.rs` pins the variant and that the tree is untouched.
> **The `4f87267a` base is a separate matter and is still stale on prod.**


**A LIVELOCK, NOT A WAIT: each side re-creates the other's precondition, and it ran for 20 HOURS on
the owner's own account.** Reported from the web client 2026-09-01: three conversations stuck on the
`SYNC` badge for ever, `[READD] ... throttled` printed every 5 s for each, while the SAME
conversations were healthy on the reporter's phone. Nothing was broken server-side - no tombstone, no
missing roster row, no revocation - and the recovery loop was running exactly as designed.

**The evidence, all of it read on prod before any code was written:**

| Fact | Value |
| --- | --- |
| the enrolling device | `web-d82cd226...-mthfj460-44v8`, first membership rows written 2026-08-31 `16:05:10.586028` |
| its 12 group memberships | **9 went `active` within 3 s**; **3 stayed `pending`** at the registration instant and were never touched again |
| `queued_message` for that device | **0 rows, for any group, at any point** - no Welcome was ever queued for it, before OR after the repair attempts |
| `mls_group_info` for the 3 | present for all three: baseEpoch **283**, **279**, **286** |
| `key_package` / `revoked_device` | one fresh KeyPackage, no revocation - the device was addable throughout |
| `one_time_key_package` | **0** - the same spent-pool hypothesis as the P2 below, still untested |

**THE EXPERIMENT THAT SETTLED THE FIRST CAUSE.** The three `pending` rows were flipped to `active` by
hand at `10:09:37` (an allowlisted UPDATE on that one deviceId, `status = 'pending'` only). Within
90 s, two of the three healed with no peer involved at all:

```
10:10:31  COMMIT bee389a8 baseEpoch=286 -> base published with the commit -> epoch=287 ACCEPT
10:10:31  COMMIT 6e7c9ab1 baseEpoch=279 -> base published with the commit -> epoch=280 ACCEPT
```

So the device could have freed itself at any moment in those 20 hours, and exactly one `if` forbade
it. **That is proof on pieces rather than by reasoning, and it is what makes this a P1 rather than a
suspicion.**

**THE CLOSED LOOP, on the third group (`4f87267a`), read line by line in the delivery log:**

```
10:18:37  WELCOME_REQ FORWARDED -> tauri-...-mtd1qgu3-vnde     the phone receives it
10:18:37  ADD_LOCK    acquired=true                            it takes the lock
10:18:38  [KICK] Reset device web-...-mthfj460-44v8 to pending  it evicts the stale leaf AND RESETS THE ROW
10:18:42  RELEASE_LOCK released=true                            it releases
          (no Welcome queued, no commit - the Add never lands)
10:18:45  WELCOME_REQ FORWARDED -> the same device              and round again
```

`kickStaleDevice` writes `pending` BEFORE knowing the Add will land, and `pending` is precisely what
forbids the requester's self-service external join. **Every turn of the repair destroys the only state
from which the requester could have saved itself**, and the requester's next request re-arms the
repair. Neither side is idle and neither side is wrong on its own terms.

**AND THE ESCAPE HATCH IS LOCKED FROM THE OTHER SIDE on that group**: `mls_group_info` holds baseEpoch
**283** while the group is at **284**, published 2026-08-30 `04:36:47` and never refreshed. The server
says so itself, once a minute - *"the published external-join base is unusable and only a member
holding the tree can refresh it"*. Only a member's COMMIT republishes a base, which is literally what
repaired the other two groups; `4f87267a` has had no commit since. So even with the gate corrected,
that group cannot external-join until somebody commits into it.

**FOUR DEFECTS, each independently sufficient to make the loop infinite:**

- **(A) `pending` is a STATE read as an EVENT.** `readWelcomeOwed` returns "an Add is IN FLIGHT and a
  member owes me a Welcome" on the strength of the row's status alone
  ([recovery.ts](../../frontend/src/lib/utils/chat/recovery.ts), step 6), so `requestReAdd` never
  reaches the external join. The gate itself is legitimate - it is what deleted the GRP-4
  duplicate-leaf race of 2026-08-26 - but it cannot tell "in flight for 200 ms" from "registered
  yesterday and never honoured". **The fact that separates them already exists and is already
  computed, server-side, hourly, by `reportStrandedDeviceMemberships`: is a Welcome actually queued
  for THIS device and THIS group.** It is simply not carried to where the decision is made; adding it
  to the existing `GET /api/mls/device-memberships/:userId/:deviceId` response costs no round trip.
  **The residual question a fix must answer: between `registerMember` and `addMembersBulk` the queue
  is legitimately empty while an Add really is in flight**, so the queued-Welcome fact alone re-opens
  GRP-4 in that window - which is why the inviter's own refusal (the P2 below) is the discriminator
  that closes this properly, and why (A) must not ship as a bare `&& welcomeQueued`.
- **(B) A destructive repair is not gated on the repair succeeding.** The `[KICK]` writes `pending`
  first and attempts the Add after. This is the invariant established the same morning by `f46e7660`
  - **a field written ONCE, after every prerequisite, cannot lose a race for it** - applied to the
  function next door, for the third time in this area. Write the row when the Add lands, or not at
  all. This is the P1 half: it is what turns a failure into a loop.
- **(C) On `stale_base`, the wrong favour is asked.** `requestReAdd` falls back to a `welcome_request`
  for every external-join refusal, including `stale_base` - a reason no retry can ever satisfy. A
  Welcome MUTATES the tree, needs the add lock, and replays the race; refreshing the base is a
  read-only publish by any member holding the tree, needs no lock, changes no epoch, and hands the
  requester back its ability to serve itself. `stale_base` is already classified at the throw; it
  wants its own action, not the shared fallback.
- **(D) The failing `addMember` was reported NOWHERE - FIXED 2026-09-04.** It is swallowed on the
  answering device (a phone), and server-side the row a failed re-add leaves is byte-identical to the
  row of a device whose KeyPackage was skipped and which was never in the tree at all: one footprint,
  two opposite causes, two opposite fixes. `dm_device_group_memberships.kickedAt` is the evidence the
  report was missing - written by the two kick endpoints, cleared by the three writes that answer the
  question the other way (a Welcome queued, or the device marked `active`), and NOT by a demotion,
  which is cleanup and promises no Add. `reportStrandedDeviceMemberships` prints the halves apart:
  *never added* at WARN, *kicked with no re-add* at **ERROR**, dated by the kick rather than by the
  row. It is deliberately not a second `updatedAt`, which moves for every write. The write sites have
  their own spec (`invitations.controller.kick-marker.spec.ts`, 5) because a kick that forgot to stamp
  would make the ERROR half count zero for ever and read as health; the report's split is pinned by 4
  more in `app.controller.stranded-memberships.spec.ts`, validated against two mutations. **It cannot
  be backfilled**, so the first passes report the standing backlog as *never added*.

**Two more, same session, lower severity but in the same seams:**

- **The key-vs-id audit that `f46e7660` did not finish.** That commit fixed three lookups in
  `recovery.ts` and the watchdog and wrote the rule *treat any `[key]` destructuring over a
  heterogeneously-keyed map as a defect on sight* - but never enumerated the consumers. Still reading
  the map by groupId, in a store where a DM learnt from a Welcome is keyed by the PEER'S USER ID:
  `processPendingInvitations` (the readiness gate deciding whether an Add is even attempted),
  `handleWelcomeRequest` (the *"No ready conversation - deferring"* branch, which would decline every
  such request in silence), the history-serving gate, `recovery.ts` in the promotion after a
  SUCCESSFUL external join - which would leave the `SYNC` badge on for ever on a conversation that
  has actually rejoined - and `setupMessageHandler.ts` on the redelivery path. **Unproven as the cause
  of anything above**, the phone's logs not being available, but a defect on sight by the repo's own
  rule.
- **The throttle logs its silent branch.** `[READD] ... throttled` prints on every 5 s poll against a
  60 s cooldown: 12 lines per group per window, on a branch whose own comment says the throttle
  *"returns silently"*. Three stuck conversations made 36 lines a minute, which is what the reporter
  actually saw.

**STATE LEFT ON PROD, 2026-09-01 ~10:20 - a resuming session must not re-derive this:**

- `bee389a8` and `6e7c9ab1`: **healed and `active`**, joined by external commit at epochs 287 and 280.
- `4f87267a`: **still `pending`** (the `[KICK]` of `10:18:38` undid the manual flip) and **its base is
  still stale at 283/284**. It will not heal until a member commits into that group. Flipping the row
  again is pointless on its own - the kick resets it within seconds.
- The manual UPDATE is the only hand-write performed; nothing was deleted, and the fourteen-day purge
  still owns those rows.

**What closes this entry: ONE measurement on prod after the release that carries all four.** The four
stale bases at `activeEpoch`, `4f87267a` among them, taken with
`SELECT ... FROM mls_group_info gi JOIN dm_groups g ...` and no hand-written UPDATE - and one reading
of the hourly report's new ERROR arm, whose count is the first number anybody has for how often the
re-add after a kick fails. (A), (B), (C) and (D) all landed 2026-09-04; (A) already carries the
measurement this line asked for - a device reaching `active` by external join with no peer involved,
taken twice - and (C) was verified end to end on the local estate, four bases armed one epoch behind
and all four repaired within two seconds of a holder connecting. **Production is on `0.16.1`, two
stables behind, so none of this is deployed yet.** The cause of the skipped Add itself is the P2
immediately below, and the two want reading together.

### P2 - a device stranded on a roster seat is only discovered by TRYING TO SEND, so a silent reader stays stranded (measured 2026-09-04, alongside the fix above)

`recoverRosterDisagreement` closes the case where a device holding a group tree the server has no
leaf for **attempts to send**: the refusal is the proof, the outbox holds it, and the repair follows
in about three seconds. **Nothing detects the same device if it never sends.** It holds a
well-formed tree, shows a normal-looking conversation, and is refused nothing, because it asks for
nothing - while every frame the group produces is encrypted to a tree its leaf is absent from.

**The population is real and the server already counts it.** `reportStrandedDeviceMemberships` named
70 pending memberships past its window on this estate, 25 of them holding a roster seat with no
Welcome ever queued and no kick recorded, the oldest since 2026-08-27. The report says *"they
receive nothing and notify nothing"* - which is exactly the half a sender-side repair cannot reach.

**What would close it, and what would not.** A client-side timer that periodically re-asks is the
shape the durable rules refuse: termination would come from a clock, and the ask would be made by
the device least able to answer it. The fact is ALREADY authoritative server-side and already read
on a call every device makes on every connection - `GET /mls/users/:id/groups`, the same read
`staleBase.ts` repairs a stale base on. **Carrying the membership status on that row is the shape
that needs no new trigger**, and it is the move [durable-rules](durable-rules.md) names for the
sibling defect: *never let a repair need a trigger the mechanism does not already have*. That makes
this a server contract change plus one branch in the sync loop, which is why it is not inlined into
the session that found it.

**Do not close it by widening the sender-side seam.** The sender-side repair is correct and
sufficient for what it can see; the gap is a device that produces no evidence at all, and no amount
of classification at the send site can observe a send that never happens.

### P2 - a device was given a roster seat and never a Welcome, and WHY its KeyPackage was skipped is unmeasured (measured on prod 2026-09-01)

**The report is in; the CAUSE is not.** `reportStrandedDeviceMemberships` (hourly, chat-delivery)
now names every `pending` device membership older than an hour with no `queued_message` carrying
`isWelcome = true` for that device AND that group - see
[chat-delivery](services/chat-delivery.md#a-roster-seat-is-not-a-key-and-only-a-welcome-tells-the-two-apart)
for the mechanism and the measurement. What it cannot say is why the inviter's `addMembersBulk`
dropped the device into `skippedDeviceIds` in the first place.

The sighting: a new DM on 2026-09-01, group `ab47add3`. The peer's phone
(`tauri-...mtd1qgu3-vnde`) got its pending row at `20:45:47.420` and no Welcome, while the account's
four other devices each got one. It stayed stranded **3 h 41**, healed itself by external join at
`00:26:54`, and republished its key package at `00:53` with 39 one-time key packages. The user
received the message on a web session (`mthfj460`, active at `20:45:48.309`) and got **no
notification on his phone** - which is the only reason anyone noticed.

**What has to be named before a fix is written**, and all of it is knowable:

- Which KeyPackage the inviter was handed for that device, and why WASM rejected it. `addMembersBulk`
  currently discards the reason with the device - `skippedDeviceIds` is a list of ids and nothing
  else, so the one fact that would classify this is thrown away at the only place it exists.
- Whether it is the last-resort KeyPackage or a one-time one. **All four of the peer's web devices
  showed 0 one-time key packages remaining** at the time, which makes a spent OTK pool the first
  hypothesis to test, not the conclusion - the phone's own pool is the number that matters and it was
  not read before the device healed.
- Whether the 3 h 41 is the external-join ladder's ordinary latency for a device in this state or a
  device that only healed because it happened to be opened. Nothing here paces that heal.

**THE 3 H 41 IS NOW BOUNDED, AND THAT CHANGES WHAT THIS ENTRY IS FOR (2026-09-04).** The heal at
`00:26:54` happened because the device was opened; nothing paced it, and its sibling P1 explains why a
device in that state could go 20 hours instead. With (A) fixed, a device holding a roster seat that
nothing follows joins on its next poll rather than when a human touches it - so the stranding is no
longer a user-visible outage and this entry loses its user-facing half. **What it keeps is the whole
of its question**: a skip that cannot name its own cause. The heal being fast does not make the Add
correct, and a device that external-joins every time is a device whose KeyPackage is being rejected
every time with nobody counting.

**THE POPULATION IS NOW EXACTLY THIS ENTRY'S, 2026-09-04.** The hourly report used to lump this
cause together with a device whose leaf a member kicked and failed to re-add - same footprint,
different fix. `kickedAt` separates them, so the WARN arm named *never added* is now this entry's
population and nothing else's, and its count is the number a fix has to move.

**Until the reason is typed, the skip is a count.** The rule that a skip printing a count cannot name
its own cause applies exactly: `warnSkippedKeyPackages` prints ids, and the two causes it collapses -
a genuinely unusable KeyPackage and a device whose pool is momentarily empty - want opposite fixes
(reject and re-mint, versus wait and retry). Carry the reason out of the WASM boundary alongside the
id, then the server report can partition on it instead of on the queue.

### P2 - a HEAL verdict says "clean on the web client" and never "clean on the server" (measured 2026-08-29)

**Instrument debt, and it qualifies every verdict this rung has taken.** `healnew.mjs` and
`healrevoke.mjs` record `observers: { w3 }` and nothing else. The server window IS taken - `run.mjs`
does it per pass and `srvlog.mjs` classifies it - but it is PRINTED, never written to the ledger row,
so `gate()` never sees it, `bun rows.mjs` cannot report it, and no cell on the board can say
anything about it either way.

**It is not hypothetical: both windows of the 2/12 pair were NOT clean**, and the `no_key_package`
refusal in the entry above was found by reading a run's stdout rather than by any mechanism the
campaign owns. A `PASS-DIRTY` on a HEAL row today means "the web console was dirty"; whether the
server's was is simply unrecorded.

**The campaign's own rule is that a pass is a pass only if its window is clean on web, on the phone
and on the server** - so until the third window reaches the ledger, every HEAL-NEW and HEAL-REVOKE
cell is carrying two thirds of a gate. It is the same class as the pre-gate re-runs owed by
HEAL-NEW-1 and -3, and it should be paid before the post-ladder sweep rather than during it.

### P3 - the mint's own refusal is not a verdict, so a full account throws instead of recording (measured 2026-08-29)

`becomeANewDevice` returns `{ refused: ... }` when the account is at the per-user device cap - the
guard added on 2026-08-28 so nothing is destroyed that cannot be rebuilt. `healnew.mjs` never reads
`minted.refused`: it goes straight on to use `minted.cx`, which is not there, and the row dies with
a TypeError instead of recording `INVALID` with the reason the primitive had already measured and
handed it.

**A blocked job is not a crashed one**, and this turns the one refusal the rig knows how to explain
into the least legible failure it can produce. Every HEAL-NEW row is affected, and it costs nothing
today only because the owner sits at 3 of 15 slots.

### P2 - a client at the DEVICE CAP still enumerates ten rows it can never join

**A rendering-honesty question rather than a mechanism**, and a P2 rather than a P1 because nothing
is silent any more: the refusal is logged with the count it read, the user is shown
`chat_device_limit_reached` naming the device list to open. What is left: ten conversations
that can never become ready still wear the "Sync" badge, because the sidebar is enumerated from the
server's group list and every row starts `isReady: false`. The toast explains the cause once; the
rows keep claiming a repair is in progress for as long as the device stays refused.

**Everything below is the original measurement, kept because it is the evidence, not the plan.**

**This is the user's own HEAL report, mechanised.** They described adding a device and finding
conversations wearing the "Sync" badge, some repairing and others not. That is exactly the state a
device reaches when its KeyPackage publication is REFUSED: the sidebar is enumerated from the
server's group list, every row starts `isReady: false`, and nothing can ever move them because the
device is not addressable.

**THE MEASUREMENT.** A device minted on prod at 10:22, on a fresh profile of an account holding
fifteen devices:

```
POST /api/mls/register-device -> 400
[KP] Publication failed (Error: Failed to publish KeyPackage: 400 ) - welcome_request deferred to next connection
[SYNC] 7da231f8... absent - welcome_request deferred (KP not published)      (x10, one per group)
```

and on the server, for every one of the ten groups:

```
[MEMBERSHIP_ACTIVE] REFUSED group=... device=...  reason=no_key_package
```

`registerDevice` counts `key_package` rows inside `RETENTION_WINDOW_MS` and throws
`BadRequestException` at `MAX_DEVICES_PER_USER` (15) - **before** it logs `[REGISTER_DEVICE] START`,
which is why the server's own trace shows nothing for the device at all. The cap is deliberate (audit
M5) and is not the defect.

**THE DEFECT IS THAT THE CLIENT CALLS A PERMANENT REFUSAL "deferred to next connection".** A 400 here
is a statement about the ACCOUNT, not about this attempt: no reconnection, no retry and no amount of
waiting will change it, and the user is never told the one thing that would fix it - delete a device
in Settings. The server's message already says so and is thrown away. A fallback is a signal, never a
path: the retry loop here is a path, and it is silent.

**WHY IT IS NOT ONLY OUR TEST ACCOUNT.** Two accounts on prod are at exactly 15 on 2026-08-28: the
campaign owner (its own debris, since purged to 2) and one REAL user, whose oldest device dates from
2026-07-21. Their next device will be refused the same way, and nothing will tell them.

**WHAT A FIX MUST DO**, in the order that matters:

1. **Classify at the throw, not on the message.** A 400 from `register-device` is terminal; a 5xx or
   a transport failure is retryable. The publication path currently treats every failure as the
   second kind. The discriminator is the status code, which is already there.
2. **Say it, once, where the user is.** The refusal is the answer to "why is everything stuck on
   Sync", so it belongs on the sidebar state, not in a console line - and it needs a Paraglide
   string, with the action (`Settings -> Devices`) in it.
3. **Do not enumerate what cannot be joined.** Ten rows that can never become ready are ten rows
   claiming a repair is in progress. Whatever the UI decides to show, the honest state is not "Sync".

**MEASURED SO IT IS NOT RE-DERIVED:** with a slot free, the same profile publishes its KeyPackage in
**1.9 s** - so slowness was never the story, and neither was the wipe.

**WHAT IT COST THE CAMPAIGN, recorded because the lesson is the reusable part.** The rung's own
sixteen HEAL-NEW rows each mint a device and abandon it, so the cap was reached by construction, and
five rows then reported that a wiped profile does not publish - a phantom product defect written into
this file overnight. `newdevice.mjs` now asserts the account has a slot BEFORE it wipes anything, and
purges the id each mint abandons.

### P1 - the placeholder is GONE from prod; what it may have left in the MLS TREE is not answered

**The defect, its cause, the guards of 2026-08-28 and the hand cleanup of 2026-08-30 - with every
count and the evidence the deleted frames carried - are in `CHANGELOG.md` and on
[chat-delivery](services/chat-delivery.md#the-placeholder-that-took-a-conversations-first-seat-cleaned-by-hand-2026-08-30).
None of it is restated here.** The server estate is zero on all four tables and the DM kept its eight
real device rows. Two things are open, and neither is a database question.

1. **WHETHER IT LEFT A LEAF, which no server query can answer.** The server row is not the MLS tree:
   if a commit ever Added the placeholder, only a Remove commit from a member drops it, and deleting
   the row did not. The group sat at **epoch 118** and the placeholder held a `key_package`, so an
   Add is likely rather than certain. **It is answered from a member's own client** - both members
   are the account owners, so either can read the tree of `7da231f8-119c-4ce2-884f-55f5c94c903f` and
   say how many leaves it carries and whether one has no owner. Until then, that conversation may be
   encrypting to a member that does not exist, which costs nothing cryptographically and makes the
   roster wrong.
2. **NOT ESTABLISHED: whether the ghost is what stopped the activation.** The peer's real devices
   were `pending` and an active member device of the OWNER's account was online and polling
   throughout - the server answered it `invitations=8` at 23:03, 23:03, 23:09, 23:10, 23:11 and
   23:16 and it committed none of them. Whether `addMember` was failing over a tree holding the
   placeholder's leaf, or the client skipped for its own reason, is a CLIENT-log question and no
   server line separates them.
   **Do not assert the guards fixed it.** MULTI-8 and MULTI-9 on
   [cross-client-testing](cross-client-testing.md) are the rows that answer it.
3. **A report for the stranded state.** `No active membership` is logged at `LOG` and is also the
   normal answer for a device in its first seconds, so a working system and a broken one print the
   same thing twenty-one times - the same shape as the push token no row reported. The age of the
   row is already in the table, so the predicate is a `WHERE`, not a new column, and it must be
   measured against the whole population before its name is believed.

**THE POPULATION, RE-MEASURED 2026-08-30 BECAUSE THE FIRST MEASUREMENT NO LONGER DESCRIBES IT**
(`GROUP BY status`): **125 `active`, 17 `pending`** - against 150 / 10 on 2026-08-28. The stranded
count did not shrink after the guards, it **grew by seven**, so whatever produces a long-lived
`pending` is not the placeholder defect and is not fixed. Of the 17: **12 are `web-`, all older than
an hour, the oldest since 2026-08-25**; 5 are `tauri-`, 3 of them older than an hour. **Still mostly
Chrome, still not an iOS defect and not a mobile one** - but the predicate in (3) must be aimed at
this population, not at the one that named the incident.

**One thing was checked and is NOT a defect, so it is not re-derived**: nine of those ten have an
undelivered Welcome sitting in `queued_message`, which looks like a deadlock and is not.
`MSG_FETCH` filters on group tombstones, never on membership status, so those Welcomes are
retrievable the moment the device comes back - they are abandoned browser profiles, debris. The
tenth, the device that lost the user's messages, has **no queued row at all**: nobody ever added it.

### P3 - discovery honours a dismissal only for a row it ALREADY has, and a new device has none (measured 2026-08-27, population EMPTY today)

`discoverMissingGroups` (`frontend/src/lib/utils/chat/actions.ts`) fetches the dismiss set once and
uses it in exactly ONE place: the loop over `conversations.entries()`. The second loop - the one that
CREATES placeholder rows out of `activeServerGroups` - filters two things, a local row already
existing and an owed exit, and never consults the dismiss set at all. So a group in
`dismissed AND still a member server-side` is purged on a device that has the row, and re-created as
a `pending` placeholder wearing the Sync badge on a device that does not. **A device with an empty
store is precisely the case where the dismiss set is load-bearing, and precisely the case where it is
not read.** The server does not close the gap either: `getUserGroups` (`members.controller.ts`)
filters distribution groups and `deletedAt` tombstones, never dismissals.

**IT IS NOT THE CAUSE OF THE USER'S SYMPTOM, AND THAT WAS MEASURED, NOT ASSUMED.** Read from the
owner's own session on 2026-08-27 (`bun syncrows.mjs --device W3`): 9 active groups, 0 tombstoned,
**876** dismissed-group rows, and `dismissedStillMember: 0`. The intersection is EMPTY, so the branch
cannot currently fire - which is why this is a P3 latent gap and not the explanation for the Sync
rows the user reported. A predicate that names an incident has to be re-measured against the
population it will run on, and this one was.

**Two swallowed branches sit on the same seam**, both in `exitGroupAndCleanup`
(`useConversations.svelte.ts`): `await mlsService.dismissGroup(convo.id).catch(() => {})`, twice, with
no log. That call is the ONLY thing that propagates a manual delete to the user's other devices, so a
silent failure means the group comes back on the next new device with nothing anywhere saying why.
`mlsDeliveryApi.dismissGroup` swallows its own transport error too, for the stated reason that the
local purge already happened - which is true and does not make the loss unloggable. Every swallowed
branch logs; in a best-effort path that is all a loss leaves.

**The 876 is worth a second look on its own**: `user_dismissed_group` grows one row per manual delete
per user, for ever, and the campaign is what put 876 there. Nothing reads it in bulk, so it is not an
incident - but it is an unbounded table nobody has decided about.

Reached by `HEAL-NEW-7` on the board, which is written to tell this cause apart from the two that can
actually fire today - a server tombstone, and an exit still owed in the DELETING device's own
IndexedDB.


### P3 - openmls 0.8.1 PANICS on a corrupted PrivateMessage body instead of returning an error (found 2026-08-27)

Found while writing a producer for the same-epoch refusal test: tampering with the AEAD-protected
body of a `PrivateMessage` does not yield an `Err`. It aborts inside the library -
`panicked at openmls-0.8.1/src/framing/private_message_in.rs:136: Ciphertext decryption failed`.

**Why it is more than a test inconvenience.** In WASM a panic surfaces as `unreachable`, which
`mlsDecryptError.ts` classifies as `'oom'`, which routes to `onMlsFatalError`. So **a byte string the
server hands us can kill the MLS client**, and the server is not trusted with plaintext but IS the
thing that stores and returns these bytes. Nothing on the ladder produces one today - the campaign
never corrupts a frame - which is precisely why CORRUPT (rung 18) should, and it is the natural
place to settle it.

**What is NOT known:** whether the panic is reachable from a frame the server could actually return
(a truncated or bit-flipped ciphertext row) or only from a hand-built one. Answer that before
deciding between catching it at the WASM boundary and carrying it upstream to openmls.

The workaround the tests use is to avoid the shape entirely: the producer is two members committing
at the same epoch, which is the production shape anyway and returns cleanly.

### P2 - a group that never leaves its creation epoch keeps collecting device invitations nobody can honour (measured on prod 2026-08-30)

Found by HEAL-REVOKE-7 `--order last` on `edb8d7ab` - the run that was supposed to confirm the P1
above and instead FAILed on that P1's RESIDUE. Kept as its own item because the residue turned out to
name a class, and the class has real conversations in it.

**What the row saw.** `equalityGap: ["rows: 12 vs 13", "syncing: 0 vs 1"]`. The server listed 13
groups for the subject; the returning device built 12 rows and settled; the freshly minted reference
built 13, the 13th amber for ever. The extra one was `8868be1c`, the very group the P1 above
destroyed. The actor itself reported `12 ready of 13` - so no device in the fleet could serve it.

**What prod said, and it is the membership row that lies.** The group was alive (`deletedAt` null,
`activeEpoch 1`, no rotation payload) and its device memberships read:

    web-...-msgm5z5j-136y   active    2026-08-30 01:20:44.793     <- the creator, holding NOTHING
    web-...-mtd1d1fc-m84y   pending   2026-08-30 01:20:44.849
    tauri-...-mtd1qgu3-vnde pending   2026-08-30 01:20:44.849
    web-...-mtf6rlvn-hkhr   pending   2026-08-30 02:24:18.378     <- this run's reference mint

`active` is written when the creator registers itself, and nothing ever revisits it. The creator's
local MLS state was gone 291 ms later, so the server went on offering the group to every device that
enrolled afterwards - including a device minted an hour later, which duly went `pending` and stayed
there. **A membership row records that an invitation was SENT; nothing reads back whether it was ever
honoured, and nothing expires it.**

**THE POPULATION, because this is exactly the kind of question no row on the board asks** (measured
2026-08-30, before the sweep that cleared the instance):

    -- invitations still pending on a LIVE group, by age
    SELECT CASE WHEN now() - m."createdAt" < interval '1 hour' THEN 'a: < 1h (in flight)'
                WHEN now() - m."createdAt" < interval '1 day'  THEN 'b: < 1 day'
                WHEN now() - m."createdAt" < interval '7 days' THEN 'c: < 7 days'
                ELSE 'd: older' END AS age,
           count(*) AS pending_rows, count(DISTINCT m."groupId") AS groups,
           count(DISTINCT m."groupId") FILTER (WHERE g."activeEpoch" <= 1) AS in_epoch1_groups
    FROM dm_device_group_memberships m JOIN dm_groups g ON g.id = m."groupId"
    WHERE g."deletedAt" IS NULL AND m.status = 'pending' GROUP BY 1 ORDER BY 1;

    a: < 1h (in flight)    2 rows   2 groups   1 at epoch 1
    b: < 1 day             9 rows   5 groups   1 at epoch 1
    c: < 7 days           13 rows   5 groups   3 at epoch 1

**22 of the 24 pending rows on live groups were older than an hour, 13 of them older than a day**, and
none pointed at a revoked device - they are live devices holding invitations that will not resolve.
Of the nine live groups sitting at epoch 0 or 1, **four carried pending rows and three of those are
real conversations, not harness debris** - two DMs from 2026-08-03 and 2026-08-28, and one unnamed
group from 2026-08-28. The oldest such group is 33 days old. `HGRP` debris was one of the four and
has been swept; the other three are untouched, deliberately - they are real user data and no
destructive control here has a reason to name them.

**Do not take `activeEpoch <= 1` for the predicate.** Pending rows exist on healthy groups too
(epochs 3, 4, 5, 8, 10, 108 and 258 each had one), so "pending" alone is not the signal and "epoch 1"
alone is not either: a DM created and never written to legitimately sits at epoch 1 with everyone
`active`. What distinguishes the corpse is a `pending` row that has outlived any plausible delivery -
which is a duration, and therefore has to be measured against the population before a name is put on
it, not chosen from this one incident.

**The second fact, and the one that reaches a HEAL row.** The two devices disagree about an
unservable group: a FRESH device creates a row for it and leaves the tile amber for ever; a RETURNING
device creates no row at all. Neither is obviously wrong - not showing it is arguably the better of
the two - but they differ, and "a returned device ends where a fresh device ends" is precisely what
rung 16 asserts. **So this class can fail a HEAL-REVOKE row that is not about it**, which is how it
was found, and it is the same family as the dead row a deleted group leaves every other member.

**Not fixed here: the blast radius leaves the row's subject.** Three things want deciding together,
and the third is the only one that is cheap: whether an invitation should expire; whether a group
whose creator holds no state should still be offered; and whether an unservable group should present
a tile at all. Nothing here should be settled by widening a sweep - the P1 above is precisely what
happens when a destructive path decides a group is dead from an incomplete read.

### P3 - one client reads a new salon's distribution group TWICE, concurrently (measured 2026-08-27)

`srvlog.mjs` leaves `published=false base=none active=0 devices=0` unexplained on purpose - it is
the shape that found the concurrent-join race - and on `cb967b6c` it earned that again. Every new
salon in the COMM rung is served that read **exactly twice, in the same second, to the same user**:
`93c80263`, `7e91ade3`, `5e09125d`, `d4b3152f`, `2de1a37c`, `ccc67640`, six for six.

Two callers are invoking `ensureDistributionGroup` for one channel concurrently. Neither can be
stopped by its `getLocalGroups()` guard, because at that instant neither has created anything - the
guard answers a question that only becomes true after one of them wins.

**It is currently harmless and that is the whole reason it is a P3, not a P2.** The first-publish
race is handled: the loser's `publish` returns `stored:false`, it calls `forgetGroup` and external
-joins the winner's base instead. So the duplicate costs one wasted group creation per salon and
nothing else that has been measured. It is filed because it is the SAME two-callers-one-read shape
that has already shipped one defect, and because a mitigation is not an absence.

**Do not fix it by widening the guard.** The question to answer first is who the second caller is -
the roster sweep and the channel-open path are both candidates - because a lock around the read
would hide the duplication rather than remove it.

### P2 - two COMM rows could not ARM, and the re-run has to say whether that was the debris (measured 2026-08-27)

`f21502e1` left three `VACUOUS` cells. COMM-22 is the entry below. The other two are open:

- **COMM-9/10** - `failures: []`, and yet nothing to judge: `keptArrived:false`,
  `keptLatencyMs:null`, `deniedLatencyMs:null`, `keptCopiesAfterRemoval:0`. The message the row
  removes a member around never arrived, so the removal raced nothing. An empty `failures[]` beside
  an unarmed check is itself a runner defect - the row knew it could not ask its question and said
  nothing about why.
- **COMM-21** - `the peer posts while it may: COMM21-... never appeared in 30000ms`, and
  `probeBefore` answered **HTTP 400 `senderSessionId is required for channel messages`**.
  **CORRECTED 2026-08-27: THAT 400 IS THE DESIGN, NOT A DEFECT.** `comm21.mjs`'s own header states
  it - the probe is deliberately session-less so the SAME request is refused for two different
  reasons, 400 while the peer is still a member and 403 once it is not, "without the 400 the 403
  could equally be a malformed probe". The arm condition at `comm21.mjs:196` REQUIRES
  `probeBefore?.status === 400`. So the 400 is a satisfied conjunct and the row failed on a
  DIFFERENT one - and the real cause is named right there in the same verdict line, which was read
  past: **`the peer posts while it may: COMM21-... never appeared in 30000ms`, i.e.
  `peerWroteBefore !== true`.** The peer could not send in the salon it was still a member of.
  **Read the ledger record before touching the probe** - and note the shape: the granting device
  and the peer failing to exchange a message in a fresh salon is EXACTLY the forked-group signature
  COMM-8 turned out to be, so re-run this row on a build carrying that fix BEFORE calling it a
  runner defect at all.

**ADJUDICATED 2026-08-27 on `cb967b6c`, the first build carrying the same-epoch ACK.** Both
survived the debris being cleared, so both causes are real and neither was the redelivery:

- **COMM-9/10 still `VACUOUS`**, identically: `keptArrived:false` with `failures: []`. The runner
  defect stands as written - a row that cannot ask its question must say so in `failures[]`, and
  this one still says nothing.
- **COMM-21 still `VACUOUS`** with the same `probeBefore` 400 - which the correction above shows is
  the design. Its blocker is `peerWroteBefore`, and the first thing owed to it is a re-run on the
  COMM-8 fix, not a runner change.

### P2 - a STAGED commit cannot export a base at submit time, and keeps a repair where the external path needs none (COMM-22)

**Reproduced on two builds with one runner**, `d6f61539` (2026-08-25T21:56Z) and `2a4297cb`
(2026-08-26T17:45Z), `armed: true`, six grant/join/send/revoke/send cycles both times. It is NOT the
wreckage path `ea8266b2` removed: that commit landed at 20:25Z, before both.

The signature is narrow, and that is what makes it a defect rather than a slow window:

| | value |
| --- | --- |
| sender reads | 12 of 12, 6 837 ms |
| peer reads WARM | **11 of 12** |
| peer reads COLD, after reload + PIN | **11 of 12** - the same eleven |
| seeds the peer holds | **11**, for 12 sessions |
| `nothingStaysUnreadable` | true |

**WARM AND COLD ARE IDENTICAL, WHICH IS THE WHOLE FINDING.** A repair that had not finished yet would
differ across a reload; the same eleven on both sides means the twelfth seed is not late, it is
absent, and no reload will fetch it. The row it belongs to renders as explicitly unreadable
(`no seed for session ... (repairable)`) - so the product is honest about it and the reader still
never sees the message.

**THE SENDER DID ANSWER.** `repair.senderAnswered` holds nine answers summing to twelve seeds and
`senderWithheld` is empty, while `peerAbsorbed` records four lines summing to seven. So the loss is
on the receiving or the requesting side, not a sender that refused.

**THE CAUSE, FROM THE RUN LOG OF `2a4297cb`.** The peer is not slow and it is not refused a seed: it
is not IN the salon's distribution group at all, and it is its OWN earlier commit that put it out.

    19:36:12  W1  no base published for salon 58afab93 - creating group 9e46429d
    19:36:12  W1  POST .../distribution-group/group-info        <- base published at epoch 0
    19:36:21  W1  Processing Commit group=9e46429d sender=<peer>  <- the peer's external join, epoch -> 1
                  ... and NO group-info POST from the peer, ever
    19:36:26  W2  externalJoin STALE base for 9e46429d (published 0, group at 1) - not attempting
    19:36:31  W2  undecryptable frame on 9e46429d - not acknowledged: Group not found
    19:36:34  W2  could not ask for 1 missing seed(s) in channel 58afab93: Group not found
    19:36:40  W1  the published base is at epoch 0 while the group is at 1 - republishing   <- 14 s too late

**AN EXTERNAL JOIN ADVANCES THE GROUP AND LEAVES THE BASE BEHIND IT.** `externalJoin` publishes the
new base with `void this.refreshGroupInfo(joined.groupId)` (`BaseMlsService.ts:2288`) - fire-and-forget,
by the same deliberate choice as the one after `submitCommit` (`:1912`), so a commit that succeeded is
never reported as failed because a follow-up did not land. The check reloads the peer moments later on
a CLEAN state, so that follow-up never lands AND the tree that could mint the base is gone with it. The
joiner has locked itself out, and every stateless joiner after it: the commit gate accepts a base equal
to the active epoch and nothing else, and a distribution group has no peer-Welcome fallback.

**THE REPAIR EXISTS AND IS 14 SECONDS LATE, WHICH IS WHY THE LOSS IS PERMANENT.** `republishStaleBase`
did fire, three times across the run (base 0->1, 6->7, 12->13), from the one holder with a current
tree - but its trigger is that holder's *ordinary read* of the salon, not the epoch change, so it
always lands after the refused peer has already given up. And the peer's giving-up is terminal twice
over: `stale_base` is treated as a fact for the session, and the seed repair on top of it deletes its
`outstanding` entry before the send it then loses (`repair.ts:124-160`), with `asked` never set
(`:303-321`) and all three re-arm paths driven by an arriving answer that cannot come.

**Two standing rules name it.** *Never learn by failing what a fact could have told you* - the repair
hands the ask to a layer certain to refuse it, to discover a group it is not in, eight seconds after
`stale_base` established exactly that. And *a race that heals cleanly is still a defect* - here it
does not heal at all.

**The external-join half is shipped and is not restated here** - story in `CHANGELOG.md`, mechanism
on [mls-protocol](protocols/mls-protocol.md). What matters for the half below is only its shape: the
window was DELETED rather than narrowed, because an external commit is applied at once and the
joiner can export the base its own commit created before merging. Narrowing was considered and
rejected - a two-member salon whose other member is offline still has nobody to mint the base, and
a shorter race is still a race.

**THE HALF THAT REMAINS, and why it is separate.** An ordinary staged commit (add/remove) cannot
export a base at submit time: its commit is unapplied, so the device is still at the OLD epoch and
`export_group_info` would describe the base the joiner already has. Those paths keep
`void this.refreshGroupInfo(groupId)` after the merge (`BaseMlsService.ts:1912`) and a holder's
`republishStaleBase` as their repair - the same window, one round-trip wide, on a device that stays a
holder and is far less likely to reload mid-flight. Closing it needs the GroupInfo openmls already
builds and all four call sites discard (`mls-core/src/members.rs:85,121,273`, `welcome.rs:86`, each
destructuring `_group_info`); the groups use `use_ratchet_tree_extension(true)`, so it carries the
tree exactly as `export_group_info(.., true)` does. Layers: `mls-core` -> `mls-wasm` (a third slot on
the returned array) -> `BaseMlsService` -> the already-widened `submitCommit`, plus `npm run
generate`. The server side is done and takes it unchanged.

**ONE HYPOTHESIS ALREADY REFUTED, recorded so it is not re-run:** the missing session was
`R3jf6bcWThQ2oUnLKLaKvi--`, the only one of the twelve whose id ends in `-`, which in SQL would open
a comment. It does not: `getGraineHistoryFloors` binds the ids as an array
(`IN (:...sessionIds)`, `channel.service.ts:1318`), so nothing is interpolated. The trailing dashes
are a coincidence of base64url.

**THE RECORD WAS INCONSISTENT ACROSS THREE FILES before this**, which is why the FAIL survived two
sessions unnoticed: the board said `VACUOUS`, [cross-client-campaign](cross-client-campaign.md) said
a believed `PASS-DIRTY`, and `results.ndjson` said `FAIL` twice. All three now say `FAIL`. The
believed pass was real but on an OLDER runner, and its shape differed where it matters: the peer
missed seven sessions there and absorbed all seven.

### P2 - a re-admitted device calls its own exclusion window a loss, and reconciles for it (measured 2026-08-26)

**Found by a fix working.** GRP-8's round-2 re-admission Welcome used to be dropped as a redelivery
(closed in `e027679a`), so the re-admission never happened on the joiner and the check passed anyway -
it counts the INVITER's roster. With the Welcome processed, this is the honest consequence. Nine clean
`PASS` rows before `feecfaf5`, `PASS-DIRTY` on it.

**THE SAME FRAME IS JUDGED TWICE AND THE TWO ANSWERS DISAGREE**, fifteen seconds apart, on `feecfaf5`:

    11:09:19  Frame arrived after this device was evicted - ACKed and dropped, no repair is owed
              msg_epoch=3 group_epoch=3
    11:09:34  [WELCOME] held but EVICTED - re-admission, not a redelivery   -> forget_group, epoch 4
    11:09:34  Past-epoch application frame, unreadable for good: msg_epoch=3 group_epoch=4
    11:09:34  [History] frame never read here and unreadable for good; will reconcile
    11:09:34  [HISTORY_RECONCILE] asked ... whether we hold the same history

`history.ts`'s `kind === 'evicted'` branch already carries the whole argument three lines above the one
that fires - *"we are not entitled to the plaintext, so there is nothing for a reconciliation to
recover"*. The defect is that this reasoning is keyed on the CURRENT membership state, so it stops
applying the instant the device is re-admitted, while the frames it protects are still in the stream.
**A column is only evidence for the question it was written to answer**: `evicted` answers "am I out
NOW", not "was I out THEN".

**What it costs:** one reconciliation per re-add over the whole exclusion window rather than one frame,
so it scales with how long the device was out and how busy the group was - against *"doit marcher avec
une conversation de toute les tailles"*. And it puts a repair line in a window where nothing needed
repairing.

**The fix, and the one thing blocking the obvious version.** An ENTITLEMENT FLOOR per group, written
where the Welcome installs - which is now a named branch, `readmittedAfterEviction` in
`setupMessageHandler.ts`. A frame below the floor is then handled exactly like `evicted`: marked seen,
no loss, no reconciliation. **The frame's own epoch is not visible from JS** - Rust has it and prints it
(`msg_epoch=3 group_epoch=4`) but the error reaching `classifyIncomingDecryptError` is
`SecretTreeError(TooDistantInThePast)` with no number, and `getEpoch(groupId)` gives only the current
epoch. So either surface the frame's epoch through the decrypt error - **never learn by failing what a
fact could have told you** - or key the floor on the STREAM POSITION at re-admission, since the replay
already walks rows in order and row ids are timestamps. The second needs no WASM rebuild and no APK.

**A policy question sits behind it and is NOT answered here** - see
[open-questions](open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add). Nothing
should be changed on the strength of a reading of it.

**How to confirm it is gone:** GRP-8 goes clean. It is the only check that re-adds a removed member.


**RECURRENCE 2026-08-30, AND IT WIDENS THE POPULATION THIS ENTRY CLAIMS.** Read off six
HEAL-REVOKE-5 runs, builds `96bdd1bb` through `0044a041`. **The device losing the frames was never
evicted from the group it loses them in** - it is a fresh device of the same user, joining for the
first time after a revocation wipe. So the entitlement floor cannot be keyed on
`readmittedAfterEviction` alone, which is what the fix above proposes: that branch never runs here.
**A floor belongs at every entitlement START, however the entitlement was acquired.** And "how to
confirm it is gone: GRP-8, the only check that re-adds a removed member" is incomplete for the same
reason - HEAL-REVOKE-5's reference observer reaches this branch with no eviction anywhere in the row.

**What was measured.** 107 distinct `LOST frame` fingerprints over the six runs, growing run over run
(1, 8, 8, 9, 30, 51). In the run of record, 50 of 51 fall in ONE group of the 23 the owner is a member
of. They are not chat text: the fingerprint's first field is `frame.length` in base 36, so the sizes
read straight off it - median 52 KB, max 84 KB, 5.6 MB over the six runs.

**A SECOND AND MUCH LARGER POPULATION SITS BEHIND THE SAME GROUP**, reported in aggregate rather than
per frame:

    [HISTORY] 642f389a... holds 8005 frame(s) it can never read - reconciling (e.g. 5p:1cx1kog, ...)
    [HISTORY] 642f389a... holds 3005 frame(s) it can never read - reconciling (e.g. 5p:1cx1kog, ...)

`5p` is 205 bytes, so these are small frames and a different population from the 52 KB ones above. The
example fingerprints are IDENTICAL across all three observers of one run, so that backlog is stable.

**WHAT IS NOT ESTABLISHED, AND THE INFERENCE THAT MUST NOT BE DRAWN FROM IT.** No fingerprint repeats
across any two runs, and **that is not evidence the frames are new messages.** `frameFingerprint` is
FNV-1a over the CIPHERTEXT bytes, and `historyManifest.ts` answers a reconciliation by re-encrypting
the peer's durable copy at the CURRENT generation - so the very same message re-sent to a new device
fingerprints differently every time. Zero overlap discriminates nothing here, and a reading of it as
"fresh traffic each run" was formed and retracted before it reached this page.

**The cheap discriminator, for whoever takes it.** The digest that precedes the burst asks with
nothing held - `[HISTORY_DIGEST] Sent for 642f389a... - ids mode, 0 id(s), asking from
2026-05-31T00:00:00.000Z` - so whether the 52 KB frames ARE that answer is settled by putting the
`Sent` stamp beside the burst, which lands inside a single second. Worth one look before anything is
changed: if the reconciliation's own answer is what arrives unreadable, the repair is feeding the
loss it was sent to cure.

**One more line from the same window, unqueued elsewhere and not chased here:**
`[HISTORY_RECONCILE] no probe sender yet - 642f389a... deferred until one is installed`, five times
across two groups before the first digest goes out.


### P2 - a device revoked while OFFLINE keeps its store until someone LOGS IN on it (measured 2026-08-30)

**The product does what it says, and HEAL-REVOKE-9 now asserts three things where it asserted one.**
While the victim was severed (`severed: true` in 4 ms) and revoked from the owner's panel
(`stillAddressable: false` in 2 106 ms), its state was still there - `identityKeys: 1`, 2 databases, 22
localStorage keys, `wipeRan: false`. **A device that cannot ask does not conclude**, and a wipe there
would have been this rung's worst possible outcome. A reload alone changed nothing
(`revocationSeen: false`; `footprint.mjs` still read 6.54 MB fourteen minutes later); one
`login.mjs --device W3` then took it to `identityKeys: 0`, 3.46 MB. **The wipe is DEFERRED, not lost.**
`sessionAuth.ts` has exactly three triggers and each requires a credential or a live socket, so a page
load that finds a dead cookie hits none of them - by design, since wiping on an unauthenticated page
visit is a destructive control firing without a confirmed server fact.

**SO WHAT IS OPEN IS A DECISION, NOT A PATCH: how long the residue may sit.** On a machine never logged
into again - the stolen-laptop case revocation exists for - it stays on disk indefinitely. It is an
identifier (`mls_device_id_<userId>`) plus SEALED key material (`canari_device_key_vault`) over databases
encrypted under that device key: ciphertext and a name, not readable messages, which is why this is a P2.
Closing it needs a choice between two bad options - asking the revocation route at the login GATE means
answering `/api/mls/devices/:userId/:deviceId/revoked` to an unauthenticated caller, a device-enumeration
oracle; the alternative is a local expiry, the exact clock this project refuses to make load-bearing.
**That question is the whole of what stays open here.**

### P3 - a `history_bundle` restores the EDITED flag without the edited body

Found by enumerating every applier of a message mutation on 2026-08-22, after three defects in that
seam were fixed (see `CHANGELOG.md` and [chat](frontend/modules/chat.md)). This is the fourth
applier, and unlike the other three it is not broken - it is deliberately narrower than the others in
a way that has a visible consequence nobody has decided about.

`systemMessageHandler.ts`, the `history_bundle` merge over messages a device ALREADY holds: a
deletion in the bundle replaces the body with the tombstone, and an edit in the bundle sets
`isEdited: true` and fills `editedAt` when absent - but never touches `content`. So a device that
missed an `edit_message` frame and later receives a bundle carrying the edited message ends up
showing the PRE-EDIT text with an "edited" marker on it. It cannot diverge two bodies, because it
never writes a body; it can present a body it knows is superseded.

**Why it is not simply a bug to fix.** Taking the bundle's body means trusting a peer's copy of
another member's message content over our own, and the comment on the deletion branch (D5) shows the
narrowness there was reasoned rather than accidental. `editSupersedes` now gives the merge a rule it
did not have when it was written - apply the bundle's body when its `editedAt` is strictly newer -
which would close this without trusting anything undated. That is a trust-model decision, so it is
recorded here rather than taken while a campaign is running.

**What would tell us it matters:** no board row covers it, and reaching it needs a device that missed
an edit AND is later handed a bundle containing it - which is the FWD/HEAL shape, not MUT's.

### P3 - a deleted group leaves every OTHER member a dead row, for ever, clearable only one at a time

Found on 2026-08-24 while clearing the campaign's own debris off W2, and the retention itself is NOT
the finding - it is deliberate and right. `initializeConnection.ts:171` forgets the member's WASM
state, so she can no longer send, and then calls `onGroupDeletedRemotely` so the conversation is
marked `removed` and shown with a banner "instead of removing it silently". `decideAbsentGroupFate`'s
first guard then makes that state unreachable by any later reconciliation, because it records what
its owner was TOLD. Removing a conversation from under someone without telling them would be the
worse behaviour, and the design says so.

**What has no answer is the ACCUMULATION, and the fact that the only exit is per-row.** "Supprimer
localement" acts on the OPEN conversation, so N dead rows cost N navigations and N clicks; there is
no bulk gesture, no "clear the deleted ones", and nothing ages them out - a `removed` row is
permanent by construction. The rig measured the extreme: W2 held **189** of them, from one phase of
one campaign, and clearing them needed a purpose-built sweep (`dismiss.mjs`) driving the button 189
times. A real user's number is not 189, but it is not zero either and it only ever grows: a promo
with a group per project, deleted at the end of each year, accumulates a dozen dead rows that no
gesture can clear together.

**Why it is a product decision rather than a bug to fix.** Any bulk control has to decide what it may
touch, and the only honest allowlist is "conversations already marked `removed`" - which is
exactly the set whose whole purpose is to have been SEEN by its owner first. A control that clears
them wholesale re-introduces, by the owner's own hand, the silent removal the banner exists to
prevent. So the question is a UX one and belongs to the user: is the exit a bulk action, an
age-out for a row whose banner has been seen, or nothing at all.

**What would tell us it matters:** no board row covers it, and no rung would ever notice - every
runner either creates and deletes its own group (so it is the CREATOR, whose copy `deleteGroup`
purges) or leaves the debris behind for the next run to inherit. That asymmetry is why it went
unseen for the whole campaign: W1 measured clean at 9 conversations on the same day W2 held 189.

### P1 - a REVOKED device kept its local store, restored only SOME conversations, and a locally-pending deletion blocked the new conversation with that peer

Reported by the user 2026-08-23, verbatim: *"sur un vieux PC client qui avait toujours une memoire
locale (pourquoi, puisqu'il avait ete des appareils connectes via l'interface ?), le fait de se
reconnecter n'a pas charge toutes les conversations (certaines oui, certaines non). Pire : une
conversation 1v1 avec quelqu'un [qui] avait ete en attente de suppression locale sur cet appareil (le
pair avait supprime la conversation, mais nous elle etait toujours presente localement) a fait
barrage a la reception de la nouvelle conversation avec ce pair (ca faisait doublon j'imagine)."*

Three separate things, in the order they have to be answered:

1. **ANSWERED, AND IT IS WHY THIS ENTRY IS A P1.** The question was what revocation is DEFINED to
   do; the user settled it 2026-08-23, verbatim: *"Effacer ce qu'il detient (il doit devenir un
   appareil comme neuf s'il essaie de se reconnecter, c'est a ca que sert la blacklist non ?)"*.
   Revocation is a WIPE. A revoked device that still holds its local store is therefore a defect,
   not a wording problem.

   **WHICH OF THE TWO IT WAS IS NOW SETTLED, BY READING: THE MECHANISM EXISTS, SO IT DID NOT FIRE.**
   `resetDeviceAsFreshImpl` (`sessionAuth.ts`) is thorough - MLS state, the device id, the sync-guide
   flag, every `device-name:` key, the IndexedDB store cleared AND closed, the session's own handle
   closed, the auth cleared, the device wiped to factory. **What was missing was a path that ASKS.**
   Until 2026-08-26 the only two triggers were `resetRequired` on the PIN check and a
   `device_revoked` control frame, and the first was reached only inside
   `if (!isBiometric && !isVaultLogin)`. So a vault or biometric login never learned at login time
   that it had been revoked, and depended entirely on a frame arriving while it was online - a frame
   sent to a device that was not there to receive it. **Fixed 2026-08-26**: every login path now
   resolves its real device id and asks `/api/mls/devices/:userId/:deviceId/revoked` before `init()`,
   and the one wipe is `wipeRevokedDevice`, shared by all three triggers - which also gave the frame
   path the MLS teardown it was skipping, on the one path where the service is still live. Story in
   `CHANGELOG.md`, rule in [durable-rules](durable-rules.md).

   **AND A SECOND CAUSE OF THE SAME SYMPTOM WAS FOUND ON 2026-08-30, by HEAL-REVOKE-9, which means
   the fix above was NECESSARY AND NOT SUFFICIENT.** `getStorage()` is a factory, so the number of
   open connections is the number of readers; `/posts` was measured holding two, the wipe closed one,
   `deleteDatabase` fired `onblocked`, and a revoked device kept its message store **with the wipe
   having run and reported success**. Fixed in `da0ce2f2` at the module that creates the connections,
   with a registry mirroring `closeMlsDb`. So "the wipe did not fire" and "the wipe fired and was
   blocked" are two different defects wearing one report, and only the first was known.

   **THIS DOES NOT CLOSE THE ENTRY, AND MUST NOT BE READ AS CLOSING IT.** Points 2 and 3 below are
   untouched by both fixes. What closes it is HEAL-REVOKE-1, -2 and -3 run against a build carrying
   `da0ce2f2`, not the inference that the cause found must have been the cause reported.

   **AND THE ROWS THAT WERE OWED HAVE RUN.** HEAL-REVOKE-2 and -3 are `PASS-DIRTY` on `2862d958`
   with `unmet: []` and `equalityGap: []`; their only dirt is the `arrived twice` line, a separate
   defect fixed on 2026-09-05. **This entry no longer waits on "those rows have no runner yet"** -
   the runner is `archive/healrevoke.mjs --row 2 / --row 3`, and what is owed is a re-run on a build
   carrying the ack barrier, not a runner.

   **HEAL-REVOKE-1 RAN ON 2026-09-05 AND THE SYMPTOM DOES NOT REPRODUCE - `PASS`, clean, `unmet: []`
   on `2862d958`.** A device that held 7 of 7 rows plus a group minted for the row was revoked
   through the product's own panel; the server recorded the decision in 276 ms and the device left
   the census 670 ms later; the device's `[RESET]` trail reported the wipe run and finished with no
   failed step and no `store(s) SURVIVED` line; and the disk, read seconds after the trail, held
   **0 Canari databases, 0 identity keys, 0 localStorage keys**. **Two independent witnesses, and the
   row asserts both** - the app can be right about a wipe it did not complete, and a `deleteDatabase`
   can leave something no log mentions.

   **WHAT THAT DOES AND DOES NOT SETTLE.** It settles the first instant, which is the only one that
   can be read: a re-enrolment writes `CanariDB_<userId>` back under the same name within seconds, so
   no later sample separates a store that survived from one that was rebuilt. It does NOT settle
   points 2 and 3, and it does not settle the RETURN - whether a device that comes back ends where a
   fresh one ends is HEAL-REVOKE-2 and -3. ~~those rows have no runner yet~~ - **they have one, and
   this sentence contradicted its own entry four paragraphs later**: the runner is
   `archive/healrevoke.mjs --row 2 / --row 3` and both rows are `PASS` on the board. **The entry
   stays open on points 2 and 3**, not on this half and not on a missing instrument.

   **AND THE FIRST ATTEMPT AT THIS ROW WAS `INVALID` FOR A REASON THAT WAS NOT THE PRODUCT'S**, which
   is worth recording because the sentence it wrote read exactly like one: *"the victim could not be
   brought to an enrolled starting point"*. `newdevice.mjs` spawned `login.mjs` by BARE NAME, so a
   mint resolved it against the CALLER'S working directory - fine from the harness root, `Module not
   found` after a `cd archive` - and exited 1 on a stderr the helper discarded. Ninth sighting of that defect and the first one
   `spawn-selftest.mjs` had been green for; the gate is now an allowlist of resolved forms rather
   than a ban on one spelling ([durable-rules](durable-rules.md)).

   **AND THE PARAGRAPH ABOVE WAS HALF WRONG, CORRECTED BY MEASUREMENT 2026-08-28.** The wipe was
   thorough and the trigger was missing - both true - but the wipe was also **not permanent**, which
   reading it could not show: it ran, deleted everything, and the SYNC_WATCHDOG nobody had stopped
   rebuilt the MLS database and re-marked ten groups 1.25 s later, on a device that had just printed
   `nothing of this device remains`. So "the mechanism exists, so it did not fire" was the right
   deduction from the wrong premise, and a user's report of a revoked PC that *still had local
   memory* is consistent with the wipe having fired all along. **Fixed by `tearDownLiveSession`;
   story in `CHANGELOG.md`, mechanism on
   [auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it), two rules
   in [durable-rules](durable-rules.md#mls-state-and-keys---mls-protocol-auth).** It also means the two candidate causes
   below are no longer the only two: a third is that the PC was revoked, wiped, and re-created its
   own store - the one the user would have seen as "still had local memory".

   **A SECOND, INDEPENDENT WAY A REVOKED DEVICE KEPT ITS STORE - FIXED THE SAME DAY, AND IT DOES NOT
   EXPLAIN THIS REPORT.** `wipeDeviceToFactory` had the native stores and the WebView's as the two
   ARMS of one platform branch, so inside Tauri it deleted `mls.bin` and the `.db` files and never
   touched IndexedDB - measured on a Pixel 6a holding 5.9 MB of `CanariDB_<userId>` it should never
   have had, created by a reader that named `IndexedDbStorage` instead of asking `getStorage`. Both
   halves are fixed with a guard test. **It is recorded here so it is not mistaken for a fourth
   candidate cause above: the user's device was a PC, on the web, where that branch always ran.**
   Story in `CHANGELOG.md`, mechanism on the same auth section, two more rules in
   [durable-rules](durable-rules.md#mls-state-and-keys---mls-protocol-auth).

   **TWO CANDIDATE CAUSES SURVIVE that fix and only the user's own history separates them**, so
   neither is worth code before rung 16 measures it: the removed panel row may have been
   SESSION-only, since `handleRemoveRow` calls `deleteDevice` only when `row.device` exists, in which
   case nothing was ever revoked and nothing is broken; or the device was deleted but
   `revokeRowSessions` failed - a state the code already anticipates in as many words - leaving the
   PC a valid refresh cookie, so it never reached a login path at all.

   The rest of that decision is not a fix but three things to VERIFY, and they are rows, not prose:
   a revoked device really does become like-new; its first reconnection resynchronises as a NEW
   device would, history included; and if that first pass does not catch everything up, the later
   connections do, through the heal-on-diff mechanism - which must be shown to TRIGGER, and to
   trigger on the right conditions rather than on any reconnection at all.

   The last of those is the one a green run can most easily fake. A heal that fires on every
   connection would make every check pass while proving nothing, so its conditions are part of the
   assertion, not context around it - the standing rule that a predicate which named the last
   incident is not the predicate that names the next one applies to its trigger directly.
2. **A partial restore is worse than no restore.** Reconnecting brought back some conversations and
   not others, with nothing saying which or why. A restore that silently stops halfway looks
   complete, so the user does not know to retry - it needs to know its own expected count and report
   the shortfall, per the standing rule that a correct mechanism with no report is found by hand a
   day late.
3. **FIXED 2026-09-06, NOT SHIPPED - a local tombstone was treated as a live conversation for
   de-duplication.** The peer had deleted the 1v1; locally it sat pending deletion; the NEW
   conversation with that same peer was then dropped as a duplicate of the record that was on its
   way out.

   **TWO SITES ASKED THE SAME QUESTION AND NEITHER LOOKED AT THE LIFECYCLE**, and the second is far
   worse than the reported symptom. `discoverMissingGroups` matched on the peer alone and declined
   to create the replacement - that is the user's report. `mergeDirectConversationDuplicates` groups
   a peer's records the same way, picks the most RECENT as canonical, and deletes every other one
   **locally AND on the server** (`deleteGroupOnServer`) - so a tombstone with a newer `updatedAt`
   takes the fresh conversation's messages and destroys the fresh group **for both parties**. The
   mirror ordering is not harmless either: a record kept deliberately until the user removes it
   would vanish on a login, its messages surfacing inside a conversation the user thinks is new.

   **ONE PREDICATE, BOTH SITES**: `canRepresentThePeer` in `conversations.ts` - a `removed` record is
   a tombstone and takes no part in de-duplication, as neither target nor source. Five tests, both
   orderings of the merge plus an anti-vacuity case on each site, because "stop de-duplicating"
   would pass every tombstone case and resurrect the duplicate-DM defect the function exists for.

**This is HEAL's, by the user's own framing** (*"On y reviendra au moment ou on fera la campagne
HEAL"*). Rung 16 is where it gets armed, and item 1 now carries FOUR rows rather than needing a
definition: the wipe on revocation, the like-new state on reconnection, the first-reconnect resync
with history, and the heal-on-diff trigger with its conditions. Items 2 and 3 are both reproducible
without a second human - a stale profile plus a peer-side delete is exactly what the HEAL runners
already build - so all of it becomes rows on [cross-client-testing](cross-client-testing.md) rather
than hand-checked stories.

**One thing to settle before writing those rows, and it is not obvious which way it goes:** a wipe is
executed BY the device being wiped, so it can only run when that device next comes online - and a
device that never returns is never wiped, whatever the server recorded. So the row proving "it became
like-new" and the row proving "the wipe ran" are not the same row, and neither implies the other. The
blacklist is what makes the first true without the second, which is exactly the reading the user's
own phrasing points at (*"c'est a ca que sert la blacklist non ?"*). The 2026-08-26 fix does not
change that - a wipe still needs the device back - but it narrows "comes online" from "is online at
the moment a frame is sent" to "logs in at all, by any path", which is the difference between a
guarantee and a coincidence.

### P2 - an offline deletion is remembered and never replayed, and DEL-10 fails on its own fix (measured 2026-08-26)

**The memory half works; the trigger half does not.** DEL-10 was `FAIL` on `c6eb7b20` because the
deletion was LOST - attempted once with the link cut, the local state purged anyway, and the group
handed back by `discoverMissingGroups`. `pendingGroupExits` fixed that half. On `2a4297cb` the row is
`FAIL` again, and what broke has moved:

| field | value | reading |
| --- | --- | --- |
| `sentWhileOffline` | 1 | the DELETE was attempted |
| `listedOnDeleter` | true | the group was NOT purged locally - the durable row did its job |
| `sentOnFirstReconnect` | 0 | **nothing replayed it** |
| `sentOnSecondReconnect` | 0 | nor the second time |
| `onServerAfter` | `live` | the deletion never happened |

So the decision is written down and kept, exactly as designed, and then no one comes back for it.
`drainPendingGroupExits` has two triggers - `ConnectivityStore.onReconnect`, and one pass at chat start
for the app killed while offline - and the check reconnects the link WITHOUT a reload, so only the
first applies. Either it does not fire for a link cut through CDP, or it fires and the drain finds no
row.

**BOTH HALVES OF THAT ARE NOW INSTRUMENTED (2026-08-27), and it took a product change as well as a
runner one.** The runner half was the easy half: `del10` snapshots `consoleLines(w1)` around each
reconnect and records `firstReconnectSaid` / `secondReconnectSaid`, so the entry now carries whether
the trigger announced itself (`ConnectivityStore` logs before it emits, so that line IS the listener
running) and whether the drain announced a replay. The product half is the one worth reading: the
drain returned a bare `[]` for `!storage` and for re-entrancy, and an empty array is precisely what a
trigger that never fired returns too - so two of the four ways to replay nothing were unnameable from
outside. They accuse now. `owed.length === 0` deliberately stays silent, because THAT one is routine:
it runs on every reconnect of every session that owes nothing, and a line there is the noise that
teaches a reader to skip `[EXIT]` and then to skip the one that matters. **The re-run is owed and
will name the cause rather than the symptom.**

**Do not read this as the old defect returning.** The two failures share a row id and nothing else: one
lost the decision, this one keeps it and never acts on it. The fix for the first is what makes the
second visible at all.

## Mentions

### P3 - a mention of a deleted account writes a browser-level console error no client code can suppress, and the row that meets it cannot declare it expected (measured 2026-09-08)

TYPE-5 came back `PASS-DIRTY` on a run whose own subject was green, with three
`GET /api/users/<64-hex> -> 404` on BOTH clients, the same three ids. They are absent from every
server table asked - `users` (368 rows), `dm_group_members`, `dm_device_group_memberships`,
`channel_members`, `key_package`, `push_token`, all zero - so nothing on the server names them. The
reference is client-local: a stored message mentioning an account that has since been deleted, which
on this estate is the campaign's own mention fixtures.

**Everything the app can do about it is already done.** `fetchUserProfile` caches a 404 for the full
30 s TTL rather than evicting it, with a docblock naming the measurement that earned the change - one
mention of an absent account used to produce three identical 404s in one check, one per mount of the
chip. So the request is made once per client per window, which is the floor for a client that must
ASK to find out.

**The line is written by the browser's network stack, not by the app**, so it cannot be caught,
downgraded or silenced from JavaScript. Two designs remove it, and both are product decisions rather
than fixes:

- the server answers **200 with a tombstone** (`deleted: true`, no name) instead of 404 - the client
  then renders "deleted account" from a real answer, and nothing logs;
- the mention carries a **name snapshot** taken when it was written, so a deleted account needs no
  fetch at all. This is also the only one of the two that survives the server forgetting the user
  entirely, and it is what makes an old message readable years later.

**Deliberately NOT declared `ignoringExpectedLog` on the row.** The shape `GET /api/users/<id> -> 404`
is indistinguishable from a client asking for a user it *should* know - a roster that named an
identity nobody minted, which is a P1 this campaign already carries. A per-row allowlist here would
silence the next one of those.

### P2 - a mention notification shows a 64-character hex id where the name should be

Found by the user on the phone, 2026-08-22, while the MENTION rung was running.

The wire format of a mention is `@[<64 lowercase hex>]` (`utils/mentions.ts`), and the WEB resolves
it at render time - `mentions.parse.ts:44` replaces `@[id]` with `@DisplayName` for bodies, previews
and reply quotes. **The Android notification does not.** `CanariFirebaseMessagingService` READS the
token (line 1332, `decrypted?.text?.contains("@[$myUserId]")`) to decide whether this is a mention of
me, and then passes the decrypted text to the notification builder unchanged. Both paths are
affected: the MLS/DM one and `handleChannelMessage`.

So the notification reads `Salut @[d82cd226…64 hex…] tu peux regarder ?`.

**It is worse than cosmetic.** `canari_mentions` is `IMPORTANCE_HIGH` and asks to bypass DND
(`CanariApplication.kt:223`): the one notification designed to interrupt someone is the one that
cannot be read. And the check that covers the path does not see it - MENTION-2 asserts that the
notification carries the marker, which is true of a body full of hex.

**THE MLS PATH CANNOT BE FIXED SERVER-SIDE, AND THE REASON IS KNOWLEDGE, NOT PRIVACY.** A DM or
group message reaches the server as ciphertext, so the server does not know a mention happened at all
- which is exactly why the Kotlin scans the decrypted text for `@[<myUserId>]` rather than being told.
No payload field can carry a name the sender of the payload cannot compute.

**The privacy argument this entry used to make is FALSE, and it was worth measuring rather than
assuming.** It said a display name in the payload would send real names of real students through FCM
and APNs. Every message push already does: `messaging.service.ts:463` calls `resolveUserDisplayName`
and ships the result as `senderName` in both the FCM data map and the APNs alert title
(`push-payload.ts`). So the objection to naming a MENTIONED user is not that names may not travel -
they already do - it is only that on the MLS path nobody server-side knows which ones to send.

**The CHANNEL path is therefore a different, much cheaper problem**, and the two should not be
bundled. `handleChannelMessage` is told `mentioned` by the server, from a cleartext
`mentionedUserIds` the sender supplies (the documented leak, MENTION-6). The server can resolve those
ids the same way it already resolves `senderName`, and the only real constraint is SIZE: `senderName`
and `groupName` are already flagged as unbounded user text against the 4 KB APNs budget
(`push-payload.ts:97`), and N mentioned names is N times that risk. Bound it - the first mention, or
nothing.

**For the MLS path the resolution belongs on the device, and this repo has TWO shapes for it.** The
one this entry originally proposed is a network fetch: `fetchAvatar(userId)` resolves a stranger's
avatar from `GET /api/mls/push/avatar/:targetUserId`, authenticated by `requesterId` + `deviceId` +
the Keystore push secret, behind a 24 h file cache, and a sibling endpoint returning
`resolveUserDisplayName` would mirror it. **The other is cheaper and better suited**, because a
notification arrives exactly when the device may be offline: `graine_seeds.json` is an app-private
file the FOREGROUND writes through a Tauri command (`store_graine_seed`) and the push service reads
with no network at all (`lookupGraineSeed`). The web already keeps a resolved-display-name cache -
`peekUserDisplayName` / `seedUserDisplayName` in `utils/users/displayName.ts` - so mirroring it is the
same three pieces the seed mirror has: a Rust command plus its `capabilities/` grant (an ungranted
Tauri command ships and rejects on a real device), a call site in the resolver, and a Kotlin reader.
No new server route, no deploy, and no name that the device did not already know.

**Whichever is chosen, it needs a substitution pass over the body before the notification is built.**

**The degrade must be decided, not defaulted - and the web decided it on 2026-08-30.** A cache miss
with no network is the exact case a notification arrives in, and it must not print hex. The mention
chip and the post mention link both stopped using the id as its own fallback that day: an unresolved
mention renders as a bare `@`, because a name that is not known YET is not the same fact as a name
that does not exist, and only the second may be painted. The notification has no second chance to
re-render, which argues for the same answer rather than a different one - a bare `@` is honest, and
`@[d82cd226...]` is not. Confirm against the native side before building.

**iOS is presumed to have the same gap and cannot be checked** - no iPhone in the estate
(`device-verification.md`). `push-payload.ts` builds the APNs half from the same fields.

**Cost, stated because it is why this is not a drive-by fix:** the channel half is server-only and
small; the MLS half is native (a Tauri command and its ACL grant, Kotlin, an APK rebuild and install)
and the rebuild re-bases A1's build for every phase of the ladder that follows it. Neither half can be
VERIFIED without a phone - a native change is checked by compiling, which proves nothing about
running.

## The harness itself

### P2 - the rig can express exactly TWO identities, and the third and fourth accounts now exist (measured 2026-09-10)

`names.mjs` exports `OWNER_NAME` and `PEER_NAME`, and the counterpart helper is
`peerNameFor = (device) => (device === 'W2' ? OWNER_NAME : PEER_NAME)`. Measured across the rig:
**79 references to `OWNER_NAME`, 151 to `PEER_NAME`, 103 to `peerNameFor`, over roughly fifty
files.** Two identities is not a limit somebody chose - it is what the campaign happened to need,
frozen into a helper whose FALSE branch is "everything that is not W2".

**A THIRD IDENTITY DOES NOT MAKE THAT HELPER WRONG, IT MAKES IT UNASKABLE**, and the failure mode is
the dangerous one: `peerNameFor('W4')` for a device held by `third` returns `PEER_NAME` - a real
name, of the wrong human, with no error. A check would click a conversation that exists and report
about it confidently. This is the same class as the display-name-used-as-identity P1 of 2026-09-09.

**WHAT THE SHAPE SHOULD BE.** `test-accounts.json` is already keyed by account (`owner`, `peer`,
and now `third`, `fourth`) and `accounts.mjs` reads it generically - it has no notion of there being
two. The names should be keyed the same way, `DISPLAY_NAME_OF[key]`, with `OWNER_NAME`/`PEER_NAME`
derived from it so no call site moves; and `peerNameFor` should resolve the device through
`ACCOUNT_OF`, return the counterpart for the two-party pair, and **THROW** for a device whose
counterpart is not defined, naming `displayNameFor(key)` as the thing to call instead. A rig that
refuses is a rig that can be extended; one that guesses cannot.

**AND THERE IS A SECOND HALF, WHICH IS WHY THIS IS P2 RATHER THAN P3.** `peerNameFor` is LOGIC, and
it lives in `names.mjs`, which is **gitignored** - so it is not reviewable, not testable, and not
carried by the handoff bundle. The split the file's own docblock argues for is SECRETS out of tree;
what is actually out of tree is secrets AND the derivations over them. Inverting it is cheap: a
machine-local `values.mjs` holding only values, and a COMMITTED `names.mjs` that re-exports it and
adds the derivations, so every call site keeps the same specifier and the helpers finally get a
test. The cost is one renamed file on each machine that already has a rig, which is why it is
recorded rather than done in passing.

**WHAT IS OWED TO USE THE NEW ACCOUNTS AT ALL** is in the first-contact P1 above: a first sign-in to
materialise each Canari user row and its display name, then a Chrome profile, `PORTS`, `ORIGIN` and
`ACCOUNT_OF` entry per device.


### P3 - a check run BY HAND can measure a bundle older than the build it stamps, and nothing refuses it (measured 2026-09-05)

`bundle.mjs` exists precisely for this and states it: a browser left open across a deploy keeps
executing the old bundle and its console reads exactly like a reloaded one. `run.mjs` asks; a check
invoked directly does not, and `record()` stamps `build` from the repository rather than from the
client.

Measured: TAB-1 was re-run three times against a fixed application and recorded `FAIL` each time
against a build whose fix its tab had never loaded. Three probes were spent before the stale tab was
the answer, and the ledger holds three rows naming a commit they did not measure. `tab1.mjs` now
reloads (as `tab4.mjs` and `tab5.mjs` already did), but that is one file remembering, not a rule:
`tab3b.mjs`, `tab7.mjs`, `notif.mjs`, `del1.mjs`, `msg4.mjs` and `mut.mjs` still do not.

The fix belongs in `recordObserved`, which is the only place that knows BOTH the verdict and the
clients it was observed on: compare each observed client's running bundle id against the deployed one
and refuse the row rather than stamp it. That is the rig's own rule - never learn by failing what a
fact could have told you - and the discriminator is already written and already exported. The care
needed is that TAB-7 asserts `neverReloaded`, so the check must REFUSE, never silently reload.


### P3 - the debris sweeper looks for a WEB-shaped store on the PHONE, so on A1 it can neither clean nor tell whether there is anything to clean (measured 2026-09-08)

`dismiss.mjs` chooses what to sweep by enumerating `CanariDB_<user>` IndexedDB databases. That is the
WEB client's shape. The phone is a Tauri app whose conversations do not live in an IndexedDB of that
name, so on A1 the sweeper reports:

```
A1 debris NOT swept: [dismiss] 0 CanariDB_<user> database(s), so none can be chosen
```

**The line is honest and it is not enough.** "None can be chosen" is indistinguishable from "there
was nothing to sweep", and those are different facts: the first leaves debris behind for the next
row to trip over, the second is a clean exit. A teardown that cannot tell them apart cannot be relied
on by any row that creates something on a device the phone can see - and every row driving A1 is such
a row, because A1 shares an account with W1.

**It cost a verdict already, in the opposite direction.** READ-10's `FAIL` of 2026-09-08 02:25 was
its teardown, not its subject. When the phone came back the row passed and the sweep still did not
run - so the `FAIL` had named the lock screen, and this gap was underneath it the whole time.

**What closes it**: either the sweeper reaches the phone's own store, or it dismisses through the
app's UI on A1 the way a user would, or it says out loud that A1 cannot be swept and the ROW fails
when it created something there. Any of the three is better than a line that reads like success.
Measured directly on 2026-09-08 that nothing was in fact left behind - no `READ10-` row on A1, W1 or
W2 - so this is a gap in the instrument, not an open debris field.

### P2 - no row on the board can tell a healthy conversation from an epoch-forked one (measured 2026-08-29)

Two production conversations sat forked one epoch behind for twenty-four hours, refusing 191 and 172
commits, and **every reading this rig takes was green throughout**: `data-ready="true"` on both tiles,
`syncing: 0`, `amber: []`. The fork was found in the SERVER's refusal count while chasing something
else. Reasoning in
[testing-methodology](testing-methodology.md#a-green-sidebar-tile-does-not-prove-the-group-is-not-epoch-forked);
this is the queue entry for the gap it leaves.

**What is missing is a predicate, not a runner.** Readiness answers *the list has painted*, which is
what it was written for. Nothing anywhere in the rig asks *is this device at the group's epoch*,
though the answer is one field: the client already holds `getEpoch(groupId)`, and the server already
answers `activeEpoch` on any refused commit and carries it in the commit-log endpoint. A `syncrows`
reader that put the two side by side would turn a class of defect that is currently found by hand,
a day late, into a per-row assertion.

**The row it belongs to is not written either.** COMM and MULTI both send and observe arrival, so
they would catch a fork that blocks traffic *in the window they watch*; neither asks the question of
a conversation it is not itself using, which is the only place a quiet fork can live. Scope it with
the four MULTI rows of queue item 3 - same shape, same devices, and the same reason none of ~200
existing rows would have caught it.


### P3 - an internet scanner can stop a `--repeat`, and separate invocations are the way round it (2026-08-26)

`GRP --repeat 5` stopped at pass 1 with `frontend-ssr NOT CLEAN ... unexplained=3`, the three lines being
`[404] HEAD /WP`, `[404] HEAD /old`, `[404] HEAD /Old` - a scanner sweeping a public host for WordPress
and a leftover backup directory.

**`srvlog.mjs` is not wrong to leave them there.** Its 404 rules are keyed on a stack prefix the
application provably cannot own (`/wp-*`, `/administrator/`, `/_next/`), and its own comments state twice
why a blanket `[404]` rule may never exist: it would forgive a route we DO own answering 404. `/WP` misses
the existing rule on case and on the absent hyphen, and `/old` is a shape a SvelteKit app could own, so
forgiving it would break the file's criterion rather than extend it.

**So the finding is not the three lines - it is that campaign throughput depends on what the internet
does to prod during a window.** Prod IS the test server, so this recurs with every new scanner spelling,
each time costing the remaining passes of a `--repeat`.

**The route round it, used the same day, needing no change to any gate:** the stop is BETWEEN passes, not
inside one - all ten checks of pass 1 ran and recorded their verdicts. Five separate `run.mjs GRP`
invocations therefore give five measured passes where `--repeat 5` gives one, with nothing disarmed. It
costs one preflight per pass.

**The real fix, when it is worth the time,** is to stop enumerating spellings and read the fact instead:
the set of paths the application owns is knowable without a build, from `frontend/src/routes/**` and
`frontend/static/**`. A 404 on a path IN that set is a defect; a 404 outside it provably cannot be ours.
That satisfies the file's own criterion better than any regex and closes the class instead of the
instance - the difference [testing-methodology](testing-methodology.md) rule 42 is about.


### P3 - the server's log SHAPES that a reader has to carry an exception for (measured 2026-08-30, one added 2026-08-31)

Read off HEAL-REVOKE-7's own run window (`srvlog.mjs --since 2026-08-30T02:31:06.469Z`, the pass that
gave `PASS-DIRTY` on `edb8d7ab`). **52 unexplained lines across four services and not one of them is
an error.** Recorded because the standing rule is that a line is either expected AND necessary or it
is the visible end of something upstream, and these are neither - they are the reason the server half
of this rung has never once been reported clean.

**The two shapes that ARE the bucket**, both `chat-delivery-service`, both `LOG`:

- `[InvitationsController] [DEVICE_MEMBERSHIPS] user=<64 hex> device=<full device id> count=12
  statuses=<twelve UUIDs, each with :active or :pending>` - emitted on every membership poll, so
  several per second while any device is settling. It alone is most of the 47.
- `[MessagingService] [PUSH_SEND] No push token for user=<64 hex> device=<full device id>` - one per
  addressee with no FCM token, on every send. In this fleet that is every desktop Tauri device, for
  ever, and one line reads `user=unknown device=pending`.

**They also put full identities in production logs.** Both print the 64-character user id and the
whole device id rather than the 8-character prefix the client's own logs use, and `social-service`
adds `[SubmitterFactsService] [FORMS] profile user=<8 hex> promo=<year> formation=<code>` at `DEBUG` -
a named person's cohort and course, in a log. Nothing here needs the full-length ids to be actionable.

**The other three are explained and must NOT be re-opened.** `[DevicesController] [DELETE_DEVICE] ...
groupsCleaned=11 keyPackagesDeleted=1 oneTimeKeyPackagesDeleted=35 queuedMessagesDeleted=13
signalled=true` is a genuine audit line and it is the SERVER-side proof that revocation drains the
frame queue - corroborated on prod the same day: of 5 621 queued frames across 53 devices, **zero
belong to any of the 223 revoked devices**. `[KICK] Reset device ... to pending` is the queued
kick+re-add P3. `Refresh refused: no canari_refresh cookie` twice on `core-service` is the wiped
victim asking with no cookie - the wipe working, which is this rung's subject.

**One line is worth a look on its own**: `[DEL_MEMBERSHIP] ... group=8c0e53b9... affected=0` - a
membership delete that matched no row. Harmless, but it means a caller believed in a row that was not
there, and `affected=0` is the only place that shows.

**A THIRD SHAPE, on the gateway, and it is the one a HUMAN reader trips over** (measured
2026-08-31: 15 in 6 hours on prod, and `sed`-grouped they are ONE shape, not several).
`handlers.rs:529` logs every read error at `ERROR`:

```
ERROR chat_gateway::handlers: WebSocket Error from <64 hex>: WebSocket protocol error: Connection reset without closing handshake
```

That is a CLIENT that vanished without a close frame - a tab closed, a phone suspended, a network
dropped, a container torn down under a live socket. The server did nothing wrong and can do nothing
about it, so it is expected and NOT necessary at that level, which is the standing rule's own
definition of noise. It also puts a full 64-character user id in a production log, like the two
above.

**The fix is a CLASSIFICATION, never a demotion**, and that distinction is the work: the read loop
must separate "the transport went away", which is routine, from "this client sent something invalid",
which is not - and it must do that on the error's TYPE, not on its text. `axum::Error` is opaque and
`into_inner()` yields a `BoxError`; the concrete type is `tungstenite::Error` at whatever version
axum resolved (0.29 today, and axum does not re-export it). **Adding `tungstenite` as a direct
dependency to downcast couples this crate to axum's private choice, and the failure mode is silent**
- an axum bump moves the version, the downcast stops matching, and every reset is an ERROR again with
nothing to say so. Answer that before writing the code; a test that asserts the classification on a
constructed error is what would make the coupling loud.

**Two readers already carry the exception for it**, and both would shrink: `EXPECTED_ERRORS` in
`srvlog.mjs` is a REGEX ON THE MESSAGE TEXT - exactly the thing the repo's rules forbid a decision to
rest on - and the fixture pinning it is `srvclassify-selftest.mjs:460`.
[testing-methodology](testing-methodology.md) documents the shape at three places.

**NOT changed here, deliberately.** Lowering a level or trimming a field changes what `srvlog.mjs`
classifies, and doing that between two passes of a running campaign would make the next window
incomparable with every window already recorded. It is a one-commit job for after the ladder.

### P2 - a LIVE socket dies in the middle of GRP-3, and no navigation explains it (measured 2026-08-25)

**Accepted as a `PASS-DIRTY` by the user's decision of 2026-08-25** - *"on peut se contenter des pass
dirty et passer a la suite"* - so this is recorded rather than blocking rung 8. The frontier drawn with
that decision is what makes it recordable: dirt whose CLASS has been read and named may pass, dirt that
is unclassified or that touches an assertion may not. This one is a known SHAPE with an UNKNOWN cause,
which is the reason it is a P2 and not a note.

**The measurement.** `GRP --repeat 5`, pass 1, 2026-08-25. Ten rows, nine `PASS`, and GRP-3
`PASS-DIRTY` on exactly one line:

    dirt_W1: wsEvents: ["11:28:30.944 Network.webSocketClosed {requestId 20644.93706}"]

Every product assertion held - `rosterBeforeRemoval: 2`, `rosterAfterRemoval: 1`,
`peerStillHoldsPreRemovalMessage: true`, `peerReceivedPostRemovalMessage: false`,
`removedDeviceLearntFromTheCommit: true`, `removedDeviceAskedToComeBack: []`. The row was recorded at
11:28:42, so the close landed ~12 s before the end of the check: inside the 30 s negative window,
roughly 18 s AFTER `removeMember` and after the post-removal send. It is on W1, the client that did
the removing, not W2, the one removed.

**WHY THE KNOWN EXPLANATION DOES NOT APPLY, which is the whole finding.** Rule 14 of
[testing-methodology](testing-methodology.md) established that every `goto` is a `Page.navigate`, that
a document replacement closes its own socket, and that `1006` follows - so `ignoringNavigation`
forgives at most `documentsReplaced` closes. This close was NOT forgiven, and GRP-3 gives it nowhere
to come from: every `openGroup` in it passes `navigate: false`, and `ensureChat` does not reload - it
clicks `text=Discussions`, a client-side SvelteKit route change, which fires
`Page.navigatedWithinDocument` and replaces no document. So `documentsReplaced` is 0, the forgiveness
budget is 0, and this is a live socket dying. `wsidle.mjs` already ruled out the other cheap reading:
W1 and W2 left untouched for eight minutes produced **zero** closes, so nothing on the path drops an
idle connection and the event is caused by something the check does.

**What is NOT known, and must not be guessed.** No console line accompanied it - READ's instance of
this shape came with `[WS] Disconnected. Code: 1006` beside it and this one came with nothing, though
that may only mean the app's own line is classified BENIGN and therefore absent from the dirt
projection rather than absent from the log. Whether the socket reopened is also unmeasured HERE:
`watch.mjs:1121` collects `Network.webSocketFrameError` and `Network.webSocketClosed` and **not**
`Network.webSocketCreated`, so a reconnection could never have appeared in this row. Reading its
absence as a failure to reconnect would be exactly the inference rule 39 warns about.

**The rate.** One in two recent runs: clean on the attempt of 2026-08-25 that stopped on the server
window, dirty on the next. GRP-3's `PASS-DIRTY` of 2026-08-24 is a DIFFERENT cause and must not be
counted here - it was an `[OUTBOX] ... evicted from ...` line from a browser left on a stale bundle,
which is what `8c248131` closed.

**How to settle it, in order, and none of it needs a new tool.** `ws1.mjs` already prints one
interleaved timeline of every `Network.webSocket*` event and every console line on one clock, written
for precisely this question on READ. Point it at GRP-3's sequence rather than READ-1's; add
`Network.webSocketCreated` to the collector at `watch.mjs:1121` first, since the reconnection is half
the answer and is currently invisible by construction. Then the discriminator is cheap: if the close
sits at a fixed offset from `removeMember` it belongs to the Remove commit path, and if it sits at a
fixed offset from the socket's own age it is a lifetime, which `wsidle.mjs` did not test because it
watched a socket for eight minutes rather than an old one.

### P2 - ONE NAMED STARTING POINT, reachable at every granularity (asked 2026-08-25)

**The user's requirement, verbatim:** *"Le preflight doit permettre d'executer chaque phase, voire meme
chaque etape de phase ou groupe d'etape en ayant le meme point de depart, independamment de ce qui a pu
se passer avant"*, and before it *"tu peux recharger la page au debut de la phase au moment de l'etape
d'initilisation, ce serait beaucoup plus simple"* and *"Si le modal de pin s'affiche, tape le pin, s'il
ne s'affiche pas, ne le tape pas, si on est sur la mauvaise page, on peut recharger la page"*. It is
their standing directive - deterministic, reproducible, explicable - applied to initialisation.

**What is true today, measured 2026-08-25 rather than assumed.** `client()` opens a CDP connection and
guarantees NOTHING about the application: not the route, not the lock, not whether a modal is up. Of
23 sampled runners, **8 assert something at their start** (`ensureChat` or `goto`) and **15 assert
nothing at all** - `msg2`, `msg3`, `msg5`, `msg67`, `msg8`, `msg9`, `msg10`, `type`, `del1`, `comm2`,
`comm14`, `tab1` among them. They inherit whatever the previous script left, which is exactly what
`client()`'s own comment admits: *"Seventeen call sites pass no match at all and were relying on the
browser having one page - true after the preflight, and silently false the moment anything leaves a tab
behind."* The preflight does the work ONCE per run, so the guarantee decays with every script after it.

**The contract to write.** One exported entry point, idempotent, with an ASSERTED postcondition rather
than a described one:

- **The target state is named, not implied**: on `/chat`, unlocked, no overlay, chat mounted, on the
  deployed bundle. The same five facts `state.mjs` already reads.
- **It is cheap when already satisfied** - read the state first, act only on what diverges. That is
  what makes it affordable to call between step GROUPS inside a phase, which is the granularity asked
  for; a call that always paid a reload would be too expensive to put there.
- **The PIN is typed only if the gate is really up** (the user's wording exactly). Detected
  structurally: `#encryption-pin`, or a button whose text is the `U+232B` backspace glyph. Never by
  searching the page text - see the predicate entry below, which is what made a false lock permanent.
- **A wrong route is repaired by RELOADING, for a web client.** Not because a reload is a fallback -
  it is a REPAIR, logged loudly, and CLAUDE.md's rule stands: a fallback is a signal, never a path.
  Reaching it means the previous check left the client somewhere, and the log is what makes that
  visible.
- **A1 is excluded from the reload, by construction.** `goto` on the phone re-locks the PIN and breaks
  Tauri's IPC callbacks into the old document; `chat.mjs` throws rather than let a caller do it by
  accident. The phone keeps the repair path.
- **It says what it erased, before erasing it.** The existing repairs are loud on purpose - *"the day
  it is something else, the line is the only warning"* - and a check that leaves a modal up is a defect
  in that check. Silent tidying would delete the only evidence of it.
- **Then every runner calls it**, and `run.mjs`'s preflight becomes that same contract applied per
  device plus the run-wide checks (identity, bundle, server window). One definition, not two.

**Why it is worth the conversion cost.** [testing-methodology](testing-methodology.md) 33 says changing
what a check READS invalidates its green rows, and that is the argument that has deferred other
wholesale conversions. It does not bite here in the same way: the contract does not change what any
assertion measures, it makes the state BEFORE the assertion known. What it removes is a class of
failure the campaign has already paid for repeatedly - a check measuring behind a modal, on the wrong
route, or behind a PIN gate - each of which produced a refusal or a hang, never a false PASS. The rows
stay; the flakiness they cost goes.

### P3 - a build names itself by a clock, and the commit is inferred from it

`/_app/version.json` carries `Date.now()` at build time and nothing else, so `resolveStamp` derives
the commit by asking git for the newest one at or before that instant. Rule 35 fixed the half that
was outright wrong - a locally built bundle was being dated against `origin/main`, a ref that does
not contain it until somebody pushes - but the derivation itself remains an inference, and it moves
if a commit ever lands carrying an earlier date than the build that preceded it (a pull of somebody
else's work, a rebase).

**The fix is the bundle carrying its own commit**: SvelteKit takes `kit.version.name` in
`svelte.config.js` and writes it verbatim into `version.json`. Setting it to `<builtAtMs>-<sha>`
keeps the timestamp the `updated` store needs to distinguish two builds of the SAME commit, and adds
the identity the harness currently guesses. `resolveStamp` then parses instead of querying git, and
the `ref` argument disappears with it.

Two constraints, both established 2026-08-22 rather than assumed:

- **The Docker image does not build the frontend.** `infrastructure/local/Dockerfile.frontend` copies
  `frontend/build/client` from an artifact the CI `build-frontend` job produced, so git availability
  is a question about the CI job and the local Tauri build, not about the image. Both have a
  checkout.
- **It changes the deployment's version identity**, which is why it was not done during the campaign:
  prod IS the test server, and a `svelte.config.js` that throws when git is absent breaks every
  build including CD. Verify the CI job's checkout depth before relying on `git rev-parse`.

### P3 - six runners carry a dead import, and fixing them now would retire green rows

`oxlint tools/cross-client-harness/` reports eight warnings across `newgroup.mjs`, `msg9.mjs`,
`ckpt.mjs`, `type.mjs`, `tabguard-selftest.mjs` and `ws1.mjs` - unused imports and one useless
spread, nothing that changes what any of them measures.

**Deliberately not fixed during the campaign.** `msg9.mjs` and `type.mjs` back MSG and TYPE, both
green on the board, and `checkSha` hashes the runner's source: touching either supersedes its rows
(`rows.mjs`), so the ledger would demand a re-run of two finished phases to pay for a dead import.
Rule 33 is what makes that automatic, and it is right to be - the ledger cannot know the edit was
cosmetic, and a human waving it through is exactly the judgement the rule exists to remove.

Sweep all eight in ONE commit once the ladder is finished, when a re-run costs nothing. Note the
harness is NOT oxfmt-formatted (`oxfmt --check` fails on files nobody has touched), so the sweep is
`oxlint` only - running the formatter would rewrite the whole directory.

### P3 - the bubble-action and observation helpers live in one runner, and every other runner re-invents them

`mut.mjs` carries `clickBubbleIcon` / `deleteBubble`, which locate a message's controls by their
lucide icon class and prove the click was RECEIVED - its own header calls this "a pattern the rest of
the harness could adopt". `search.mjs` did not adopt it and hand-rolled a confirm click that pressed
the wrong button for as long as the check has existed (2026-08-22, see `CHANGELOG.md`). The same
split exists for observation: `longestSilence` turns a hole in a client's timeline into a value, MUT's
`finish()` attaches it to every non-PASS verdict, and no other phase does - which is exactly the
evidence rung 5's one SEARCH-2 miss needed and did not have.

**Why it is not done yet, and this is the whole reason it is written down.** The shared home is
`chat.mjs`, and every phase consults `chat.mjs`. Moving a helper there invalidates MSG, TYPE, READ and
MUT under [testing-methodology](testing-methodology.md) 33 - "a board row whose phase was touched
anywhere gets re-run rather than reasoned about" - which is hours of ladder time to buy a refactor
nothing is currently failing for. So it waits for a moment when the rig can be changed wholesale and
the affected phases re-run together, rather than being slipped in mid-ladder where it would silently
cost four phases their verdicts.

### P3 - eight runners open IndexedDB by hand, and `idb.mjs` exists

`idb.mjs` (2026-08-24) is the one reader that ITERATES the databases a profile holds, filters
`CanariDB_` while excluding `CanariDBMls*`, and never decrypts. It was written because `recon.mjs`
takes the FIRST database it finds, which on a two-account Chrome profile is a coin toss, and because
reaching into `CanariDBMls*` by prefix returns an empty result that reads exactly like "nothing
queued". Counted 2026-08-24, `indexedDB.databases` appears in nine files and one of them is `idb.mjs`: EIGHT
call sites still carry their own copy of the preamble (`del1`, `dismiss`, `grainestore`, `grp`,
`identity`, `mlsdb`, `mut`, `recon`), and `del.mjs` is the only phase reading through the module.

**Why the copies are deliberately still there.** Converting a caller changes what that caller READS,
and every one of them belongs to a phase already green on the board - so the conversion invalidates
those rows under [testing-methodology](testing-methodology.md) 33, exactly as the
bubble-helper entry above does. The duplication costs nothing while it is identical; it costs a phase
the day one copy is fixed and ten are not, which is the shape `recon.mjs`'s first-database bug already
had. So this waits for the same wholesale moment: convert all eight, re-run the phases together.

### P2 - re-registering the PIN verifier strands every other client SILENTLY, and only its next unlock finds out (measured 2026-09-04)

`pin_verifier` holds ONE row per user - verifier, salt, `registeredAt` - and minting a fresh device
re-registers it. The owner's row was re-registered at **15:32:11** during the P1 reproduction, when a
device was re-minted after a PIN reset.

**Nothing told the other clients, and nothing had to, for four and a half hours.** W1 was already
unlocked and holds its derived key in memory, so it kept sending, receiving and passing checks all
afternoon against material the server had replaced. The staleness became visible only at 20:15, when
TYPE-3 killed W1's tab and forced a fresh unlock: the correct PIN was then refused with *"Votre PIN a
ete change sur un autre appareil. Recuperez vos messages avec votre ancien PIN."*

**Why this is written down rather than fixed here.** Two of the three parts may well be correct. An
unlocked session keeping a key in memory is the design; the refusal message is accurate and names the
remedy. What is NOT obviously correct is the silence: a client whose vault material has been replaced
is, from that moment, one reload away from being locked out of its own history, and it is told
nothing while it can still act. The signal exists on the server (`registeredAt` moved) and reaches no
one.

**What it costs the campaign, which is the immediate cost.** `newdevice.mjs` is the HEAL-NEW runner
and re-minting is its whole job, so every HEAL-NEW row re-registers the verifier and strands W1 and
W2 at their next unlock - hours later, in a different rung, reading as a broken client. Its
`WIPEABLE` allowlist protects the profile it wipes and says nothing about the account-wide effect of
a PIN reset. **A destructive control needs an allowlist of what it may touch**, and the verifier is
outside the one it has.

**THE REPAIR IS KNOWN AND CHEAP, MEASURED 2026-09-04 21:27.** A stranded client is fixed by WIPING
it, not by recovering it: `bun newdevice.mjs --device W1` removed the stale local material, logged
back in with no human step, answered the account's current PIN, minted `...mtnci3lc-7mhd`, and
rejoined all four conversations plus the venue's distribution group by external commit, self-service,
inside a second. The two `pending` seats the old device held on Repro Alpha and Repro Beta went with
it - `READD ... roster seat with NO queued Welcome and NO add in flight - nobody owes us anything;
serving ourselves`. It does NOT touch `pin_verifier`, so the other clients are unaffected, which a
re-registration would not have left true. **What the wipe costs is the local history, and that is
already unreadable by the time anyone notices - so the repair is free exactly when it is needed.**

**Owed before this can be closed.** Whether the same digits re-registered produce a verifier the
other clients would accept (they did not here, so the refusal is about material rather than value);
whether the "ancien PIN" recovery restores a stranded client's MLS state or resets it, which decides
whether a stranded W1 is recoverable or must be re-minted; and whether production has ever put a real
member in this state - `registeredAt` beside each device's `lastSeen` would answer it from the table.

### P3 - a check that dies mid-gesture leaves a file staged in the composer, and the NEXT check sends it (measured 2026-09-04)

MSG-4 stages a file, types a caption and clicks send. When it died between those steps - which it
did all afternoon, on a fixture that did not exist - the composer kept the staged attachment. The
next runner opened the same conversation, typed its own text and sent, and the orphaned file went
with it. MSG-6 recorded `PASS-DIRTY` on `Erreur envoi media: A requested file or directory could not
be found`, an error about MSG-4's fixture, in a check that never attaches anything. Both rows came
back clean once MSG-4 stopped dying.

**Why this is the same fault the campaign already names.** `openDM`'s docblock states that a check
may not inherit a precondition from whatever ran before it, and every runner now navigates for
itself. The composer's staging tray is a piece of state that survives that navigation, so it is
exactly the residue the rule was written about, and nothing asserts it is empty.

**What would close it.** A staged-tray assertion in the shared entry point rather than in each
runner - the same shape as `clearOverlays`, which already runs at the top of `ensureChat` for the
same reason. It is P3 and not P2 only because the dirt is LOUD: it surfaced as a recorded
`PASS-DIRTY` naming a file the check does not use, which is a verdict pointing at its own cause.
The danger is the quiet version - a valid file staged by a check that then passes, sending an
attachment nobody asked for into a row about plain text.

### P3 - TWO out-of-tree directories are both called `canari-harness`, and a decoy `names.mjs` sits in the one the harness does not read (measured 2026-09-04)

The rig keeps its secrets and state outside the public tree, and two different directories now
answer to that description because two tools resolve the same name to different places:

| Reader | Specifier | Resolves to | Holds |
| --- | --- | --- | --- |
| `tools/cross-client-harness/names.mjs` | `../../../../canari-harness/` | `<parent-of-EMSE>/canari-harness/` | `names.mjs`, the three Chrome profiles, `results.ndjson`, `logs`, `test-accounts.json` |
| `tools/play-vitals/lib.mjs` | `../../../canari-harness/` | `<EMSE>/canari-harness/` | `play-console-sa.json`, `google-services.json`, `dumps`, AND a stale `names.mjs` |
| `infrastructure/local/pull-prod-dump.sh` | `$ROOT/../canari-harness/dumps` | `<EMSE>/canari-harness/` | the production dumps |

Both are live and neither is wrong on its own - `names.example.mjs` documents `<repo>/../../` and
`play-vitals/lib.mjs` documents `../canari-harness/`, and each is accurate about itself. What is
wrong is that they share a NAME while meaning different directories, and that the one the harness
does NOT read contains a `names.mjs` of its own: same filename, same shape, same constants, one
`VENUE` line apart. Editing it changes nothing and says nothing, which is exactly what happened
during the venue rename on 2026-09-04 - the edit landed, `grep` confirmed it, and the run kept
printing the old value.

**Why this is not fixed here.** Moving either directory breaks the other reader, and both hold
credentials and state (`play-console-sa.json`, the Chrome profiles) that a wrong move destroys - so
this is a one-off gesture on the user's own machine rather than a code change, and
[ONE-OFF ACTIONS GO TO THE USER](../../CLAUDE.md). The cheap half a session can do is make each
reader PRINT the absolute path it resolved, so a wrong edit is visible in the first line of output
rather than in a value that refuses to change. Note that `STATE_DIR` is already exported and has
three consumers, so the resolved path is available and simply never shown.

## Search

### P2 - the posts search escapes the feed's filters, and scans the whole base before it answers anything

Reported by the user 2026-08-23, verbatim: *"La recherche dans les posts permet d'acceder a des posts
apres notre arrivee a l'EMSE (la recherche desactive les filtres ?)"*. Three distinct things, and
they are not the same severity.

1. **The filters appear not to apply to the search.** The feed is scoped, the search is not, so the
   search surfaces posts the scoped feed would never show. **The first task is to establish what that
   scope IS**, because it decides everything: a scope that is a VISIBILITY rule makes this a P1
   (search reads what the reader may not read), a scope that is only a convenience narrowing makes it
   a P2 surprise. Do not write code before that question has an answer - `## Open questions` is where
   an unanswered one belongs, and this entry moves there rather than growing a fix if the answer is
   not immediate.
2. **The order is backwards: filter, THEN search.** Filtering downstream means the search spends its
   whole cost on rows that were never going to be displayed. Correctness aside, it is the same work
   done against a corpus several times larger than the reachable one.
3. **It loads everything before it answers.** A post from this week should not wait on a scan of the
   entire base. The search should walk backwards in time and stream what it finds, so a recent hit is
   returned early and the long tail keeps arriving - the standing requirement is that the mechanism
   works for a corpus of ANY size, and a single up-front load is the shape that cannot.

Related but NOT the same item: in-conversation (chat) search is the entry above; this one is the
social feed. MiGallery's `fuzzyScore`/`fuzzySearch` is the reference implementation the standing
search requirement points at.

## Composer and reactions

### P2 - the app draws emoji with the platform's font, and must draw ONE bundled font everywhere (decided 2026-08-23)

**Decided by the user on 2026-08-23, and the weight is explicitly NOT a factor** (their words: the
size does not enter the decision). Canari bundles **Noto Color Emoji** and draws every emoji with it,
in the whole app and the whole site, on every platform. This is the product choice the third bullet of
the picker entry above said was owed.

**It is ONE work package with the picker fixes, not two** - the user's framing, and it is structurally
right: the picker is where the set is OFFERED and the app is where it is DRAWN, so offering what the
font cannot draw, or drawing what the picker never offers, is a single defect seen from two ends. The
picker's scroll and placement faults are described in the entry above and are not restated here.

Microsoft's Fluent Emoji was examined first, on 2026-08-23, and **rejected on coverage, not licence**.
It is MIT (copyright Microsoft Corporation, no trademark clause in the repository), so it would have
been legally clean. Measured on its git tree: 1 595 base emoji, 3 145 variants, **zero country flags**
(the only "flag" assets are Black, White, Chequered, Triangular, Crossed, Pirate, Rainbow,
Transgender and Flag-in-hole), **no family / couple / people-holding-hands ZWJ sequences** at all, and
frozen at Unicode 15.1 (its Emoji 15.1 merge is from 2024-10-02, its last commit 2025-01-30). It also
ships no font whatsoever - 12 625 files: 3D PNG 109.7 MB, Color SVG 131.9 MB, Flat SVG 17.2 MB, High
Contrast 6.4 MB. A set with no flags cannot be THE set for a French student association.

#### Why Noto, in numbers

`googlefonts/noto-emoji`, OFL 1.1, last push 2025-09-15. Measured on its git tree 2026-08-23:

- `svg/` holds **3 732 glyph sources**, of which **2 291 are multi-codepoint sequences** (ZWJ
  families, couples, professions, skin tones). Country flags live in `third_party/region-flags`, and
  the prebuilt fonts prove they are shipped: `Noto-COLRv1.ttf` 4.7 MB **with** flags against
  `Noto-COLRv1-noflags.ttf` 2.8 MB, plus a `NotoColorEmoji-flagsonly.ttf` of 0.8 MB.
- **It is level with the picker's own dataset.** Probed by codepoint: every Emoji 16 addition
  (fingerprint, leafless tree, root vegetable, splatter, harp, shovel) and every Emoji 17 sample
  taken (distorted face, orca, trombone, treasure chest) is present. That is what makes "the picker
  offers exactly what the app can draw" an achievable requirement rather than an aspiration.
- **Licence.** OFL 1.1 permits embedding in the APK/AAB/IPA/AppImage and permits modification
  (subsetting, rebuilding). The header declares `Copyright 2013 Google LLC` with **no Reserved Font
  Name**, so a rebuild does not force a rename. Two real obligations: the OFL text travels with the
  binary, and the font is never sold on its own. One notch more verbose than MIT, no practical effect
  here, and compatible with a public repository.

#### The disparity is now OBSERVED, not only predicted (user, 2026-09-09)

The user reports seeing it in the running app: *"tous les emojis de l'app (dans le selecteur, dans
les reactions, dans toute l'interface) devront etre mis a Noto Color Emoji, il y a deja des
disparites et il va falloir les regler en meme temps, sur tous les appareils."*

Three things that changes for this entry, none of them its scope:

- **It has a reporter and a date.** Everything above was written while SCOPING, from the fact that
  neither global stack declares an emoji family. The prediction has now been met, so the entry is no
  longer speculative and does not need re-justifying to be picked up.
- **The named surfaces are the picker, the REACTIONS and the rest of the interface.** Reactions were
  not listed among the surfaces that have to change, because they inherit `body` and were assumed
  covered - and an assumption is what a user just contradicted. Whether a reaction pill resolves the
  same family as the bubble text beside it is a MEASUREMENT this WP owes before it declares the two
  stacks sufficient, taken the way the entry already prescribes: read the resolved family, never
  judge the picture.
- **"En meme temps, sur tous les appareils"** is an acceptance condition and belongs with the
  campaign rows below: one glyph, drawn from one family, on Android, iOS and the web build - and the
  disparity between two SURFACES on ONE device is as much a failure as a disparity between two
  devices. It is stated here because the natural way to close this WP is per-surface, and per-surface
  is exactly how the current disparity was produced.

#### The format is the whole difficulty, and it has a solution

No single colour-font table covers both engine families, and Canari ships on both:

| Table | Chromium: WebView2 (Windows), Android WebView, Chrome/Edge | WebKit: WKWebView (iOS, macOS), Safari | Firefox |
| --- | --- | --- | --- |
| **COLRv1** | yes, 98+ | **no** - not implemented, and marked not in active development (WebKit standards-positions 415) | yes, 107+ |
| **OT-SVG** (`SVG` table) | **no**, ever | yes - Safari 12.1+, iOS Safari 12.2+ | yes, 31+ |

The two are exactly complementary, and **they fit in one file**. `maximum_color`, from
`googlefonts/nanoemoji` (Google's own tool, the one that builds Noto), adds the `SVG` table to a COLR
font and the reverse; its stated intent is "a font that will Just Work in any modern browser". Each
engine reads the table it understands, from a single `.woff2`. Where a two-file split is preferred
instead, the selector is `src: url(...) tech(color-COLRv1), url(...) tech(color-svg)`, with
`@supports font-tech()` available since Safari 17 for the awkward case.

Three things that must not be got wrong:

- **Do not pass `--bitmaps`.** Chrome and anything on Skia *prefers* CBDT to COLR when both tables are
  present (nanoemoji says so, over Skia 12945 and FreeType 1142), and CBDT is the 10.1 MB build.
  Weight is not a factor by the user's decision, but rendering the WRONG table is a defect.
- **nanoemoji describes itself as "under active development, doubtless full of bugs".** So it is not a
  CI dependency: build ONCE, commit the produced `.woff2`, and record the exact command plus the
  expected hash so the artefact is reproducible without the toolchain being installed anywhere. This
  is the opposite disposition to `frontend/src/lib/wasm/`, which is generated and not committed
  precisely because every pipeline can build it; nothing in CI can build this one.
- **Serve it from our own origin**, never Google Fonts: a third-party font host leaks the IP of every
  member and cannot work offline in the Tauri apps.

**WebKitGTK was the one target that may read neither table**, and **it is no longer a target at
all** - the Linux desktop build was dropped 2026-09-03
([cicd](cicd.md#the-linux-desktop-build-is-suspended-not-lost-2026-09-03)), so
this row owes one fewer verification than it did. Kept because it returns with the target: WebKitGTK
goes through FreeType/Skia and WebKit bug 191976 ("[FreeType] Color emoji not properly supported")
is still open. It was also the only target where the failure was free - the system emoji font on
Linux **is** Noto Color Emoji, so the fallback drew the same pictures. Never design around it; if
the desktop target comes back, verify it once on a real build.

**And note what this is, under the standing rule that a fallback is a signal and never a path**: a
font stack IS a fallback chain, so "it looks right" is not a verdict. The question is always *which
family resolved*, and that is measurable - see the campaign rows below.

#### What has to change in the app

- **The two global stacks are the whole of it, and neither has an emoji fallback today**, which is why
  100 % of emoji are currently the platform's: `frontend/src/app.css:134` (`body`) and
  `frontend/src/app.css:144` (`h1`-`h6`, `.font-brand`). Append the bundled family to both.
- **The picker uses the same family or the app disagrees with itself.** `emoji-picker-element` 1.29.1
  exposes `--emoji-font-family` on the element; that is the entire change on that side.
- **Every stack that is re-declared for an EXPORT is a place the screen and the artefact can
  disagree**, and each one must be handled explicitly: `PosterCanvas.svelte` (4 inline stacks),
  `calendarExport.ts`, `trombinoscope.ts`, `avatar.ts` (an SVG data-URI stack), and
  `MentionComposerInput.svelte:399` (monospace).
- **A PDF is not a browser.** `frontend/src/lib/pdf/appFonts.ts` maps a computed stack plus a weight
  onto an embedded jsPDF font, so an emoji in an exported PDF is a separate question this WP owes an
  answer to (embed, or rasterise). The CSS change does not cover it.
- `font-display: swap` plus a preload, and the font shipped as a bundled app asset so the mobile
  builds have it at first paint with no network. An invisible emoji while a font loads is worse than a
  platform emoji.

#### The picker must offer exactly what the font can draw

- **What it offers today**: `frontend/static/emoji-data-fr.json`, 540 KB, emojibase FR, **1 923 base
  entries / 3 953 including skins**, groups 0-9 all populated (270 flags, the France flag present,
  249 ZWJ entries), with `version` values up to **Emoji 17**.
- So the offered set and Noto are level, and the WP owes a **build-time diff that proves it**: every
  codepoint and every sequence in the dataset must resolve to a glyph in the shipped font (`cmap`
  plus the `GSUB` ligatures that make a flag or a ZWJ family one glyph). It belongs in the build
  recipe, not in a one-off notebook. A miss is then either a font to rebuild or an entry to drop -
  either way a known fact, not a surprise on a member's screen.
- **DEFECT FOUND WHILE SCOPING THIS, and it is the "offers everything" half.**
  `MessageEmojiPicker.svelte:256` reads
  `data-source={getLocale() === 'en' ? undefined : '/emoji-data-fr.json'}`, and `undefined` means the
  element's default, which is
  `https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json`
  (`picker.js:1649`). So on the English locale the app fetches its emoji data from a third-party CDN -
  an outbound request, hence an IP leak, for every user who opens the picker; the picker cannot open
  offline, which is fatal in the mobile apps; and `@^1` pins nothing, so the offered set changes under
  us, which is exactly the non-determinism the standing directive forbids. **Self-host the EN dataset
  the way FR already is, and pin both.**
- `emojiUnsupportedMessage` is shown by the library when it detects no colour-emoji support at all.
  Once a font is bundled, decide whether that state is still reachable (WebKitGTK is the only
  candidate) and delete the string if it is not - a message nothing can display is noise in
  `messages/*.json`.

#### What a future campaign owes - asked for by the user on 2026-08-23

These are rows for the **second campaign** (see that entry below); they are listed here, once, and are
not restated there. Every one names the evidence it rests on, because "the emoji looked fine" is not
an observation.

1. **The bundled family actually resolved**, per platform, on W1, W2 and A1 - plus an iPhone when one
   exists. `document.fonts.check()` is necessary and not sufficient: it answers "loaded", not "used".
   The verdict rests on a rendered-pixel comparison of one known codepoint against the same codepoint
   with the platform family forced. **Identical pixels mean the bundled font did NOT apply.**
2. **The same codepoint is the same picture on every device.** One message carrying a v1 emoji, a
   country flag, a ZWJ family, a skin-toned person, an Emoji 16 and an Emoji 17 addition; compare the
   rendered bubble across W1, W2 and A1. Cross-device identity IS the point of this WP, so this is the
   row that fails if the font silently did not load on one client.
3. **A flag and a ZWJ sequence render as ONE glyph**, not as two letters or five people. This is the
   row Fluent would have failed outright, and a font built without its `GSUB` fails it too.
4. **The whole set is reachable in the picker**: scroll to the last row of the last group, on a short
   viewport, with the recents row both empty and full - the two states whose heights differ, which is
   the arrangement the picker entry above traces the clipping to.
5. **The panel is entirely inside the viewport** at each anchor: first message, last message, a row at
   the top edge, one at the bottom, on the own side and the peer side.
6. **French search still finds things** (the FR dataset is load-bearing for keywords) **and English
   search works with the network off** - the row that would have caught the jsdelivr default.
7. **Pick, send, peer**: the codepoint the peer receives equals the one picked, and it is still a
   CODEPOINT - copy the text out and assert on it. That is the proof the app stayed on the font path
   and did not drift into image substitution.
8. **A reaction** carrying a flag and a ZWJ sequence survives the round trip, including the
   distinct-reaction limit path.
9. **The notification shade is drawn by the OS**, so an emoji in a notification body uses the SYSTEM
   font and will not match the app. Assert what it does; do not assert that it matches.
10. **Exported artefacts**: an emoji in a poster, a calendar and a trombinoscope export. Whatever this
    WP decides for PDF, the campaign asserts it.
11. **Cold start, offline, on A1**: open the picker with no network and confirm the set is complete AND
    that no request left the device - an assertion about the absence of an outbound request, which the
    harness's server window can support.

#### Limits to state before anyone reports them as bugs

- **The notification shade, the OS share sheet, the keyboard's own emoji panel and every other native
  surface are drawn by the platform.** Bundling a font changes nothing there. "The notification shows
  a different emoji" is then expected behaviour, not a regression.
- A member on an Android WebView older than Chrome 98 gets neither table and falls back to the system
  emoji font - which on Android is Noto anyway, so the picture is unchanged. `minClientVersion` is not
  the lever for this.


## Storage and retention

### P1 - one frame is decrypted by three engines against one receive ratchet, and the resume reload puts that ratchet BACK - measured on the Mi 9T 2026-09-08; plus an unexplained SEND-side rewind from 2026-09-06

Read off W1 and W2 simultaneously, as `severe`, during an otherwise clean NOTIF-1b:

```
[MLS] LOST frame for 2bd5add9... from f7a9bb80...: generation consumed but this frame
      was never processed - the sender's ratchet rewound (SecretReuseError, frame 5p:1rurzth)
MLS decryption failed at exactly its own epoch, so no redelivery can help:
      group=2bd5add9... msg_epoch=139 group_epoch=139 err=SecretReuseError
```

`f7a9bb80...` is the PHONE, and the frame was its read receipt for the warm-up message. Same epoch on
both sides, so this is not an epoch gap: a generation the peers had already consumed was re-issued.
Both peers then paid a full history reconciliation to discover they already agreed.

**THE DIAGNOSIS THIS ENTRY WAS FILED WITH WAS WRONG, AND THE CORRECTION MATTERS MORE THAN THE
ENTRY** (2026-09-06). It quoted section 8's *"what is still owed... is a durable record of what the
ratchet has already spent, written per send... and consulted at load"* and concluded **"that record
has not been written."** It has. It was written and shipped on 2026-08-14, and every piece of it is
in the tree:

| piece | where |
| --- | --- |
| the counters | `src/lib/mls-client/sendRatchetLedger.ts` (+ its own test file) |
| the pairing | `BaseMlsService.persistCheckpoint` |
| the repair | `BaseMlsService.reconcileSendRatchets`, called from inside `init` |
| the burn | `MlsManager::skip_send_generations` (`mls-core/src/messaging.rs`) |
| the proof | `mls-core/tests/burn_spent_generations.rs`, `burn.mjs` on web AND native |

The claim survived because section 8 states the debt in a paragraph that sits ABOVE the subsection
recording its payment, and because the wiki gives the ledger's path as `services/` when it lives in
`mls-client/` - so a grep for the file at the named path finds nothing and the prose above appears to
confirm it. **This repository's own rule is that a claim of staleness must name the mechanism that
would honour it and show that mechanism GONE**; this entry named it and never looked. Anyone acting
on the old text would have rebuilt a shipped mechanism from scratch.

**SO WHAT ACTUALLY REWOUND?** The ledger closes the JS load path: a client that sends, is reloaded
before the checkpoint lands, and drains its queue in JS burns the deficit first. It does not cover
every engine. On Android **four** engines advance the same ratchet - foreground Tauri, FCM JNI,
Worker JNI, and the native outbox drain `send_messages_background_with_key` - and only the foreground
consults `sendRatchetLedger`. The native drain loads `mls.bin`, encrypts each queued entry, saves
once, and never asks whether the foreground has emitted frames that have not reached disk.

Two things keep that from firing constantly, and the observed run is where both give out:

- `background_write_mls_bin` refuses while `foreground_is_active()`, and the whole call fails, so no
  ciphertext escapes. But that guard is **a 30-second deadline refreshed by heartbeat**, and it is
  released deliberately on `hidden`. A backgrounded-but-ALIVE app - which is precisely what NOTIF-1b
  asserts, *"process alive and still ACKing"* - has released the guard while its JS engine still
  holds a live in-memory client.
- `reloadStateFromDisk` is what re-syncs the foreground to a background advance, and its ONLY caller
  is the `visibilitychange` **resume** branch in `ChatBackgroundService.svelte`. A phone that is
  backgrounded and never resumed never runs it.
- `reconcileOutboxSent` is likewise one-way and login/resume-only: the native side records what IT
  delivered and the JS drains that file later. Nothing tells the native drain what the FOREGROUND
  has already emitted.

So the shape that fits the evidence is **two engines holding one ratchet with no reconciliation
between them while the app is backgrounded and alive** - and the frame that was refused was the
phone's read receipt for the warm-up message, sent around exactly that transition. **This is a
hypothesis with a mechanism, not a measurement**, and it is written that way on purpose: the run's
logs were not read for a `[BG_SEND]` line beside the rewind, and that single line is what would
settle it. What is NOT a hypothesis is that the ledger exists and that the native drain does not
consult it.

**THE MEASUREMENT WAS TAKEN, 2026-09-08, AND IT REFUTES THE HYPOTHESIS ABOVE.** The window was
captured in full (`adb logcat -v time` to a file, kept for the whole run) around two consecutive
NOTIF-7 `bg` runs that both reproduced the error - same group `2bd5add9...`, same epoch 196,
generations 35/36 then 43/44, so the fault is deterministic rather than a flake. **There is no
`[BG_SEND]` line and no background `mls.bin` write anywhere in either capture.** By the branch this
entry set itself, that closes the send-ratchet reading: the native outbox drain was not running, and
nothing this entry blamed was involved.

**WHAT IS THERE INSTEAD IS A RECEIVE-SIDE DOUBLE-CONSUME, AND IT IS TWO DEFECTS, NOT ONE.** The four
decryptions of the same two frames, one epoch, one sender leaf:

| # | time | driver | generations | result |
| --- | --- | --- | --- | --- |
| 1 | 09:33:24.66 | FCM JNI push (`load_or_create`, then `decryptProto`) | 43 | OK, `writeFcmCache` |
| 2 | 09:33:30.564 | `recevoir_messages_batch group=2bd5add9... count=2` | 43, 44 | OK |
| 3 | 09:33:30.647 | `recevoir_messages_batch group=2bd5add9... count=2` **again, 83 ms later** | 43, 44 | **`SecretReuseError`** |
| 4 | 09:33:36.098 | `[PENDING] Fetched 2 pending` -> `[QUEUE] Drain` | 43, 44 | **OK AGAIN** |

**DEFECT A IS FOUND, FIXED AND NOT YET SHIPPED - THE BARRIER WAITED 0 ms ON PURPOSE.** The archive
replay does take a barrier before it reads, and the barrier printed the session it was about to
overrun: `[QUEUE] mailbox barrier for "archive replay" is waiting behind 1 catch-up session(s) on
[2bd5add9...]`, then `waited 0ms`. `settleBarrier()` waits for the pull and for the scheduler's
buckets, and a catch-up hands `decryptPage` straight to the engine - so while its batch is in flight
the pull is done and every bucket is empty. **`isIdle` answers "is my queue empty" and was being read
as "is the group quiet".** The gate that answers the second already existed and every send has
awaited it since 2026-08-14; the barrier now calls `waitForCatchUpIdle()` before settling. The test
named after this behaviour asserted the two `debug` lines' WORDING and passed on the defect - both it
and its neighbour now assert the ordering. `CHANGELOG.md` carries the account. **Owed: the field
re-measurement on a rebuilt APK** - the unit test proves the ordering, not the disappearance of the
`E/` pair on the handset.

**DEFECT A, AS IT WAS MEASURED - TWO CONCURRENT READERS OF ONE PENDING QUEUE (rows 2 and 3).** Two `recevoir_messages_batch`
calls 83 ms apart carry the SAME two frames; the loser burns an `E/` pair through openmls per frame
and pays a history reconciliation to discover it agrees. The product already knows: at 09:33:30.677
it prints `[History] frame already read live while this page was decrypting - not a loss` once per
frame. **That line is the reconciling ledger this repository's own rule forbids as a fix** - *a race
that heals cleanly is still a defect... a ledger that reconciles them afterwards is a witness, never
a fix*. The overlap is named in the message itself (*while this page was decrypting*), so what is
owed is the deletion of the overlap: one owner drains a group's pending queue, decided by a fact.

**DEFECT B - THE RESUME RELOAD REWINDS THE RECEIVE RATCHET, AND THIS IS THE FIRST MEASUREMENT OF THE
PREKEY ENTRY'S CANDIDATE 2.** Row 4 is the same two generations, already consumed twice, decrypting
successfully a third time - which can only mean the secret tree went backwards. Between rows 3 and 4
sits exactly one event: `[MLS][Tauri] mls.bin reloaded on resume (C2) - group cache refreshed`,
after `[09:33:31] [MLS] Bulk ingest done`. **The epoch never moved** - 196 on every line of the
capture - so `swapClientMonotonic`'s epoch comparison could not see it, which is precisely what the
prekey entry predicted in as many words: *"a generation that moved inside one epoch is just as stale
and completely invisible to it"*. It is now observed rather than predicted, and on the RECEIVE
ratchet, where the `[RESUME] reload DROPS KEY MATERIAL` accusation - which counts key packages -
could never have fired.

**DEFECT B, ISOLATED TO THE MILLISECOND ON A BUILD THAT NO LONGER HAS DEFECT A (2026-09-08 09:53).**
With the barrier fixed the group is decrypted by ONE batch and openmls raises nothing - and the
rewind is still there, now with no other explanation in the window:

```
09:53:03.355  gen 45
09:53:11.397  gen 45      09:53:11.438  gen 46
09:53:16.801  [MLS][Tauri] mls.bin reloaded on resume (C2) - group cache refreshed
09:53:16.913  gen 45      09:53:16.973  gen 46      <- both derived again, both succeed
```

The reload is the ONLY event between the two pairs. Generations already spent are re-derived 112 ms
after it and the engine accepts them, which it can only do if the secret tree went back. No epoch
moved. **So B does not depend on A, is not a consequence of the duplicate batch, and survives its
fix** - which is worth stating because the two were found in one capture and the cheap conclusion
would have been that one caused the other.

**AND THE KEY-PACKAGE ACCUSATION FIRED IN THE SAME RUN, WHICH IS THE OBSERVATION THE PREKEY ENTRY
WAS OWED.** At 09:51:43.207, `error` level, before the reload installed 13 ms later:

```
[RESUME] reload DROPS KEY MATERIAL - live keystore holds 2625 key package(s), the mls.bin being
loaded holds 2624. Every group is at or ahead of its live epoch, so the epoch guard cannot see
this. The 1 lost bundle(s) are packages this device may have PUBLISHED, and the reconciliation
will read them back as server orphans and purge the pool (see backlog: the prekey purge loop).
Accepted anyway - see the comment above for why refusing would be worse.
```

A `KeyPackage published` follows at 09:51:45.222. **Two ledgers, one mechanism**: the reload puts
back both the receive ratchet and the keystore, and the instrument shipped that morning can see only
the second. It did NOT fire on a resume driven by hand at 09:28 with no mint in the window, which is
the discriminator the entry predicted: the accusation needs a mint between the last checkpoint and
the resume, and a checkpoint here costs 8.8-23 s.

**WHY B IS THE SERIOUS HALF.** A rewound receive ratchet re-opens generations the secret tree had
retired, which is the replay window `SecretTree` exists to close; and it discards whatever the
foreground advanced while the blob was being read, which on a device where the checkpoint costs
8.8-23 s is a wide window. The two defects also explain each other's visibility: A is what makes the
same frames arrive three times, and B is what lets the third arrival succeed.

**WHAT THIS DOES NOT SAY.** Nothing here was lost to the USER on these runs - the FCM cache
pre-injected the message (`[FCM_CACHE] Injection done: 1/1`), the row landed with its marker, and
NOTIF-7's own verdict is `PASS`. This is a correctness and noise defect measured through the logs,
which is the reason the logs are read on every pass.

**AND THE 2026-09-06 OBSERVATION IS A DIFFERENT DEFECT FROM THIS ONE**, sharing only the error
string. That one was read off W1 and W2 as the phone's SEND of a read receipt at epoch 139; this one
is read off the phone as its own RECEIVE at epoch 196. Two ratchets, two directions, one message.
The send-side one is still unexplained and still owed a measurement - and it now needs one taken
from the phone, because the branch this entry offered has been spent on the wrong ratchet.

**AND THE 19.5 MB `mls.bin` IS WHAT MAKES IT LIKELY RATHER THAN THEORETICAL** - the two entries above
are one defect seen from two ends. `checkpointAfterSend` deliberately does not await, which was the
right call at the measured 1.5 s it cost in August. On this device the same checkpoint now costs
**17.1 / 17.1 / 19.7 seconds**. So between a send and its state reaching disk there is a window of
up to twenty seconds in which any death of the process - `am kill`, an OOM, a reinstall, the user
swiping the app away - restores an `mls.bin` behind frames that have already left. The window was
sized for 1.5 s and is now more than ten times that, on the only kind of device where the OS kills
processes routinely.

**What is owed, in order.**

1. **The spent-generation record**, as section 8 already specifies it: per send, a key/value write,
   consulted at load, and the burn - which is already designed, shipped and safe by
   `SenderRatchetConfiguration::new(2000, 2000)` - applied against the deficit it finds. Nothing new
   needs inventing; it needs writing.
2. ~~**The blob measurement above**, because it decides whether the window can be shrunk at all or
   only survived.~~ **TAKEN, 2026-09-06, AND IT ANSWERS "ONLY SURVIVED" FOR NOW.** The blob is
   dominated by accumulated key package bundles at 1 936 bytes each (~60% of a state that also holds
   41 groups), and **sends themselves cost ~0 bytes** - so no amount of message history explains the
   window, and shrinking it is not something this device's own use can achieve. The prune added the
   same day BOUNDS growth at 84 days but reclaims nothing younger, so the seventeen seconds stand
   until the two accrual paths are closed. **The spent-generation record is therefore not optional
   and not deferrable**: it is the only thing that makes the window survivable, and item 1 no longer
   has a cheaper alternative waiting behind a measurement.

**Do NOT "fix" this by awaiting the checkpoint.** That was measured and refuted in August at 1.7 s
per send, and it would now cost seventeen. The invariant is not "the state is durable at send time"
but "a state restored behind a frame that left is RECOGNISED and repaired", which is a counter and a
burn.

### P2 - the notification QUICK ACTIONS exist only while the app is DEAD, which is why check K's backgrounded case has never been performable (measured on the Mi 9T, 2026-09-06)

Two posters write Canari's Android notifications and only one of them is the app's own.

| | posts when | style | quick actions |
|---|---|---|---|
| `CanariFirebaseMessagingService.showNotification` | a push arrives - i.e. the app is killed or its ACK was late | `MessagingStyle`, stacked, self `Person` | `buildReplyAction` + `buildMarkReadAction`, always, on any non-`channel_` conversation |
| `useNotifications.svelte.ts` -> `sendNotification` | the JS layer has the frame - i.e. the app is ALIVE, foreground or background | whatever `tauri-plugin-notification` builds | **none** |

The notification record read off the device for a real message received while backgrounded carries
no `actions` at all, and the shade drew no `Repondre`. So the gesture `device-verification.md` step
4 asks for **cannot be made** in the state check K is written about, which is a better explanation of
why that re-measurement has sat unmade since 2026-08-30 than "nobody got round to it": the 2026-08-30
PASS was taken on a KILLED app, where FCM posts and the actions exist.

**This is not the same defect as the missing body** (fixed 2026-09-06 by giving every `sendNotification`
a `largeBody`; see `CHANGELOG.md`). That one was the plugin dropping text it had been handed; this is
the app never asking for the actions on this path at all. WP-XP-1 shipped them believing they were on
every message notification.

**What is owed before anything is written**: decide whether the JS path should post through the
Kotlin service - which already builds the right thing, stacks by conversation, and refreshes the
badge - or grow its own actions. The first removes a poster rather than teaching a second one the
same lesson, and is the shape the rest of this codebase has converged on everywhere else; it needs a
Tauri command bridging into `showNotification` and an answer to what happens on desktop, where
neither the service nor FCM exists. **Check K stays unmeasurable in the backgrounded case until this
is decided**, and `archive/k.mjs` records `SKIPPED` rather than `FAIL` when no reply is made, so a
run cannot be mistaken for a product verdict.

### P3 - the verdict vocabulary lives in two files and is enforced by neither, so a runner inventing a word makes the reconciler wrong about the board (2026-09-06)

`results.mjs` decides what a check may record; `rows.mjs` carries its own `CLAIM` map to read those
words back off the board. Nothing ties them together, so a runner that records a verdict the map
does not list makes `rows.mjs` report `board: unstated` for a row the board states in full - which
is a false accusation in the one report whose whole job is to be right about the board.

**It has now happened twice, and the second time the warning was already written above the bug.**
`INCONCLUSIVE` was missing and PIN-11, the first row to record one, read as unstated; a comment was
added at that spot saying exactly why this must not recur. On 2026-09-06 `SETUP-FAILED` - which
`heal-w2.mjs` has recorded since it was written - did the same thing to HEAL-W2. A comment is not a
mechanism, and a vocabulary shared by two files and owned by neither drifts the moment a runner
invents a word.

**The fix is ownership, not another entry in the map.** `results.mjs` is where a verdict comes into
existence, so it should EXPORT the list, and `rows.mjs` should import it - then a new verdict is
readable by both sides or by neither, and the failure is a missing import rather than a silent
misreading. A self-test asserting that every verdict `results.mjs` can produce is recognised by
`rows.mjs` would pin it, and belongs with the other harness self-tests. `SETUP-FAILED` is added to
the map meanwhile so the board reconciles today.

### P1 - THE DEVICE PURGES 49 OF THE 50 PREKEYS IT HAS JUST PUBLISHED, SO THE POOL NEVER FILLS AND IT MINTS FIFTY MORE ON EVERY CONNECTION (measured on the Mi 9T, 2026-09-06 evening)

#### THE OBSERVATION THIS ENTRY HAS BEEN OWED IS TAKEN - Mi 9T, 2026-09-08 17:08-17:10, `a1Build fff05fe14`

*"Nobody has seen any of the three on a device yet."* Two of them are now on the record, from two
ordinary NOTIF-1b reconnections on a SWEPT estate:

```
17:08:37.734  [MLS][Tauri] generateKeyPackage native batch path needed=0
17:09:14.547  [MLS] reconcilePublishedKeyPackages: REFUSED to purge 6/50 prekey(s) this session
              published itself - the device cannot back a package it just minted
17:09:34.586  [MLS][Tauri] generateKeyPackage native batch path needed=0
17:09:59.928  [MLS] reconcilePublishedKeyPackages: REFUSED to purge 6/50 prekey(s) ...
```

**`REFUSED` DOES NOT MEAN THE SEAM HELD, AND THE TABLE ABOVE SAID IT DID.** It means the seam BROKE
and #393 caught it: `keyPackageHasPrivate()` returned **false for six packages this session had just
minted**, which is impossible if the round trip cannot change a byte - the device holds those private
keys by construction. The guard recognised them by fingerprint and refused. That row is corrected in
place: `REFUSED to purge N/M` is the ACCUSATION, not the all-clear.

**AND NOTHING WAS PURGED AT ALL.** The `purged N/M` line is absent from both reconnections, so
`orphanIds.length` was zero. No `[RESUME] reload DROPS KEY MATERIAL` either, though a logcat buffer is
bounded and that is weaker evidence than the two lines that did appear.

**THE POOL IS NOW THE HEALTHY SIGNATURE THIS ENTRY DEFINED.** On 2026-09-06 all fifty carried a single
timestamp to the microsecond - one batch, nothing older beside it. Today, same device:

| | 2026-09-06 | 2026-09-08 |
| --- | --- | --- |
| mint timestamps behind the 50 | **1** | **6** (18 + 8 + 6 + 6 + 6 + 6) |
| `generateKeyPackage ... needed=` | 49, 49, 49, 50 | **0, 0** |
| reconciliation | `purged 49/50` | `REFUSED to purge 6/50`, nothing purged |

Six mint timestamps summing to 50 is *"topped up incrementally (several mint timestamps) - the design
working"*, which this entry's own population table counted on 39 production devices. The catastrophic
loop is CONTAINED.

**THE GROWTH IT FED IS SLOWED, NOT STOPPED.** `mls.bin` went 10 237 105 -> **10 376 276** bytes across
the afternoon and four or five runs - about 139 kB - against the **~389 kB in ONE run** recorded above
when the loop was live. Call it an order of magnitude, measured rather than modelled. The blob does
not shrink, so **10.4 MB is still what a checkpoint re-encrypts per message**, and that is what makes
NOTIF-1b's warm-up 19 992 ms and the row ungradeable.

**WHAT IS STILL OPEN, NARROWED TO ONE SENTENCE.** Why does `keyPackageHasPrivate()` answer false for
six packages this process minted minutes earlier? The guard makes it harmless and says so; it does not
explain it. Candidate 1 was refuted from the code on the grounds that the round trip cannot change a
byte - and this measurement is that refutation's problem, not its confirmation: the bytes did not
change and the answer was still false, so what differs is the KEYSTORE the question is asked against,
which is candidate 2's family. **AND THE LINE THAT WOULD HAVE NAMED IT COULD NOT FIRE - FIXED
2026-09-08.** The resume guard compared CARDINALITIES (`candidate_count < live_count`), and a reload
that drops six bundles while a mint adds six leaves the cardinality identical. That is exactly the
shape above - six unbacked out of fifty - and `[RESUME] reload DROPS KEY MATERIAL` was silent on both
reconnections. The downstream symptom was loud and its cause was mute, which is why this entry called
candidate 2 unobserved for two days. `MlsManager::key_package_keys()` now exposes WHICH bundles a
keystore holds, the guard reports the SET DIFFERENCE, and the line carries both cardinalities beside
it: `lost=6 live=50 loading=50` is a substitution and `lost=6 live=50 loading=44` is a shrink, and
they are different accidents. Proved by a test that expires one batch and mints another of the same
size, so the counts agree and the set names all six (`reload_monotonic.rs`). **The next device
reconnection can now answer this entry's last question**, where before today it could not have.

#### CANDIDATE 2 IS REFUTED AT THE RELOAD BOUNDARY, AND THE SAME SHAPE WAS **PURGED** THIS TIME - Mi 9T, 2026-09-08 17:51-17:53, `a1Build e2d09c211`

The guard that could not fire is shipped, so its silence is now worth something. Two ordinary
background/foreground cycles on the rebuilt APK:

```
17:51:29  load_or_create: 10360876B total; KeyPackage 2919x6901168B, Tree 5x1704647B, MessageSecrets 5x1701037B
17:51:35  generateKeyPackage native batch path needed=0
17:51:49  KeyPackage published.
17:51:50  reconcilePublishedKeyPackages: purged 6/50 orphaned prekey(s)
17:52:18  load_or_create: 10363262B; KeyPackage 2920x6903554B
17:52:18  [RESUME] foreground manager reloaded from mls.bin (C2)
17:52:18  generateKeyPackage native batch path needed=6
17:52:23  generer_key_packages_et_persister done count=6 state_bytes=10395269
17:53:19  load_or_create: 10379829B; KeyPackage 2927x6920121B
17:53:19  [RESUME] foreground manager reloaded from mls.bin (C2)
17:53:19  generateKeyPackage native batch path needed=0
17:53:23  generer_key_packages_et_persister done count=0 state_bytes=10397667
```

**THE RESUME RELOAD DOES NOT DROP KEY MATERIAL, AND THIS RUN CARRIES ITS OWN POSITIVE CONTROL.** Both
reloads are announced by their own `(C2)` line and neither is followed by `[RESUME] reload DROPS KEY
MATERIAL`. Before today that silence was uninformative - the detector compared cardinalities and a
six-for-six substitution is invisible to a count. It reports the SET DIFFERENCE now, so a substitution
at that boundary would name itself.

And the run does not merely fail to show a loss, it shows a SURVIVAL, which is the harder thing to
arrange and the reason this is a refutation rather than an absence. Six bundles were minted at
17:52:18 and persisted by 17:52:23; they were published at 17:52:27; and the **next** reload, at
17:53:19, is a reload that happens strictly AFTER a mint - the exact ordering candidate 2 requires.
It carried them: `KeyPackage 2920x` before, `2927x` after, `needed=0` on the other side, and the guard
silent. A reload that discarded a mint would have been named by both the set difference and the
subsequent `needed=`, and neither fired.

**SO CANDIDATE 2 SURVIVED ONLY IN A NARROWER FORM - AND THAT FORM WAS THEN REPRODUCED ON PURPOSE.**
The mint is not instantaneous: `generer_key_packages_et_persister` ran from 17:52:18.198 to
17:52:23.034, **4.8 seconds**, while a reload costs ~30 ms. What the two cycles above never produced is
a reload landing INSIDE that window - both times the reload preceded the mint by ~110 ms. A snapshot
read while a mint is in flight is the only ordering in which the server can hold a package whose
private key never reached the file, so ten of the phone's fifty prekeys were deleted from the local
estate's `one_time_key_package` to force `needed=10`, and the app was resumed, backgrounded and
resumed again across the mint. **18:02:04 - 18:02:14, and every line of it is the defect:**

```
18:02:04.730  thread 15666  generer_key_packages_et_persister start count=10      MINT BEGINS
18:02:08.926  thread 15669  load_or_create ... KeyPackage 2928x                   snapshot READ mid-mint
18:02:09.571  thread 15666  generer ... done count=10 state_bytes=10423737        MINT PERSISTS
18:02:09.592  thread 15669  [RESUME] reload DROPS KEY MATERIAL - 11 bundle(s) ... live=2939, loading=2928
18:02:09.599  thread 15669  [RESUME] foreground manager reloaded from mls.bin     STALE SNAPSHOT WINS
18:02:14.429                REFUSED to purge 10/50 prekey(s) this session published itself
```

Two threads, one manager. 15669 read the file 0.6 s before 15666 wrote it and installed the result
0.03 s after - erasing ten bundles whose public halves were already on the server. The detector named
the loss the instant it happened, which is what #441 bought.

#### THE CAUSE IS A LOCK ORDER: THE RESUME READ OUTSIDE THE MANAGER LOCK AND INSTALLED INSIDE IT - 2026-09-08

`recharger_mls_au_resume` read `mls.bin` under `mls_bin_write_lock`, RELEASED it, decrypted, and only
then took the manager lock to install. The comment above that release said the foreground guard closed
the gap. It does not: `mark_foreground_active()` stops **background JNI engines**, and the writer that
races here is `generer_key_packages_et_persister`, a FOREGROUND command that holds the manager lock
while it mints and writes the file at the end of that same critical section. Nothing on the resume path
observed it.

**AND THE TWO PATHS TOOK THE SAME TWO LOCKS IN OPPOSITE ORDERS**, which is the same defect read from the
other side:

| | first | second |
| --- | --- | --- |
| the mint | `mls_manager` | `mls_bin_write_lock` (inside `write_mls_state_blob`) |
| the resume reload, until now | `mls_bin_write_lock` | `mls_manager` |

An inversion like that is normally a deadlock. This one was not, only because the reload released the
first before taking the second - and **that release is the window**. So the fix is not a retry, a
re-read or a reconciliation: the reload now takes the manager lock FIRST and holds it across the read,
the decrypt and the install. A mint in flight makes the reload wait and read the file it wrote; a
reload in flight makes the mint wait and mint into the manager just installed. There is no interleaving
left for a ledger to notice afterwards, and the lock-order inversion is gone as a side effect. The cost
is that the manager is unavailable for the ~600 ms a 10 MB `mls.bin` takes to decrypt, which is the
point rather than a regression: an MLS mutation running against a manager about to be replaced IS the
defect.

**THE ORDERING IS NOW A COMPILE-TIME PROPERTY, BECAUSE A COMMENT IS NOT A GUARANTEE.** The read, the
grading and the install moved into `reload_into(live: &mut Option<MlsManager>, ...)`, and the only way
to obtain that `&mut` is to hold the guard - so the read cannot be hoisted back out of the critical
section without a type error. A unit test cannot observe which of two locks a caller takes first, and
the test added beside it does not pretend to: it pins the other half, that the bytes are fetched INSIDE
the call, so moving the read back into the command changes the signature and stops it compiling.

**THE OTHER SITE THAT REPLACES A LIVE MANAGER IS NAMED HERE AND DELIBERATELY NOT TOUCHED.** Exactly two
places assign the foreground manager: `storage.rs`, fixed above, and `mls.rs:91` (`initialiser_mls`),
which builds a candidate from bytes **JS hands it** and then installs it with `*lock = Some(manager)` -
no epoch guard, no key-material guard, and the bytes were read by the caller at some earlier moment.
That is the same shape, and it is NOT the same defect - settled structurally rather than left owed.
`TauriMlsService.invokeInit` is the single call site, reached only from `_initImpl`, which `init()`
guards with `if (this.initPromise) return this.initPromise` (`BaseMlsService.ts:402`). So the command
runs at most once per service instance, with the manager still `None`; the one repeat path - the
pre-v0.11.0 migration retry - only happens after a load that FAILED, so nothing was installed to
clobber. `recoverAndRekey` short-circuits the same promise before the login that follows. The
assignment at `mls.rs:91` is therefore an initialisation and its lack of a guard is correct. Recorded
because the enumeration is the point: the seam has exactly two consumers and both have now been read,
rather than the one that happened to break.

#### VERIFIED ON THE SAME HANDSET, SAME GESTURE, 2026-09-08 18:16 - `a1Build 232ae6101 + the fix`

A negative needs the window held open on purpose, so the pool was emptied outright to make the mint
long (50 packages, 6.2 s) and the resume was aimed into the middle of it:

```
18:16:03.040  thread 16616  generer_key_packages_et_persister start count=50     MINT BEGINS
18:16:07.075                (resume gesture - 2.2 s INSIDE the mint)
18:16:09.265  thread 16616  generer ... done count=50 state_bytes=10572990       MINT PERSISTS
18:16:15.788  thread 16617  load_or_create ... KeyPackage 3002x                  reload READ - after it
18:16:15.819  thread 16617  [RESUME] foreground manager reloaded from mls.bin
18:16:15.953                generateKeyPackage native batch path needed=0
```

**The reload waited.** Its file read is 6.5 s after the mint persisted, where the same gesture on the
old build read 0.6 s BEFORE the write and installed 0.03 s after it. `KeyPackage 2951x -> 3002x` is all
fifty plus the last-resort; the server's pool for the device reads 50; and `DROPS KEY MATERIAL` and
`REFUSED to purge` are both absent from the whole run.

**ONE EARLIER ATTEMPT IS RECORDED HERE BECAUSE IT PROVED NOTHING AND LOOKED LIKE IT DID.** At 18:14 the
same provocation with ten packages came back clean - and it was worthless: the mint started at
18:14:42.255, AFTER both reloads had finished at 18:14:42.041, so the window was never entered. A run
that cannot fail is not evidence that something was fixed. That is what the fifty-package mint is for.

**AND THE SIX UNBACKED PACKAGES SURVIVED A PROCESS RESTART, WHICH RELOCATES THE LOSS.** 17:51:29 is a
cold start - the APK was reinstalled at 17:50 and the process is new - and `reconcile` still found six
of the fifty without private keys. Nothing in that process had minted or reloaded anything yet. So the
six are **durable debris written by an earlier session**, not something a live reload produces, and
looking for the loss inside one resume was looking in the wrong place.

**THE SAME 6/50 SHAPE WAS `purged` HERE AND `REFUSED` AT 17:09, AND NOTHING IN THIS ENTRY EXPLAINS
THE DIFFERENCE.** That is the question this measurement leaves, and it is a bigger one than it looks:

| | 17:08-17:10, build `fff05fe14` | 17:51-17:53, build `e2d09c211` |
| --- | --- | --- |
| `needed=` | 0, 0 | 0, then **6**, then 0 |
| reconciliation | `REFUSED to purge 6/50 ... this session published itself` twice | **`purged 6/50 orphaned`** once, then nothing |
| after it | the six stay unbacked, for ever | pool refilled, **two clean cycles** |

`REFUSED` is not a safe default here. It is the branch that keeps a device permanently unhealable: six
registered packages nobody can answer for, a guard declining to remove them because it believes this
session published them, and no other path that ever will. `purged` is the branch that heals. **A guard
whose refusal is unbounded in time is not a guard, it is a leak** - and `publishedThisSession` is
populated by the publish call, which re-publishes the whole pool rather than only what was just
minted (`KeyPackage published.` fires at 17:51:49 with `count=0`), so on the face of it every package
should be refused every time. It was not, here. Until that is settled, neither outcome is understood,
and the next step is to read what fills that set rather than to guess from two logs.

**WHAT IS LEFT IS NOT CHURN.** `KeyPackage 2919x` against a pool of **50** - roughly 2 870 storage rows
of key material with no live bundle behind them, 6.9 MB of a 10.36 MB store, 67%. The growth across
these three loads is ~19 kB, against ~389 kB in one run when the loop was live. So the blob's weight is
**debt already written, not traffic**: `prune_expired_key_packages` does run, once per
`load_or_create` ([state.rs:428](../../frontend/mls-core/src/state.rs)), but it deletes on `not_after`
alone, so it bounds the leak at 84 days and repays none of the balance. **That is what keeps
NOTIF-1b's warm-up at 19 992 ms, and no prekey fix will move it.** Reclaiming the store is a separate
piece of work from stopping the churn, and only the second one is done.

#### WHAT IS LEFT IS THE BALANCE: 3053 BUNDLES THAT CANNOT SAFELY BE DROPPED, DRAINING BY THEIR OWN 84-DAY LIFETIME

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

**WHAT IS STILL OWED, AND IT IS THE REASON NOTIF-1b IS STILL BLOCKED.** The 3053 bundles already
written are NOT reclaimed and cannot safely be: the server has no record of them at all, so nothing
can prove they were never handed out, and a rule that guessed would delete the bundle a pending
Welcome needs. `0 expired` on the day of measurement means the whole balance still has time to run -
84 days from minting, so it would drain on its own from **late October 2026**.

**THE PRUNE IS THE PATH, DECIDED BY THE USER 2026-09-10, AND IT UNBLOCKS NOTIF-1b.** Of the two ways
to shorten the wait - a server-side claim record, which would only ever help bundles minted after it
exists, or a deliberate horizon prune on the test fixture - the second was taken. It was the user's
to take rather than an agent's, because the device holds real groups.

**AND THE DECISION HAS NO MECHANISM, WHICH IS WHAT 2026-09-11 FOUND WHEN IT WENT TO RUN IT.** The
choice above was recorded as though the doing were clerical. It is not. The only thing that deletes
these bundles is `MlsManager::prune_key_packages_expired_at(now_secs)`, and a "horizon prune" means
calling it with an instant ~100 days ahead - which the tests do and **nothing in the product can**.
There is no debug surface to hang it on either: `VITE_ENABLE_DEV_ROUTES` survives only in generated
ambient types, no route reads it, and `commands/mls.rs` carries no `cfg(debug_assertions)` command.
So there are exactly two ways forward, and neither is a click:

| Way | What it costs | What it leaves behind |
| --- | --- | --- |
| A dev-gated Tauri command that prunes at a caller-supplied instant | a DESTRUCTIVE control shipped into the product for one phone, against *one-off actions go to the user* and against *a destructive control needs an allowlist of what it may touch* | a permanent hazard, gated by a flag nothing currently reads |
| Ship retention rule 3 - keep published + last-resort + the K most recently minted | the safety ARGUMENT the table below demands, re-measured | the population fixed, the test phone pruning itself on next load, and no manual step at all |

**THE SECOND IS THE ONE WORTH BUILDING, AND IT IS BLOCKED ON A NUMBER NOBODY HOLDS.** Its safety is
"K mints cannot happen inside a Welcome's delivery window", and the delivery window is the interval
between a peer CLAIMING a prekey and the joiner processing the Welcome built on it. Nothing records
it: `resolveKeyPackagePayloadForDevice` DELETES the row as it hands it out, so the claim leaves no
trace to measure from. **That measurement is the next step for this entry** - and it is a server-side
change (record the claim instant, or the Welcome's own age at delivery), not a device one.

**WHAT THE PRUNE RISKS, WRITTEN BEFORE IT IS RUN AND NOT AFTER.** The paragraph above is the risk:
nothing can prove a deleted bundle was not the one a pending Welcome needs. The user chose the
direct prune over the inventory-first variant that was offered. That does not remove the risk, so
the run ENUMERATES the device's groups and any pending Welcome into its log first - not as a gate,
as evidence, so that a failure afterwards can be attributed rather than guessed at.

#### THE POPULATION WAS MEASURED ON 2026-09-07, AND IT REFUTES HALF OF THE HEADLINE ABOVE

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

#### THE WELCOME DELIVERY WINDOW, MEASURED ON PRODUCTION 2026-09-12 - AND IT REFUTES RULE THREE

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
[mls-protocol](protocols/mls-protocol.md#the-two-kinds-of-key-package) names as the reason the
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

**The 2026-09-06 prune (`prune_expired_key_packages`) does NOT fix this** and was never going to:
these bundles are hours old, not 84 days. The prune bounds the ceiling; this loop is what fills it.

### P1 - `mls.bin` is 19.5 MB on a real phone, one checkpoint costs 17 SECONDS, and the PIN gate tells the user the unlock failed while it is still working (measured on the Mi 9T, 2026-09-06)

Three lines from one launch of `0.16.4` on the Mi 9T, all from the same minute:

```
D mls_core::state: save_state: returning cached CBOR snapshot (19427791 bytes)
I [MLS] Encrypted state checkpoint persisted. (17115 ms)
I [MLS] Encrypted state checkpoint persisted. (19691 ms)
```

`stat mls.bin` on the device: **19 548 753 bytes**. Three checkpoints in that launch, 17.1 s, 17.1 s
and 19.7 s. Nothing here is contended or unlucky - it is the cost of sealing 19.5 MB on this SoC,
and it is paid again on every structural checkpoint.

**WHAT IT COSTS THE USER, AND WHY IT IS A P1 RATHER THAN A PERFORMANCE NOTE.** `handlePinSubmit`
arms a 10-second watchdog whose comment calls it a "temporal safety net" for "an unexpected early
return or a hung network call". On this device the login legitimately takes ~19 s (`[pin] settled in
18715ms`, measured twice), so the watchdog fires EVERY TIME, sets `pinError = m.auth_pin_timeout()`
- *"Le deverrouillage prend plus de temps que prevu. Veuillez reessayer."* - and unblocks the
spinner, while the login underneath goes on to succeed. The user is told, in red, that the unlock
failed; retrying starts a second one. Seen on screen twice today (`scratchpad/shot.png`), and it is
the reason `pin.mjs` reports `REFUSED by the product` and the harness cannot unlock this phone.

**Two questions, and they had different answers.**

1. ~~**The watchdog is a clock standing in for a proof.**~~ **ANSWERED AND FIXED, 2026-09-06.** The
   enumeration came out the first way: `login()` always settles, and the only way a caller can be
   stranded is for it to settle without having called back - which is observable rather than
   guessable. The clock is gone and that fact is read instead; a slow login is no longer a failed
   one. Story in `CHANGELOG.md`, guards in `sessionExpiredRelease.test.ts`, validated in negative
   against two mutations. **The twelve seconds themselves are untouched, which is question 2.**
2. ~~**19.5 MB is the real question and it is not answered.**~~ **MEASURED AND BOUNDED, 2026-09-06.**
   The hypothesis was right and the arithmetic was not: `mls-core/tests/state_weight.rs` weighs the
   parts, and `tests/prune_expired_key_packages.rs` pins the rule that now bounds them.

   | what | bytes each | note |
   | --- | --- | --- |
   | one-time prekey bundle | **1 936** | the docblock said ~400 - **wrong by five times** |
   | a group of one | 5 330 | floor, no members, no history |
   | one member added | ~2 000 | read off the slope over four rounds |
   | **50 sends** | **~0** | flat after the first batch |

   **SENDS ARE FLAT, SO MESSAGE HISTORY IS NOT THE CAUSE** - the obvious suspect, and it is
   eliminated rather than doubted. In a state carrying 41 groups AND 200 prekeys, the prekeys are
   **60.1%** of it. Against the phone's 19 548 753 bytes, ~40 groups account for well under 2 MB
   even at twenty members apiece, leaving roughly **ten thousand accumulated bundles**.

   **THE ACCRUAL ENGINE IS NOT THE FRESH START.** `freshStart` is `!state`, so it fires on a new
   install and not per launch, and 200 reinstalls is not a real history. Two other callers are, and
   both are unconditional: `generateKeyPackageImpl` publishes a BRAND-NEW last-resort package on
   **every connection**, and `republishKeyMaterial` purges the server pool and mints up to 50 more
   **once per 30 s** for as long as a `NoMatchingKeyPackage` storm lasts - each round orphaning the
   previous 50 locally, ~97 kB a time. ~200 such rounds is exactly what this phone's healing
   campaign produced, and 200 x 97 kB is the blob.

   **THE ASYMMETRY IS THE DEFECT, STATED PLAINLY.** Reconciliation existed in one direction only -
   `reconcilePublishedKeyPackages` purges the SERVER of a prekey whose private key is gone locally.
   Nothing ever asked the opposite question, so a bundle the server had stopped publishing was kept
   for the life of the install.

   **WHY EXPIRY AND NOT "THE SERVER NO LONGER PUBLISHES IT".** The delivery service DELETES a
   one-time prekey as it hands it out, so absence from the server is exactly what a bundle looks
   like when a peer is about to send the Welcome built on it - pruning on that signal would race a
   join and lose it. An elapsed `not_after` carries no such ambiguity: openmls defaults it to 84
   days, a Welcome referencing an expired KeyPackage is invalid under RFC 9420, and so the delete
   is confined to what could not have been used anyway. It needs no server round-trip and cannot
   race anything, which is what makes it safe unattended.

   **WHERE IT RUNS.** `MlsManager::prune_expired_key_packages`, called once from `load_or_create` -
   and `load_with_key` delegates there, so the web client, the native client and the background FCM
   path all shed through one seam with no second code path and no timer. The last-resort fallback is
   kept exactly like any other package until its own lifetime elapses, which is the KEEP the old
   text asked for. A prune failure is logged and does not fail the load: a device that cannot shed
   still works, one that refuses to load has lost everything.

   **WHAT THIS DOES AND DOES NOT CLOSE.** It bounds the leak permanently at (mint rate x 84 days),
   which is the durable fix. It does **not** promise to shrink *this* phone's blob today - only
   bundles past 84 days go, so the reclaim depends on the install's age. **Two accrual paths are
   therefore still open**, and they are the minting itself rather than its cleanup.

   1. **The per-connection last-resort mint.** `generateKeyPackageImpl` publishes a fresh fallback
      every time, and a `last_resort` package is reusable by construction - that is the whole point
      of the 2026-09-06 fix. It should be re-minted only when the device can no longer back it, and
      `keyPackageHasPrivate` already answers exactly that question about a fetched package. At
      1 936 bytes a connection this is the STEADY-STATE floor of the leak, the part that survives
      every storm being fixed: twenty connections a day over the 84-day prune horizon is ~1 680
      bundles, over 3 MB, on a device doing nothing wrong.
   2. **`republishKeyMaterial`'s 50 orphans - and the obvious fix for it is WRONG.** Dropping the
      local bundles when the server pool is purged would race a join and lose it: a peer may have
      claimed a prekey seconds before the purge with the Welcome still in flight, and the private
      key it needs is precisely what would be deleted. **The discriminator exists, but only on the
      server.** A claim and the row's deletion are one atomic operation, so anything still present
      when `DELETE .../prekeys` runs is provably UNCLAIMED - and therefore provably safe to delete
      locally. The endpoint currently returns nothing. Have it return the ids it actually deleted,
      and the client can drop exactly those with no race and no clock. That is the repository's own
      rule about never learning by failing what a fact could have told you: carry the discriminator
      to where the decision is made, from where it is already known. It needs a server change, a
      client change, and a delete-by-`hash_ref` in `mls-core`.

**This is invisible to every gate in this repository.** The desktop clients carry a small state and
the emulator never accumulates one; only a phone that has lived through a campaign shows it. It
belongs with the other three iOS/Android defects that no green build could have caught.

**WHAT REMAINS AFTER THE UI HALF AND THE MEASUREMENT**: the unlock still takes ~22 s on this
handset and a structural checkpoint still costs 17 s of CPU, because the prune bounds future growth
rather than reclaiming an existing blob whose bundles have not yet reached 84 days. The two accrual
paths named in question 2 are what would actually shrink it, and neither is written. **A field
re-measurement of `stat mls.bin` on this handset is owed once a build carrying the prune has run on
it** - that number, not a test, is what closes this entry.

### P2 - the MLS snapshot version is a PER-DOCUMENT counter compared ACROSS documents, so a second tab's write is dropped on a collision (measured on TAB-4, 2026-09-05)

`saveMlsStateEncrypted` refuses any tagged write whose version is not strictly newer than the stored
one. The version comes from `tagMlsSnapshot`, which is `++_snapshotSeq` - a module-level counter,
and therefore **one counter per DOCUMENT**, seeded from the persisted version by
`seedMlsSnapshotSeq` when the tab loads.

Within one tab this is exactly right and is what the guard was written for: a slow off-thread Argon2
flush finishing after a fresher one must not clobber it, and there `version < stored` is a true
statement about ordering.

**Across two tabs it is comparing two unrelated sequences.** Both tabs load, both seed from stored
version *N*, and both then produce *N+1* for their next snapshot - different bytes, same number. The
guard sees `version <= stored` and drops the second one. Measured on TAB-4, which drives two tabs of
one client: `Skipping stale MLS state write (v3294 <= stored v3294)` on an ordinary run.

**What is not yet answered is whether anything is LOST.** The dropped snapshot may hold state the
winner does not - the second tab may have processed a frame the first had not - and the counter
cannot say, because it is not a clock over the pair. In practice a later flush from either tab
carries a higher number and lands, so the state is expected to converge; that expectation is
untested and the window is unmeasured. **A clock written by one writer is not evidence about
another's ordering** - the same rule as a liveness column written by something other than the thing
whose liveness it measures.

The wording is already fixed (2026-09-05): the collision case says so instead of claiming staleness,
and `hex.mlsVersion.test.ts` pins both branches. That makes the event visible; it does not decide
it. Deciding it means either making the version a shared counter (a `BroadcastChannel` claim, or an
IndexedDB read-modify-write inside the same transaction as the put - the transaction is already
there) or establishing that convergence always happens and how long it takes.


The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any measurement belongs.

## Payments

### P2 - the payout estimate is Stripe's fee schedule, now rendered under provider-neutral wording

Opened 2026-08-30 by the pass that removed Stripe's name from everything it did not own
([payments](frontend/modules/payments.md#where-a-providers-name-may-appear-and-where-it-may-not)).

`frontend/src/lib/payments/stripeFees.ts` hard-codes Stripe's French pricing (a percentage plus a
fixed cent amount) and `StripeNetPayoutHint.svelte` renders the result. Both keep the vendor's name,
deliberately - the arithmetic really is Stripe's, and a neutral name there would be the lie. **What
changed is the copy above them**: `payout_hint_fees_note` no longer says Stripe, so the number now
presents itself as "what you will receive" whoever is processing.

While `payment_provider` is `stripe` the estimate is correct and nothing is wrong today. The day
WP-LYDIA-1 flips it, the hint keeps quoting Stripe's schedule for a Lydia payment, and a treasurer
has no way to tell. **This is not fixed by renaming anything** - the fee schedule is a per-provider
FACT, so it belongs behind the same seam the rest of the provider already sits behind: either
`PaymentProvider` exposes its schedule, or the hint asks `GET /api/payments/provider` (already live,
already consumed by the association edit page) and picks. The second is cheaper and needs no server
change; the first is right if a third provider ever appears.

**Its blocking condition is the same as WP-LYDIA-1's**, and deliberately so: Lydia's real fee
schedule is part of the credentials Lydia still owes, and inventing a placeholder here would ship a
second wrong number rather than none. Do it in the same work package.

### Flipping `payment_provider` from Stripe to Lydia (WP-LYDIA-1)

**The code is not the blocker - it is already written and tested.** `PaymentProvider` is an interface
(`apps/core-service/src/payment/payment-provider.interface.ts`), `LydiaPaymentProvider` implements the
two flows that map cleanly onto it (one-off checkout, session lookup) with its own signature module
and specs, and the choice is a platform config column (`payment_provider`) that **defaults to
`stripe`**. Stripe is what runs today and nothing about that is broken.

What is missing is not code, which is why this is a question and not a P-anything: the **credentials**
and the **answers Lydia owes**. Everything that does not map - live balance and status, saved payment
methods - throws a documented error rather than faking a result, and that is deliberate: Lydia has no
live status-poll endpoint, and the saved-card flow was **explicitly dropped by the user** rather than
reimplemented, so every purchase becomes its own interactive request. Do not re-litigate that.

The full provider mapping, the remaining open questions and the credentials still owed are in
[`plans/stripe-to-lydia-migration.md`](../../plans/stripe-to-lydia-migration.md), which the wiki page
[payments](frontend/modules/payments.md) already points at.

**2026-08-19: onboarding storage coexists (see [core-service#payments](services/core-service.md#payments-stripe--lydia)),
and checkout routing now does too.** `resolvePaymentTarget` (`payment-delegation.util.ts`) takes the
active provider as a parameter and resolves against the matching column pair; `AssociationsService`/
`ProductsService` fetch it from the public `GET /api/payments/provider` before resolving, and let a
failure to reach core-service propagate rather than guess. `PaymentTarget.connectAccountId` (renamed
from `stripeAccountId`) now genuinely holds whichever provider's account is active. A Lydia
`request/do` payment is also confirmed server-side now: `confirm_url`/`cancel_url`/`expire_url` are
registered per-request, and `POST /api/payments/lydia-request-callback`
(`webhook.controller.ts`) verifies the signature and fans out to the same submission/purchase
fulfillment Stripe's webhook already used, via a shared `order_ref` encoding
(`form:<submissionId>` / `product:<productId>:<userId>`, parsed by `lydia-order-ref.ts`).

**Two things still block actually flipping the switch, both found while wiring this:**
1. **`payerRecipient` is never supplied.** `LydiaPaymentProvider.createCheckoutSession` throws
   without it (`request/do` needs the payer's email/phone), and nothing in `products.service.ts`/
   `forms.service.ts` resolves one - the interface field has existed since Phase 2 but no caller was
   ever wired to it. Needs a design decision on where the payer's email comes from for a boutique
   purchase (a logged-in user's account has no email stored in social-service today; only forms with
   a guest `input.email` field have one at all).
2. **The `business/create` `BUSINESS_VALIDATED`/`BUSINESS_UNVALIDATED` webhook is deliberately not
   built.** It has no documented signature and `vendor_token` is PUBLIC - building it as-is would let
   anyone knowing another association's vendor_token forge or break its `lydiaOnboardingComplete`,
   with no resync since Lydia sends the event once. Add "does `business/create`'s `webhook` param
   have a signature scheme?" to Livrable A below before building this.

---

### P3 - an admin who never joined a private salon is not told when it is deleted

`channelAudience` is the salon's roster, and since 2026-08-19 an administrator reaches a private
salon by JOINING it rather than through `workspace.manage` - so one who has not joined is not on the
roster and receives no `channel.deleted`, nor any other event the salon emits. They ARE shown that
the salon exists (name only, `viewerHasAccess: false`), so their sidebar keeps a row for something
that is gone until their next load.

**Not fixed by widening the audience**, which is the obvious move and the wrong one: that is exactly
what put every private salon's messages, typing, pins and poll tallies on the socket of members the
same server refuses to serve them over REST, and it was closed this week. The shape that would work
is a separate, contentless `channel.gone` addressed to the community - worth doing only if the stale
row is ever seen to matter, since a reload clears it and nothing is wrong underneath.

### P2 - WP-RESTORE-1: Zero-Tap Sign-In restoration, required by Google Play from April 2027

**Play's requirement, verbatim in substance:** an app that supports user sign-in, optional or
mandatory, must support Zero-Tap Sign-In restoration when the user moves to a new Android device.
Mobile and tablet only. Games are exempt; Canari is not. Enforcement begins **April 2027**. Three
exemptions exist and none obviously fits us: a Block Store integration completed by **30 September
2026**, enterprise or permanently-private apps, and a regulatory exemption requested for
financial/healthcare mandates.

**The mechanism is the Restore Credentials API**, and a restore credential is a system-managed
WebAuthn public key credential - a passkey the user never sees, tied to the package name, created
silently after sign-in, backed up with the device and readable on the new one during setup. It is
`androidx.credentials`, minimum Android 9 (our minSdk is exactly 28, so every install qualifies),
GMS core 24220000 or higher. **It works regardless of `android:allowBackup`**, which matters here:
the credential lives in the system credential store, not in app data, so it is orthogonal to the
device-transfer exclusion shipped on 2026-08-26 and does not reopen it.

**What this costs is a server we do not have.** `grep` over `apps/core-service/src` for `webauthn`,
`passkey`, `publicKeyCredential` and `fido` returns NOTHING: there is no WebAuthn registration or
assertion endpoint anywhere, and a restore key needs both - a `PublicKeyCredentialCreationOptions`
to create, an assertion to verify, and a store that keeps restore keys distinguishable from real
passkeys. Canari's session model is an opaque refresh row plus a stateless 1 h access token
([sessions](sessions.md)); a successful assertion has to mint exactly that pair.

**THE PRINCIPLE IS DECIDED - THE USER ACCEPTED IT ON 2026-08-26, AND THE WORK IS SCHEDULED AFTER
THE CAMPAIGN.** The question put to them was not technical: zero-tap means the new device is signed
in with no password and no second factor, and Google's documentation states plainly that the API
"does not handle multi-factor authentication", while Canari has 2FA and SETUP-4 exists because
re-enrolling a device costs one. It was accepted on the ground below - a restored session
authenticates, it does not decrypt - and because the exemptions on offer (enterprise, permanently
private, financial or healthcare regulation) do not describe a student messaging app, so refusing
would have risked a publication block rather than bought time. **Do not re-open the principle; what
is open is the build, and it does not start before the ladder reaches the bottom.**

**What it does NOT restore, and why that is fine.** Keystore material is non-exportable, so the MLS
device key does not travel. A zero-tap sign-in authenticates; it does not decrypt. The new device
still enrols as a new MLS client and is re-invited, exactly as
[frontend/backup](frontend/backup.md) already describes for a restore onto a different device. The
feature is therefore coherent with E2EE - it removes a password prompt, not a re-enrolment.

**Three traps to carry into the work when it is scheduled:**

- **The logout half is a requirement, not a nicety** - Play requires the restore key be deleted when
  the user signs out. Canari's logout lives in TypeScript, so this needs a Tauri command down to
  `ClearCredentialStateRequest(TYPE_CLEAR_RESTORE_CREDENTIAL)`, and it must run on the paths that
  log out WITHOUT a user gesture too - a 401/403, a revoked session.
- **The library is `1.7.0-alpha03` at the time of writing.** An alpha is not shippable on the
  release track here; check for a stable line before starting, not after.
- **`E2eeUnavailableException` is expected, not exceptional** - it fires when the user has no screen
  lock or no Google backup, and the documented handling is to retry with `isCloudBackupEnabled =
  false`. That is a second path, so it is logged at a level that accuses and its rate is measured
  before anyone believes what it says.


## Tooling

### P3 - the one-shot history audit can never discharge a group that needed nothing, so it re-lists the same groups on every connection (observed 2026-09-05)

Read out of PIN-9's report, which is clean and carries the two lines as `notable`:

```
[HISTORY_RECONCILE] no sweep - away 0 d, inside what the server keeps; auditing 7 group(s) that never have been
[HISTORY_RECONCILE] reconciliation pass complete - 0/7 group(s) asked in 0 ms
```

`groupsOwingAudit` returns every local group not in the device's audit record, and
`noteGroupsAudited` is called with *"the groups a probe actually LEFT for"* - `reconcileGroup`'s
`true`. That is deliberate and its docstring says why: a group whose members were all offline was
DEFERRED, not audited, and marking it would discharge an audit that never happened.

**But `reconcileGroup` returns `false` for at least six different outcomes, and only some of them
are deferrals.** `isDistributionGroup` (a group that can never be audited at all),
`recentlyAsked` (the coalescing window - it was audited, moments ago), and *"every reachable member
has stated its coverage - nothing more to ask"* are all COMPLETED work; *"no probe sender yet"* and
*"could not reach the service"* are genuine deferrals. The boolean cannot tell them apart, so a
group in the first set is never marked and is listed again on every connection for the life of the
device. This is the file's own rule about durable state turned on itself: **a column is only
evidence for the question it was written to answer**, and `askedGroups` was written to answer *"did
a probe leave"*, not *"was this group audited"*.

`0 ms` for seven groups says these seven exited at one of the two guards before the first `await`,
so the likeliest population is distribution groups - which would make the line permanent and
un-dischargeable rather than merely repetitive. **That is the measurement this item owes**, and it
is one log line away: name the reason per group, then decide between excluding
`isDistributionGroup` from `groupsOwingAudit` and returning an outcome instead of a boolean.

**Why it is P3 and not P2:** nothing is left unrepaired - the groups that owe a real audit still get
one, which is the direction that matters. What it costs is a pass and two log lines on every
connection for ever, and **a line its reader learns to skip is the one that hides the next defect**.

### P3 - "unlock the PIN through the CLI" is written three times in the rig, and all three had to be fixed separately (measured 2026-09-05)

`phone.mjs:unlockPin`, `archive/notif7.mjs:unlock` and `archive/tab236.mjs:unlock` are the same
wrapper around `pin.mjs`, differing only in which device they name and which origin they match. They
were written independently, and on 2026-09-05 all three carried the same two defects: the script was
spawned by BARE NAME (so two of the three resolved it to `archive/`, where it does not live, and did
nothing at all while reporting a string), and the failure was reported from STDOUT, the one stream
that cannot say why. Both were repaired in each copy, one at a time - which is the shape the rule
about re-implemented CLI predicates already names.

`atoms.mjs` is the home that exists for this and says so in its own docstring: *"ONE SPELLING OF THE
ARGUMENTS, IN ONE PLACE."* The three copies simply predate it. The change is `unlockPin({ port,
account, match })` there, returning `{ ok, line, why }`, with the three sites delegating - and it is
P3 rather than P2 because the defect is gone and only the duplication is left.

**It is not free**: `atoms.mjs` and `phone.mjs` are in the instrument set of nearly every runner, so
the change ages a large part of the ledger. It belongs between rungs, or after the campaign.

### P3 - the root `load` warns on every navigation that it used `window.fetch`, and the fix it asks for buys nothing here (measured 2026-09-03)

The dev server prints, once per navigation:

```
Loading http://localhost:1420/api/auth/refresh?clientVersion=0.14.15 using `window.fetch`.
For best results, use the `fetch` that is passed to your `load` function
```

It comes from `frontend/src/routes/+layout.ts`, whose silent-refresh path calls `refresh()` in
`$lib/stores/auth.ts:424`. **The warning's two reasons do not apply to this app.** SvelteKit asks for
the injected `fetch` so that a SERVER render forwards cookies and so that the response is inlined
into the HTML and not re-fetched at hydration - and this root layout declares `export const ssr =
false` (Tauri needs SPA mode), guards itself with `if (typeof window === 'undefined') return`, and
therefore never runs on a server. There is no render to forward for and no hydration fetch to
deduplicate.

What it WOULD cost to silence: `event.fetch` threaded from the load into `refresh()`, from there
into `apiFetch`, and into `fetchUserProfile` - a `fetch` parameter through the auth and user stores,
for a warning about a case the app has ruled out. **That is why it is P3 and not simply "fix it":
the honest disposition is either that thread or a decision to accept the line, and accepting a line
is only allowed once somebody has written down why**, which is what this entry does.

Retired by: `ssr = false` disappearing from the root layout (then the fix becomes required, not
optional), or by SvelteKit offering a per-call opt-out.

### P3 - the local WebSocket closes 1006 on navigation, and nothing says whether that is the unload or a defect (observed 2026-09-03)

`[WS] Disconnected. Code: 1006, Reason: no reason`, twice, between two full page navigations on the
local estate. 1006 is an ABNORMAL closure - the code a browser synthesises when no close frame
arrived - which is also exactly what a page unload produces, so **the line cannot distinguish the
benign case from a gateway dropping the socket.** That is the defect worth fixing whether or not the
underlying close is: a log line whose reader must guess is one they learn to skip. Measure it by
closing the socket deliberately on `beforeunload` and seeing whether 1006 stops; if it does, the
remaining 1006s are real and mean something.

### P2 - a cargo bump in `mls-core` leaves two committed lockfiles Dependabot will never fix

`frontend/mls-core` is a library: its `Cargo.lock` is gitignored. `frontend/mls-wasm` and
`frontend/src-tauri` are binaries with COMMITTED lockfiles, and both depend on `mls-core` by path -
so every crate `mls-core` names appears in their locks too.

**Dependabot opens one pull request, against `mls-core/Cargo.toml`, and that pull request is
incomplete by construction.** There is no manifest to change in the other two directories, so their
locks keep the old version and CI's `Refuse a lockfile the manifests no longer describe` step fails
with `cannot update the lock file ... because --locked was passed`. Measured on PR #300 (argon2
0.5.3 -> 0.6.0): four jobs red, two of them for this reason alone and nothing to do with argon2.

This is not a ceiling refusal - the gate is right to fail, the pull request really is unmergeable -
and it is not something `@dependabot recreate` can fix either. **It is the one shape of dependency
update in this repository that CANNOT be merged unattended**, which is what makes it worth a row.

**The remedy, named rather than done:** make `frontend/` a single cargo workspace with ONE
`Cargo.lock` covering `mls-core`, `mls-wasm` and `src-tauri`. One lock means one resolution, so
Dependabot's pull request is complete again and the class of failure disappears. It was not done in
the same pass as the argon2 bump because `src-tauri` is the crate whose build this workstation can
only COMPILE - never run on iOS or macOS - and restructuring a Tauri build is not a change to make
where the only available gate is `cargo check`. Until then, a bump of any crate `mls-core` names is
done by hand in one commit that refreshes all three locks, and the Dependabot pull request is
superseded rather than merged.

### P1 - the three refusals the auto-merge ceiling makes, and the test that retires each

**`dependabot-auto-merge.yml` refuses only what this repository has no gate for**, and every refusal
names its missing test in a comment on the pull request. The standing directive is that a refusal is
never a routing decision to a human queue (user, 2026-08-31), so THIS TABLE IS THE WORK: each row
closed is a whole class of update that starts merging on its own.

Measured three times on 2026-08-31 by running the SHIPPED script against every open pull request:
**5 merge / 28 refuse in the morning; 26 merge / 6 refuse once the first gate was written; and
7 merge / 5 refuse / 19 held by a real CI failure once the second landed.** The third reading is
the one that changed the subject: **the ceiling is no longer what holds the queue** - nineteen
pull requests are red, and they are red because the gates written that day work. #263 bumps
`@nestjs/common` to 12 in ONE service and dies on `Boot the real AppModule`; #298 dies on a
deprecated `from_slice`. Both are the suite being evidence, which is the whole design.

**All three readings PREDATE the `typeorm` row closing**, so the refuse count is now lower than any
of them and no number here should be quoted as current. The measurement that IS current is the
hourly sweep's own log - it prints what it merged, what it refused and what it held, every pass.

| Refused | Why the suite cannot see it | The test that retires it | State |
| --- | --- | --- | --- |
| ~~`@nestjs/*` MAJORS (22 PRs)~~ | ~~no test ever constructed the real application module~~ | `src/app-module.boot-spec.ts` + the `boot-nest-apps` job | **CLOSED 2026-08-31.** Green on all four services against a real Postgres, Redis and S3; the case is deleted from the ceiling |
| ~~bare `typeorm` MAJOR, or an unclassified bump of it~~ | **CLOSED 2026-08-31.** The boot proved the schema BUILDS and nothing more - `forRootAsync` resolves, every entity's metadata is constructed, `synchronize` runs - while every unit suite mocks its repositories, so no test had ever watched this ORM return a row and a major changing how a query is BUILT would have passed all 1105 of them | `app-module.boot-spec.ts` now issues a real `find({ take: 1 })` through EVERY entity the app registered, by metadata rather than by a named list | **GREEN on core, social and chat-delivery in CD run `33403833044`**, and the clause is out of `dependabot-auto-merge.sh`. media-service carries no query test and asserts WHY: it declares no `typeorm`, and that assertion fails the day someone gives it a database |
| ~~`chacha20poly1305`, `argon2`, `ciborium`~~ | ~~nothing opened a keystore written by the PREVIOUS version~~ | `tests/cross_version_state.rs` + the four frozen artefacts under `tests/fixtures/` | **CLOSED 2026-08-31.** An at-rest envelope is read by the device that SEALED it, so the backward direction is the whole question - measured by enumerating every `encrypt_blob` call site, all of them state persistence. Falsified by corrupting each fixture: all four tests go red |
| `openmls*`, `tls_codec*`, `hpke-rs*`, `libcrux*` (4 PRs) | a WIRE format is read by OTHER devices on OTHER versions, so the forward direction exists and no frozen fixture can see it | an old binary run against a frame minted by the new one. The backward half is already covered | open, **and the obvious shape of it does not work**: measured 2026-08-31 by checking out `v0.14.14` into a worktree, which carries NO `tests/fixtures/` and no `cross_version_state.rs` at all - the release tag predates both. So the old side cannot be 'run its own test with our bytes'; it needs a driver written TODAY and compiled against the OLD `mls-core` as a path dependency, using only the public API that existed then. That is the design decision this row is actually waiting on, not the CI plumbing. **And the compiler spoke first on this one**: openmls 0.9.0 adds `OwnPendingCommit` and `OwnPrivateMessage` to `ProcessedMessageContent`, so the four PRs need a code decision, not just a gate. Applied together they compile down to that ONE error; apart, none of them builds at all |
| ~~`aes-gcm` (0 PRs open)~~ | ~~it opens a channel push sealed by ANOTHER member's device (`decrypt_channel_message`), and src-tauri freezes nothing~~ | `src-tauri/src/mobile/cross_version_push.rs` + two frozen artefacts under `src-tauri/tests/fixtures/` | **CLOSED 2026-08-31.** Two fixtures rather than one, so a failure names its cause: a FIXED key accuses the AEAD, a Graine-DERIVED key accuses the HKDF. Falsified by flipping one ciphertext bit - the channel test goes red while the Graine one stays green. **Both directions are covered**, which is what let the arm be deleted rather than narrowed: an AEAD is deterministic, so re-sealing the frozen plaintext under the frozen key and nonce must reproduce the frozen bytes, and equal bytes are equal in both directions. A protocol that may ADD fields is not, which is why `openmls` stays refused. First test in src-tauri, in the crate rather than under `tests/` because `mod mobile` exists only under `cfg(test)` |
| `webrtc` and the ICE crates (1 PR) | the SFU has ten tests and not one touches the ICE stack | one relay-path call - campaign rung 15 CALL, which has no runner | not started, and the SFU is already SIX majors unplaced (see its own P1 above) |
| `stripe` (1 PR) | **half of it the compiler already sees, and that half is safe.** The SDK types `apiVersion` as the literal its release was cut against and this service pins that value in one constant, so a bump that still COMPILES cannot change which API the app talks to and merges like anything else. A bump that crosses an API version stops the tree compiling in four files at once. What no gate can answer is whether the app still READS what the new API sends - payload shapes and object fields are what an API version decides | fixtures per API version for this service's Stripe surface: the events `webhook.controller.ts` handles and the fields `stripe-payment-provider.ts` and `users.service.ts` read, so a crossing is proved rather than read in a changelog | open. **#304 (22.3.2 -> 22.6.0) is the live case**: it wants `2026-08-26.dahlia` where the constant says `2026-06-24.dahlia`, and CI is red on exactly those four files. Crossing it is a decision about PAYMENTS and therefore the USER's - see `apps/core-service/src/payment/stripe-api-version.ts`, which says so in its own docblock |

**ONE FLAKE IS RECORDED HERE BECAUSE AN UNATTENDED MERGE IS EXACTLY WHAT A FLAKE BREAKS.**
chat-delivery-service's suite failed 1 test in the first of five consecutive local runs on
2026-08-31 and passed 308/308 in the other four; the failing run was concurrent with a CD build on
the same machine, and its output was not captured. Not reproduced, not identified. If it recurs,
capture the suite name before anything else - a green-gated auto-merge that retries into a green run
will merge on the second try and tell nobody.

**Do not widen this list to feel safe.** Every entry costs the queue it blocks, and the honest test
of a new one is: name the failure, then name the test that would have caught it. If you cannot name
the test, the entry is a guess.

### P3 - social-service has no root health route, and the other three do

core-service, media-service and chat-delivery-service each expose `GET /api/health` from a
`HealthController` with an empty `@Controller()`. social-service exposes none: its nearest liveness
route is `GET /api/channels/health`, which belongs to `ChannelsController` and answers about the
channel service specifically. Found while writing the boot test, which has to ask a different URL of
that one service.

It is P3 because nothing is broken today - but a probe, a load balancer or a future readiness gate
that assumes the shape the other three share will silently point at nothing here, and an asymmetry
nobody chose is the kind that gets discovered during an incident.

### P3 - `submissions.formId` names a form nothing keeps, and 28 rows point at deleted ones

**Measured on prod 2026-08-31.** There is no foreign key at all:

```sql
SELECT conname FROM pg_constraint WHERE conrelid = 'submissions'::regclass AND contype = 'f';
-- (0 rows)
```

Twelve `formId` values in `submissions` match no row in `forms`. Of the 28 orphaned submissions,
**5 are `paid`** (36,00 EUR in total), 6 `pending` (101,00 EUR never charged), 16 `free` and 1
`cancelled`. Only one form of the thirteen referenced still exists. The amounts date from May and
June 2026 and read as forms from the development period, so this is P3 on the money and P3 on the
count - but not on the shape.

**What it costs today**: five people have a paid line whose title nobody can render, and
`markPaid`'s own `grantCotisationIfConfigured` would have had nothing to read either. Deleting a form
also strands whatever `user_tags` its `grantsCotisation` had issued, which no longer names anything.

**The decision this needs is not "add a foreign key"** - a cascade would DELETE paid submissions,
which is worse than the orphan. The shapes worth weighing are a tombstoned form (soft delete, the
title survives, the join keeps working) or a denormalised `formTitle` on the submission at write
time. The first keeps one truth; the second survives a hard delete. Neither is obviously right,
which is why this is written down rather than done.

### P2 - NOTHING DECLARES THE REDIS VERSION, AND THE TWO PLACES THAT NAME IT DISAGREED

**Found 2026-08-31 while taking `ioredis` 6.** `infrastructure/docker-compose.prod.yml`,
`docker-compose.dev.yml` and `infrastructure/local/docker-compose.yml` all say `image: redis:alpine`
- a floating tag. `ci.yml` said `redis:7-alpine`. The box was measured and runs **8.8.0**, so the
gate that proves a service can talk to Redis was proving it against a different major from the one
it meets in production. **The CI half is fixed** (`redis:8-alpine`, with the reason in the file).

**The production half is NOT, and it is deliberately the user's call.** This Redis is persisted and
`history:{groupId}` is the ONLY shared copy of a conversation's messages - the per-device queue is
deleted on ACK. Changing the image tag makes `docker compose up -d` recreate the container, so it is
a restart of a store holding user data, which is a one-off action and not something to slip into a
dependency commit.

**What makes it worth doing anyway:** a floating tag on a persisted store means ANY deploy can pull
a new Redis major under it, with nobody deciding and nothing recording that it happened. An RDB/AOF
file is forward-compatible and not backward, so the jump is silent and the way back is not. Pinning
to `redis:8-alpine` changes nothing about what is running today - it only removes the ability of a
future `docker compose pull` to change it by itself.

### P3 - 108 navigations bypass `resolve()`, and an inherited disable is the only reason nobody sees them

**FOUND 2026-08-27, while measuring whether `oxvelte.config.json` could be deleted.** It cannot, on
this repository or on MiGallery, and the reason it cannot IS the finding.

The file disables exactly one rule, `svelte/no-navigation-without-resolve`, and it was copied across
from the ESLint config the Oxc migration replaced - which had disabled it for reasons nobody wrote
down. The rule is in oxvelte's recommended set. With the file moved aside:

| Repository | With the config | Without | Of which that rule |
| --- | --- | --- | --- |
| Canari (`frontend/src`) | 0 | 92 | **92 - every one** |
| MiGallery (`src`) | 70 | 86 | 16 |
| le-cercle (`src`) | 0 | 0 | 0 - so its config was deleted |

**What the rule wants** is `resolve()` from `$app/paths` around a route string handed to `goto()` or
to an `href`, which is how SvelteKit 2.26+ resolves a route id against the configured base path. The
92 call sites here are correct today because this app is served at the root and `base` is empty. That
is the whole of their correctness: it is a property of the deployment, not of the code, and the day
anything is served under a prefix - the second environment in this same file, a preview build, an
embed - all 92 break together and silently.

**The work is 92 call sites plus 16 on MiGallery, then deleting both config files.** It is mechanical
and it is large, and it must not be folded into a tooling commit: a diff that touches every
navigation in the app is a diff that wants to be read on its own. Nothing is broken while it waits,
so it waits.

**Do not re-measure it by dropping the `--config` flag.** oxvelte finds the file in the working
directory either way; that comparison is a thing against itself and it read as 0/0 here for exactly
as long as it took to run the real gate. Move the file.


## Localisation

### P2 - 218 places still render the server's English prose to a French user (re-measured 2026-09-11)

**How it was found.** The user hit one of them: *"En passant, 'No codes left for this partnership'
est non traduite."* That sentence is thrown by `partnerships.service.ts` and was rendered verbatim
because the shop had nothing else to show - `request()` in `lib/associations/api.ts` threw
`new Error(serverMessage)`, and the sentence was the only thing that survived the hop.

**The reported path is fixed** and is the pattern for the rest: the service classifies at the
THROW with a code (`PARTNERSHIP_NO_CODES_LEFT` and three siblings, one builder for the seven
identical "not found" throws), `request()` throws `SocialApiError` carrying that code, and the
screen maps codes it knows to Paraglide messages. **Anything unrecognised becomes a generic
localised line rather than the server's text**, so no path is left that can put English on screen
in that component - asserted by `socialApiError.test.ts`, which fails if `.message` reappears in
the file.

**The measurement, and it is the reason this is an entry rather than a sweep.** A census of
`frontend/src` on 2026-09-10 found **185** places rendering `e instanceof Error ? e.message`, of
which **20** are in the shop and associations trees. One is now fixed. The other 184 are the same
defect in the same shape, and every one of them needs its server side to grow a code first - which
is per-endpoint judgement about which refusals a user can act on, not a mechanical rewrite.

**What NOT to do**: translate the sentences. A distinction carried in prose is a distinction
exactly one call site will make, and the sentences are log text for developers. The delivery
service's `DEVICE_REVOKED` / `DEVICE_LIMIT_REACHED` is the precedent and the shape to copy.

**What would close it**: a guard of the same kind as `socialApiError.test.ts` but tree-wide, which
cannot be turned on until the codes exist - so the honest order is endpoint by endpoint, most-used
screens first, with the guard's allowlist shrinking as they land.

#### 218 OCCURRENCES LEFT IN CHAT, GRAINE, SETTINGS, POSTS AND ADMIN - AND THE GUARD NEVER NEEDED THE CODES

**2026-09-11.** The paragraph above is wrong in one load-bearing respect, and finding out cost
nothing: **not showing English needs nothing from the server.** Distinguishing one refusal from
another does - that is a code at the THROW, per endpoint, and it is still owed. But every one of
these sites already declared the right answer and then threw it away:

```
uploadError = e instanceof Error ? e.message : m.asso_cotisations_load_error();
```

`request()` throws with the server's text, so the ternary picks English **every time the call
reaches the server at all**, and the localized half is dead code that runs only for a non-`Error`
throw. Deleting the preference is the whole fix, and it needs no endpoint to change.

**Seventy sites in `components/associations`, `components/shop`, `routes/associations` and
`routes/shop`**, in two passes that differ in what they cost:

| shape | sites | what it took |
| --- | --- | --- |
| fallback already a Paraglide call | 30 | a deletion, scripted - the string is the one the file already declared |
| fallback a raw literal (`'Error'`, `'Erreur'`, `'Upload error'`, `'Download error'`) | 38 | the operation read off the awaited call above it, mapped to `common_load_error` / `common_save_error` / `common_delete_error` / `common_generic_error_label` |
| an English TEMPLATE literal carrying a status code | 1 | `asso_doc_upload_storage_error`, with `{status}` as a parameter |
| a document upload with no key at all | 1 | `asso_doc_upload_error` |

The raw literals were **two violations in one line** - the server's English when the throw was an
`Error`, and an untranslated inline literal when it was not.

**`src/lib/associations/serverProse.test.ts` is the tree-wide guard and its allowlist is EMPTY.** It
walks all four trees, fails any file whose code (comments stripped, so the rule stays documentable
beside itself) still matches `instanceof Error ? x.message`, and asserts per-tree that it found
files at all - a floor on the total would not catch a path typo, because three healthy trees clear
any floor the fourth one's absence leaves. An allowlist entry that stops offending fails too.

**WHAT IS LEFT, AND THE COUNT WAS RE-MEASURED RATHER THAN CARRIED FORWARD.** The 185 above came from
one predicate; a broader one over `frontend/src` finds **288** occurrences of the ternary, of which
~118 assign to an error state a screen renders and 15 sit inside a `Log`/`console` call and are
correctly dev-facing. **218 remain outside the two trees closed here** - chat (`lib/utils/chat`, 13
files), graine (7), settings, posts, admin. Each is the same deletion, and each new tree extends
`TREES` in the guard rather than needing a new file. The CODES are the separate, still-open half.

## Infrastructure

### P3 - no docker prune runs on `canari` or `mitv`, and 141 dangling volumes say so

**FOUND 2026-08-27, by checking whether le-cercle's `ENOSPC` could happen here.** It cannot happen
the same way, and that difference is the point of this entry.

le-cercle fills up because its pipeline tags every build `le-cercle:<sha>` and a tag is never
dangling, so the `docker image prune -f` in its deploy reclaimed 0 B for months
([durable-rules](durable-rules.md#shared-gotchas---development-cicd)). **Our hosts have the opposite shape:** CD pushes
to ghcr and the compose files pull `:latest`, so the image a deploy replaces loses its tag and
becomes dangling - reclaimable by the plainest possible prune. What they have in common is that
**no prune runs at all.**

| Host | Root | Free | Dangling images | Dangling volumes | Exited containers |
| --- | --- | --- | --- | --- | --- |
| `canari` | 125 G | 73 G (61%) | 57 | 64 | 0 |
| `mitv` | 438 G | 378 G (90%) | 6 | 77 | 3 |

`docker system df` puts the reclaimable at 3.02 GB of images plus 964 MB of volumes on `canari`,
and 2.43 GB plus 4.65 GB on `mitv` - where local volumes are **82% reclaimable**, the largest single
figure on either box. Neither host is anywhere near its edge, which is exactly why this is a P3 and
not an incident: it is a slope, measured, with years of headroom.

**Volumes are the half that needs care, not a prune flag.** A dangling volume on `mitv` may be an
orphan of a removed container or may be data whose container is simply not running; `docker volume
prune` cannot tell those apart and neither can a name. **Enumerate before deleting** - the standing
rule about destructive controls needing an allowlist applies here in full, and there is no urgency
buying the shortcut. The images half is safe and could be a scheduled `docker image prune -f` today.

### P3 - the DEV box ran out of disk twice, and the real consumer is still not measured

**2026-08-28.** A Tauri Android build died with `rustc-LLVM ERROR: IO failure on output stream: no
space on device` at **10 MB** free; a second attempt hit the same wall at 4 GB after a host
`cargo test` built its own target directory. **Both were paid in pure build cache and nothing
else** - the two `incremental` directories, `~/.bun/install/cache`, `mls-wasm/target`, and
`src-tauri/target/debug` at **14 GB alone**, which the Android build does not even use (a different
target triple). 17 GB free afterwards.

**What is NOT done is the measurement.** A full scan of the volume fights the build for I/O, so
nothing here names the actual top consumer, and every figure above is of a directory that was
already suspected. Until that scan runs, this is a slope rather than a diagnosis - which is why it
sits at P3 beside the two prod hosts above rather than being called fixed. **Ask the user before
deleting anything that is not a build cache.**

## The agenda, the admin console and four modals - eleven items from the user, 2026-09-12

Handed over in one message (*"en vrac quelques items a faire quand tu peux"*). Each was traced to
its code before being written here, so what follows is the WORK, not the question. Three of them
are defects rather than wording: an event's dates can be moved after validation with no
revalidation, any association admin can publish a school-wide holiday band, and the partner picker
offers every association on the platform.

### P2 - a validated event's dates can be moved and it stays validated

`updateCalendarEvent` (`apps/social-service/src/associations/associations.service.ts:1588`) writes
`title`, `kind`, `description`, `startsAt`, `endsAt`, `linkedFormId` and the co-owners, and never
touches `ev.status`. So an association admin whose event was validated by the BDE can move it to
another day, or to another hour, and it stays on the public agenda with nobody told.

**The work.** A change to `startsAt` or `endsAt` on an event in `validated` status returns it to
`pending`, clears `validatedAt` / `validatedBy`, and notifies the VALIDATE_EVENTS holders the way a
fresh proposal does (`notifyValidatorsOfProposal`). A BDE or global-admin caller - the same
`canValidate` the create path already computes - re-validates in place rather than demoting, since
they are the authority the demotion would route to. The event's owner is told, so the demotion is
not silent.

### P2 - "Pause / vacances" is offered to every proposer and gated nowhere

`kind` is a free field. `AssociationCalendarSection.svelte:651-680` offers the `break` radio to any
member holding `PROPOSE_EVENT`, and `createCalendarEvent` / `updateCalendarEvent` accept
`dto.kind` with no check at all. A `break` renders as a full-day background band across the whole
school's calendar - it is a statement about the school, not about an association, so proposing one
has no meaning and validating one is the wrong question to ask a BDE.

**The work.** `kind: break` becomes a BDE/global-admin-only value, refused server-side for any
other caller on both create and update, and the radio disappears from the propose modal for
everyone else. The BDE's own route to creating one is then the answer to the user's question
*"comment fait-il d'ailleurs ?"*: today there is none - the `/calendar` "Deposer un evenement"
modal does not offer `kind` either (`frontend/src/routes/calendar/+page.svelte:348`, which omits it
on purpose), so a break can only be made from the owning association's page. The fusion below is
what gives it one.

### P2 - "Associations partenaires (optionnel)" is every association on the platform

`CoOwnerPicker.svelte:25-38` calls `listAssociations()` and filters on the search box, the primary
owner and what is already selected. Nothing else conditions it: no partnership, no shared member,
no consent from the association being named. So an event can declare any association on the estate
as its partner, and that association's name and colour then ride on a card it never agreed to.

**The work.** Decide what a co-owner IS before narrowing the list - the honest options are
(a) any association, which is what ships today and should then say so in the label, (b) an
association the author is also a member of, or (c) any association, but the co-ownership starts
`pending` and the named association confirms it. The label is wrong under (a) as much as under the
others, so it moves either way.

### P3 - the co-owner picker's label is a raw French literal

`frontend/src/lib/components/calendar/CoOwnerPicker.svelte:18` defaults `label` to the string
`'Associations partenaires (optionnel)'`, and neither of its two call sites passes one. A
user-visible string outside Paraglide, in a component, rendered to every locale.

### P3 - four event modals, two implementations, and neither can do what the other can

| Modal | Where | Fields it has |
| --- | --- | --- |
| "Proposer un evenement" | `AssociationCalendarSection.svelte` | title, kind, description, start, end, poster image (edit only), linked form, co-owners |
| "Modifier l'evenement" | `AssociationCalendarSection.svelte` | the same eight |
| "Deposer un evenement" | `routes/calendar/+page.svelte` | title, description, start, end, co-owners, target association |
| "Modifier l'evenement" | `routes/calendar/+page.svelte` | title, description, start, end, co-owners |

The agenda's pair cannot set `kind`, attach a poster or link a form - deliberately, per the comment
at `+page.svelte:348`, because those are "only editable from the association's own page". The
association's pair cannot target another association. The two are 728 and 824 lines of parallel
state with the same six fields declared twice.

**The work.** ONE component owning every field, with capability props deciding which are rendered
(`canTargetAnotherAssociation`, `canSetKind`) rather than two components deciding by existing. The
title is a prop too: "Proposer", "Deposer" and "Modifier" are the same form under three names. The
poster's "only when editing" restriction is a consequence of the upload endpoint needing an event
id and stays, but it stays in ONE place.

### P3 - the server's event validation speaks English at a French user

`endsAt must be after startsAt`, thrown twice (`associations.service.ts:1542` and `:1618`) and
rendered verbatim by both modals through `depositError` / `formError`. Part of the 218 places
counted under Localisation above, and fixed the same way: a typed error the client maps to a
Paraglide message.

### P3 - "Administration" is the name of a page that moderates one agenda

`/admin` is reachable by any association admin (`routes/admin/+layout.svelte:60-68`), and that is
deliberate: it is where "Agenda en attente" lives. The server agrees and enforces - the pending
listing accepts an association admin, `canValidate` comes back false for them, and
`validateCalendarEvent` / `rejectCalendarEvent` refuse anyone who is not BDE or global admin
(`associations.controller.ts:670-711`). **So there is no access-control defect here**; there is a
NAME that promises a platform console and delivers one read-only queue.

**The work.** The dashboard card and the page title say what the reader can actually do. The
description already does (`admin_associations_description` = "Moderation de l'agenda de vos
associations.") - it is the heading above it that lies, so the heading follows the description
rather than the description being questioned. While there: the dashboard shows the card on
`mine.some(a => a.isAdmin)` while the layout also admits `isContentModerator()`, so a content
moderator who administers no association can reach `/admin` and is never offered the way in.

### P3 - two permission labels both say "paiements" and neither names its flag

| Flag | Label today | What it actually gates |
| --- | --- | --- |
| `MANAGE_PRODUCTS` | "Gerer les paiements (boutique)" | create/edit/delete boutique products, AND the cotisation configuration (`associations.controller.ts:462`, `:490`), AND the listing that includes inactive products (`:1015`) |
| `MANAGE_STRIPE_CONNECT` | "Gerer les paiements en ligne" | start or resume Stripe Connect onboarding - pointing the association's payouts at a bank account |

Neither is about taking a payment. The first is the catalogue and the cotisations; the second is
the bank account. Reword both to name the thing, and keep the provider out of the label the way the
payout estimate already does.

### P3 - "Cotisations et achats" sits in Settings, not in the profile

`SettingsSubscriptionsSection.svelte` is mounted at `routes/settings/+page.svelte:65`. The user
wants it under the profile. Moving the section is the work; the heading string
(`profile_subs_heading`) already reads as a profile heading.

### P3 - "Tout le mois"

`CalendarDayEventsPanel.svelte:84`. It is not a label - it is the BUTTON that clears the day
selection and returns the panel to the whole month, rendered only when `onClearSelection` is
passed. Deleting the text deletes the only way back, so the work is to replace the affordance, not
to remove it: either an X on the day header, or a second click on the selected day. **Which one is
the user's call.**

## Post-campaign projects - decided, not scheduled

### Separating ICM and ISMIN - two schools on one deployment (user, 2026-09-05)

**A direction, decided and not scheduled.** Verbatim: *"Dans la perspective d'avoir des ismin,
separer associations et listes ICM/ISMIN (notamment la possibilite de faire apparaitre ou non une
association sur la cartographie des associations, et pouvoir n'afficher que les associations ICM sur
le portail ICM). Meme plus largement, tout doit pouvoir etre separe, comme si on avait deux instances
de Canari. Seule la partie admin et la messagerie/communautes doivent etre en commun."*

**THE SHAPE, IN THE USER'S OWN TERMS**: two instances that share exactly two things - administration,
and messaging/communities. Everything else - associations, the association cartography, the lists -
is per-school and must be able to be shown to one school and not the other.

**IT IS TWO PIECES OF WORK WITH DIFFERENT MATURITY, AND CONFLATING THEM IS HOW THE NARROW ONE NEVER
SHIPS.**

- **The narrow half is already actionable and is a feature**: a per-association flag deciding whether
  it appears on the cartography, and a school attribute the portal filters on. It is additive,
  reversible, and does not commit the second half to any shape.
- **The broad half - "as if we had two instances" - is a PARTITIONING DECISION and must be designed
  before anything is built.** The question it has to answer first is not which tables gain a column;
  it is what a shared object means when the two halves disagree. Messaging and communities are
  explicitly COMMON, so a community can hold members of both schools while an association may be
  visible to only one - which means the boundary does not fall between two databases, it falls
  through the middle of the object graph. A migration that assumed otherwise would be very hard to
  reverse.

**WHAT MUST BE SETTLED BEFORE ANY SCHEMA CHANGES**, none of which the code can answer: whether a
person belongs to exactly one school or can hold both; whether an administrator is global or
per-school (the user says admin is COMMON, which suggests global, and that has to be confirmed
because it decides every permission check); and whether a member of one school may see the other's
associations at all, or merely does not by default. **These are the user's decisions, and the first
task here is to obtain them - not to write code against a guess.**

Not scheduled. It belongs after the campaign for the reason everything in this section does: it is
large, it is not a defect, and it changes a schema the campaign is currently measuring.

### The MLS + Graine explanation, written FOR THE USER - audience settled 2026-08-20

**Asked for earlier, deferred on one question: who reads it.** Three audiences were offered and the
user chose the first outright.

**Who it is for: the user.** What is guaranteed, against whom, and - as loudly - what is NOT.
Prose and diagrams. **No file names, no function names, no code**, because those are what a
maintainer needs and this is not for a maintainer. Readable end to end in one sitting, which is a
length constraint and therefore a selection constraint: everything that does not change what the
reader can conclude is cut.

**What it must contain, since the whole point is the boundary.** What the server sees (ciphertext,
sizes, timings, who talks to whom) and what it cannot see. What a community's shared key means: every
member of a community holds the key to every PUBLIC salon in it, by design, and until 2026-08-20 to
every private one too. What a private salon's own group changed, and what it did not - an admin now
JOINS and is visible in the member list; forward secrecy was decided AGAINST, deliberately, and the
document says so rather than omitting it. What leaving, being removed, and being re-invited actually
do to the keys. What a stolen device gets, and what the PIN does and does not protect.

**The two audiences declined, recorded so the choice is not re-litigated.** A maintainer's page (file
names, invariants, where each is held) would be a wiki page more, long, needing to stay synchronised
- the wiki already carries that, split across
[mls-protocol](protocols/mls-protocol.md), [graine](protocols/channel-encryption.md) and
[the state machine](protocols/mls-graine-state-machine.md). A security
assessor's document (explicit threat model, what an excluded member can do) is the most demanding of
the three and nobody has asked for one.

**Written AFTER the campaign**, because the campaign is what turns the design into something
measured, and a document that says "this is guaranteed" before anything has run is a claim about a
file rather than about a system.

### One MLS client in a SharedWorker - decided 2026-08-17

**It would remove the multi-tab class outright**, and that class is not theoretical: W2 was measured
carrying seven `canari-emse.fr` tabs, each a full MLS client with its own gateway socket and its own
in-memory counters, sharing one IndexedDB key. Two campaign findings dissolved on that fact alone
(see [testing-methodology](testing-methodology.md), rule 5), and the harness's answer - `client()`
refusing an ambiguous browser, `onetab.mjs` repairing it - protects the INSTRUMENT and not the user.

**Why it is not a queue item.** The cost is not the worker: it is the worker TRANSPORT, the startup
sequence, the PIN unlock and the Safari/mobile fallback, all of which have to be redone. Doing it
before the campaign would invalidate every verdict already taken, since the boot path is what half of
them measure.

### `dev.canari-emse.fr` becomes a real second environment - decided 2026-08-17

Today it is a proxied CNAME onto the same tunnel as production - one environment wearing two names.
The user wants trials to stop happening on prod, which is the right instinct: every reproduction is
authorised on prod only because there is nowhere else, and each one leaves debris on a shared server
that real members use.

**SCOPED WITH THE USER 2026-09-01 - the decisions below are TAKEN and are not to be re-litigated by a
later session.** Where a decision went against the recommendation, the reason is recorded with it, so
that reason is what a future session must argue with rather than the choice.

> **This item holds the DECISIONS. How the environment is actually put together - the isolation, the
> two host ports, the copy and its three strips, the declared version gap, the two variables that
> identify a dev deployment - is on
> [dev-environment](infrastructure/dev-environment.md), the only copy.** **ALL EIGHT STEPS HAVE
> SHIPPED** (2026-09-01), the CD wiring included. **ALL FOURTEEN required secrets exist, the
> `canari-dev` OIDC client is created on Authentik (`pk=10`), and `DEV_ENVIRONMENT_ENABLED` is
> `true`** - all done 2026-09-02, the Authentik write only after the user said
> *"Je valide tes requetes manuellement, vas-y"*, an unattended agent having been refused it first
> and correctly. **ONE THING IS LEFT AND IT IS THE LAST STEP BY DESIGN: the tunnel INGRESS rule for
> `dev.canari-emse.fr`, still pointing at `http://localhost:8080`** - production's frontend. Moved
> before dev answers on `127.0.0.1:3080` it turns a name that serves production into a 502.
> **A warning about the secrets themselves:** twelve were written with `gh secret set --body -`,
> which stores a literal dash rather than reading stdin, and all twelve had to be rewritten - the
> rule is in [durable-rules](durable-rules.md). That page's closing section is the map.

**CLOSED 2026-09-03, and by neither of the two shapes that had been proposed.** It was raised by
the user on 2026-09-02 (*"on peut toujours push sur dev non ?"*) as: there is no way to deploy dev
WITHOUT deploying production, because one trigger - a push to `main` - ran both estates in sequence.
The workflow migration answered it from the other end. **A run deploys exactly one estate, and which
one is decided by the RELEASE**: a `X.X.X-alpha.N` pre-release deploys dev and nothing else, a
stable deploys production and nothing else, and a push deploys neither. Both shapes weighed here are
gone rather than chosen - the `dev` branch existed for one day and was deleted, and `deploy.yml` has no
`workflow_dispatch` at all, a dispatch being a second door onto the one machine. **Kept because the
distinction it was written to preserve still holds**: the capability was absent because nobody had
asked for it, not because it had been considered and rejected, and it arrived the day somebody
asked.

**Shape.** Same machine as production (70 GB and 15 GiB free, measured), own compose project
`canari-dev`, resource limits so a dev container cannot starve prod, running permanently. Own
Postgres, own Redis **with** a `redis_data` volume, own Garage instance with its own keys, own RPC and
admin secrets, and a bucket named `canari-media-dev`. ~~Secrets carried by a GitHub environment named
`dev`, not by prefixed repo secrets.~~

> **THIS ONE DECISION WAS REVERSED WHILE BUILDING IT, 2026-09-01, and the reversal is recorded here
> rather than made quietly - it is the only scoped decision this chantier went against.** GitHub
> resolves `secrets.FOO` inside a job declaring `environment: dev` in this order: the environment's
> own secret, then the REPOSITORY secret. So an environment where somebody forgot one secret does not
> fail - it silently inherits production's value for it. That is a fail-OPEN mechanism, and it is
> precisely the defect the deleted `cd-dev.yml` shipped: it read the bare names and would have run a
> second estate on production's own `JWT_SECRET`, making a token minted by either valid in the other.
>
> Dev therefore reads `DEV_<NAME>` and **never** the bare name, so a missing dev secret is EMPTY and a
> `required` row refuses the deploy before a container is touched - fail-CLOSED. The GitHub environment
> still exists and `deploy-dev` still declares `environment: development`, for its deployment URL and
> any protection rules; the two mechanisms do not conflict, because the job no longer depends on
> environment scoping for isolation. The intent behind the original decision - dev secrets kept apart
> from production's - is fully served; only the mechanism changed, for a reason that would otherwise
> have re-created the exact hazard this environment exists to remove.

**Data: a FULL copy of production, unscrubbed - the user's choice, against the recommendation.** The
reason is usability: *"le plus proche de la prod est mieux quand-meme, sinon complique de se connecter
et d'interagir dans de bonnes conditions"*. Two facts were put to the user first and did not change
it: the server holds only ciphertext, so a copied conversation is **unreadable** on a fresh dev
client - the MLS keys live on the device and the media CEK is client-generated - and login ease comes
from the Authentik directory, not from the database. The copy therefore buys realistic users,
communities, posts, forms, calendar and shop, and buys nothing at all for chat, the most-tested
surface. **Three consequences are load-bearing and must be built into the copy procedure:** it
TRUNCATES the push-token table (copied tokens belong to prod's FCM sender, so a dev sender rejects
every one - safe, but it would log a failure per token, and noise is never acceptable), it CLEARS
`stripe_customer_id` (live-mode ids are unknown to test-mode keys and fail with a misleading message),
and it has a guard that categorically refuses the reverse direction. There is no mail transport
anywhere in this repo, so copied addresses cannot be written to.

**The copy runs as a workflow triggered by each minor release** - `bump-version.yml` fires it - which
is also what "reset" means here: dev is re-copied from prod, not emptied. That gives the named
starting point the user asked for in queue item 8, and makes a procedure that touches the production
database a rehearsed one rather than a rare gesture.

**Login: the same Authentik instance with a dedicated OIDC client, open to the whole directory** -
also the user's choice over a testers group, for the same usability reason. Redirect URIs limited to
`dev.canari-emse.fr`. JWT signing secrets are distinct from prod's, so a token minted by one
environment is refused by the other, and that non-interchangeability is a test.

**Exposure.** Web AND API behind Cloudflare Access on the existing admin group, because the earlier
answer left a full production copy reachable by any directory account - the API is where the data is,
so protecting only the web protected nothing. **The harness crosses Access with a service token**
injected as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, the user having required that
*"lors de nos tests automatises, il faut que les instances des navigateurs puissent y acceder
librement"*: an interactive SSO page cannot be crossed by an automated run, an egress-IP bypass
breaks silently when the address changes, and a per-profile SSO session would add a non-scriptable
step to the from-zero sequence beside SETUP-4's 2FA. No adminer in dev.

**CORRECTION, 2026-09-01, on the MECHANISM and on when it may be built.** The line above said "by
the Playwright context". **There is no Playwright in this repository at all** - measured:
`newContext`, `launchPersistentContext`, `extraHTTPHeaders`, `connectOverCDP`, `chromium.launch` and
`puppeteer` return nothing across `tools/cross-client-harness/*.mjs`. The harness drives real Chrome
over raw CDP (`cdp.mjs`, 887 lines, a websocket per target), so the mechanism is
`Network.setExtraHTTPHeaders` on each attached target after `Network.enable`, not a browser-context
option.

**And it is deliberately NOT built yet, which is a disposition rather than an omission.** There is no
Access application, no dev environment and no service token, so the crossing cannot be exercised -
and an arming path nobody can exercise is an untested code path inside the ONE instrument the whole
campaign depends on, in a file whose profiles cost a re-enrolment and SETUP-4's 2FA to lose. The
honest split is to build it in the session that can prove it crosses. What that session owes: read
the pair from the environment, return no headers at all when unset (so today's behaviour is
untouched), one `Network.setExtraHTTPHeaders` call at target attach, and one assertion in an existing
`*-selftest.mjs` that an unset pair injects nothing.

**Trigger: deployed from `main` on every push, with no `dev` branch at all.** One trigger, no possible
divergence, and `WORK ON main` stays intact. **(SUPERSEDED 2026-09-03: nothing deploys on a push any
more, and this estate is reached by publishing a `X.X.X-alpha.N` pre-release. The paragraph stays as
the record of what was decided on 2026-08-17, and the sentence below about a failed dev migration
blocking the prod deploy no longer describes anything - a run deploys one estate.)** Dev deploys BEFORE prod and **a failed dev migration
blocks the prod deploy** - the most valuable gate this whole item buys, and it is free: dev runs the
migration against a copy of prod's data, so a migration that breaks there would have broken prod.
Accepted cost: dev never pre-validates a commit, it is where things are tried afterwards.

**CD shape: ONE `deploy.yml` parameterised by environment**, not a second file - `cd-dev.yml` drifted to
734 unusable lines in four months precisely because it was separate. Dev builds its own images
(the images embed the frontend and therefore the domain), roughly doubling build time, accepted.

**Version.** `bump-version.yml` stays the only writer. **DONE 2026-09-01, with one correction: the
suffix is a SEPARATE FIELD, not part of `version`.** `/api/version` now returns `build`, fed by
`DEPLOY_BUILD`; putting `+dev.<sha7>` inside `version` as first described would have broken the update
path, because the frontend turns that field into a release tag and a GitHub download URL
(`releaseTag`, `getReleaseApkDownloadUrl`), so a dev client would have been offered an update from
`v0.14.15+dev.abc1234` - a 404. The permanent, non-dismissible **"test environment" banner** is built
(`EnvironmentBanner.svelte`, driven by the build-time `VITE_DEPLOY_ENVIRONMENT`, unset meaning
production so a missing variable never brands prod) - non-negotiable given the copy is
indistinguishable from prod on screen. **Both variables are written by the pipeline as of 2026-09-01**:
`build-frontend-dev` writes `VITE_DEPLOY_ENVIRONMENT=development` into the dev bundle, and
`render-env.sh --build dev.<sha7>` writes `DEPLOY_BUILD` into dev's `.env` only - the manifest marks
that row `skip` for production, so a tagged release keeps `build: null`. `minClientVersion` is per-environment by virtue of the separate
database. A GitHub release does not build dev.

**Dev is deliberately ONE MAJOR AHEAD, and a PROVEN gap lifts a ceiling.** ~~Postgres 18 starting in
dev, on a data directory written by prod's 15, and serving `/api/version`, is exactly the test that the
ceiling table demands.~~ **CORRECTED 2026-09-01 WHILE BUILDING IT, and this is the most important
correction in this item: a green dev deploy is NOT that test.** The copy is `pg_dump` replayed into a
cluster the new major initialised itself, from empty - a LOGICAL copy, which never touches a data
directory written by the old major and therefore cannot fail the way production failed. It would have
gone green on 18 while saying nothing about `pg_upgrade` or the 18+ move of the mount point from
`/var/lib/postgresql/data` to `/var/lib/postgresql`, and the next `postgres` major would have
auto-merged on it - the outage of 2026-09-01 re-armed behind a gate that reads as proof. So
`infrastructure/dev/version-gap.yml` makes each row declare WHICH of four questions its gap answers
(`none`, `fresh_cluster`, `logical_restore`, `in_place_upgrade`) and `lib/ceiling.sh` accepts only
`in_place_upgrade`, with a non-empty `proof`, releasing exactly the major it was proven for. All three
rows read `none` today, which is the honest state. What the dev environment buys on its own is a
`logical_restore` - real, worth having, and lifting nothing. The
[ceiling table](#p1---the-three-refusals-the-auto-merge-ceiling-makes-and-the-test-that-retires-each)
is therefore retired by a rehearsal on a BINARY copy of prod's `PGDATA`, which is a separate piece of
work and is not what deploying dev does. **The user's choice of a full copy is what makes this credible** - a synthetic seeder would
have proved nothing about a real data directory - so the tension recorded earlier between "safe empty
dev" and "dev that can lift a ceiling" is resolved in favour of the copy. The major gap between dev
and prod is therefore EXPECTED and must be DECLARED in a file, with a test asserting the declared gap
rather than asserting equality.

**Mobile is phase 2, after the web environment actually serves something other than prod.** Then:
`applicationId` `fr.emse.canari.dev`, `productName` `Canari Dev`, differentiated icon, side-by-side
installation with prod, a **separate keystore** (a prod keystore leaked through a dev build is
unrecoverable - Play refuses any key change), four `ANDROID_DEV_*` secrets, and the APK distributed as
a GitHub artefact with **no Play listing** - a second listing would mean redoing content, data-safety
and privacy-policy questionnaires for no gain. Three Android details are build-breaking or
resolution-breaking if missed: `google-services.json` comes from a secret and the Gradle plugin
validates the package name, so a prod file fails a dev build; the custom scheme `fr.emse.canari`
(five hosts) must become `fr.emse.canari.dev` or two installed apps claim the same scheme; and the
App Link on `https://canari-emse.fr` must be replaced by one on `dev.canari-emse.fr`, with prod's
`assetlinks.json` never listing the dev fingerprint. **Dev gets its own Firebase project** - the user
is creating it, since the Play service account holds only the `androidpublisher` scope and no
`serviceusage.services.enable`, so it can neither create a project nor enable an API. iOS and desktop
are out of scope.

**Also decided:** the April clone at `/home/canari/canari-dev` is read for what `DEV_BRANCH_SETUP.md`
still holds, that is folded into the dev wiki page, and the clone is then DELETED - blocking, before
anything deploys there. `auth_db` is renamed during the PostgreSQL 18 window, rehearsed in dev first.
Dev is excluded from `backup.sh` by a positive list. No TURN in dev while `CALLS_ENABLED = false`.
`MIGALLERY_API_URL`, which the dev compose still defaults to the production `https://gallery.mitv.fr`,
is cut. Cookie attributes are prod's - **DONE 2026-09-01, and it was worse than the plan assumed:**
`isDev` was not merely domain-derived, it was decided per request from `Origin`/`Referer`, so outside
production any caller claiming localhost got its own refresh credential without `Secure`. Now read
once from `ALLOW_INSECURE_COOKIES`, no default, with `true` + `NODE_ENV=production` a startup error;
and the rewritten dev compose had left `NODE_ENV` off all four NestJS services, which is exactly how
a live HTTPS environment would have reached that branch - a derived test now forbids it
([sessions](sessions.md#the-cookies-own-attributes-are-a-deployment-fact-not-a-per-request-one)). The
refresh cookie stays host-only with no `domain:` attribute, which is what already keeps prod and dev
from sharing it ([auth.controller.ts](../../apps/core-service/src/auth/auth.controller.ts)). The tunnel token readable
in `ps aux` is a separate P2, deliberately not folded in here.

**FOLDED IN FROM THE APRIL CLONE, which was then deleted 2026-09-01.** Its `DEV_BRANCH_SETUP.md`
described a stack that no longer exists - MongoDB, Kafka and MinIO, none of which this repo runs - and
a branch workflow (feature -> PR -> `dev` -> PR -> `main`) that the decisions above replace outright.
Its "push" section recommended disabling the Husky hooks and cited a git setting that does not exist
(`core.sharen`), which is reason enough not to archive it: it is a document that teaches the opposite
of FACE THE BLOCKAGE. Both it and `DISPLAY_LOCATIONS.md` remain in `main`'s history (the clone sat at
`5ce5ddc`, an ancestor of `main`), so deleting 24 MB of stale worktree lost nothing. **Four things
survived and are inputs to phase 1:**

- **The dev frontend's host port is `3080`**, which the current `docker-compose.dev.yml` port set does
  not make obvious next to the service ports (5433, 6380, 3100, 3110-3114). It is what the tunnel must
  route `dev.canari-emse.fr` to.
- **The two-directory layout on one machine** - `/home/canari/canari` and `/home/canari/canari-dev` -
  is what the April attempt already assumed, and it matches the decision taken above.
- **Its nginx claim is WRONG and the correction matters.** It asserted that nginx needs vhost entries
  for both `dev.canari-emse.fr` and `canari-emse.fr`. It does not: dev runs its OWN frontend container
  and therefore its own nginx, so there are TWO instances and the tunnel picks between them by port
  (prod `8888`, dev `3080`). Nothing about prod's nginx changes, which is the whole point of the
  single-public-entry-point rule - a second environment must not edit the first one's entry point.
- **It tagged dev images `dev`, a MUTABLE tag, and that now collides with a durable rule.** Since
  2026-08-30 the containers production runs are identified by DIGEST, not by a tag. Whether dev may use
  a mutable tag is a decision that has to be made deliberately rather than inherited from this
  document: a mutable tag means a dev redeploy cannot be reproduced, which sits badly with the standing
  demand that everything be deterministic and reproducible.

**WHAT IS ACTUALLY BLOCKED, narrowed by measurement 2026-09-01 - it is ONE credential, not four.**

- **CORRECTED 2026-09-01 BY MEASUREMENT: the blocker was never DNS.** There is **no DNS record to
  create** - `dev.canari-emse.fr` already exists as a proxied CNAME onto the same tunnel as every other
  hostname in the zone, and the tunnel's INGRESS is what maps a hostname to a local port. That ingress
  routes `dev.canari-emse.fr` to `http://localhost:8080`, **the identical service production is on**,
  which is the whole reason the dev name serves prod. **The single change the environment needs is that
  one rule repointed to `http://localhost:3080`**, the dev frontend's host port. The operative
  permission is therefore `Account -> Cloudflare Tunnel`, NOT `Zone -> DNS`; the pre-existing token
  READS the tunnel configuration while the DNS-scoped token added for this work is refused with `1001`.
  Whether that token holds `Edit` or only `Read` is deliberately UNMEASURED: the only way to test it is
  to write to a live ingress object that `canari-emse.fr` rides, so a malformed PUT would take
  production off the internet. The edit is made once dev exists, by GET, single-rule change, PUT, with
  the original saved first. **The hostname-to-service map itself stays out of this PUBLIC repo** - it
  names the admin hosts, and that exclusion was already a deliberate decision; it is in agent memory.
- **The DNS permission, described here as it was believed before the measurement above, and still
  worth having:** The stored token reads
  zones (`/zones?name=` returns the id) but is refused on `/zones/{id}/dns_records` with `10000`, so it
  holds `Zone:Zone:Read` and not `Zone:DNS`. **The permission needed appears only on a policy whose
  RESOURCE is a zone**; a policy scoped to "entire account" offers `Account DNS Settings`, `DNS
  Firewall`, `DNS View` and the Registrar groups, **none of which grant any right over DNS records** -
  that mismatch is what made the first attempt look granted when it was not. Phase 1 needs
  `Zone -> DNS -> Edit` on `canari-emse.fr`, plus, account-scoped, `Access: Apps and Policies -> Edit`
  and `Access: Service Tokens -> Edit` for the Access application and the harness token. **Beware one
  false negative:** `/user/tokens/verify` answers `Invalid API Token` for an ACCOUNT-owned token even
  when it works, so that endpoint must never be used to judge one.
- **Authentik is NOT blocked - the box can be driven from here** (user, 2026-09-01). The alias is
  `ssh miconnect`, not `rootz-emse`, which is in no SSH config; Authentik 2026.8.0 runs as
  `miconnect-server-1`, and `docker exec miconnect-server-1 ak shell -c '...'` executes against the
  live models, verified by listing the five existing providers. **The `Canari` provider's settings were
  read so the dev one is a faithful clone rather than a guess:** `client_type` confidential,
  `sub_mode` `hashed_user_id`, `issuer_mode` **`per_provider`** - which is why a dev token cannot be
  mistaken for a prod one - claims in the id token, validity 1 min / 5 min / 30 days, and **four custom
  property mappings that must be carried over or dev logins lose fields prod has**: `Promotion`,
  `Formation`, `First + Last Names`, `Personnel de l'ecole`, alongside the two default OpenID mappings.
  Its six redirect URIs (`canari-emse.fr`, both `tauri.localhost` schemes, ports 1420/1421, and
  `fr.emse.canari://callback`) are the template; the dev provider's are the same list rewritten onto
  `dev.canari-emse.fr` and `fr.emse.canari.dev://callback`.
- **Stripe is DROPPED from dev entirely** (user, 2026-09-01: *"oublie. Stripe ne sera pas accessible en
  dev pour le moment, tant pis"*). No keys, no webhook endpoint, and the payment path is inert there.
  The copy still CLEARS `stripe_customer_id`, for the same reason as before and now more strongly: with
  no keys at all, a copied live-mode id could only ever produce a misleading failure.

**THE COPY IS BUILT AND ITS GUARDS ARE TESTED (2026-09-01):**
`infrastructure/dev/copy-prod-to-dev.sh`, with
`.github/scripts/tests/dev-copy-guards.test.sh` holding it to its two properties. Three things came
out of building it that the plan had wrong:

- **It is SEVEN payment columns across four tables, not the one the plan named.** Measured on prod:
  `users."stripeCustomerId"`, `associations."stripeAccountId"`, `associations."stripeOnboardingComplete"`,
  `associations."lydiaAccountId"`, `associations."lydiaOnboardingComplete"`,
  `purchase_records."stripePaymentIntentId"`, `submissions."stripeSessionId"`. Five associations hold a
  real `stripeAccountId`; both Lydia columns are still empty, which is precisely why they are stripped
  now rather than after WP-LYDIA-1 fills them. The two `*OnboardingComplete` columns are NOT NULL
  booleans and are set `false`, not nulled. **The test DERIVES this list from the entity declarations**,
  so a column added later fails the build until the copy strips it - proved by injecting a
  `stripeInvoiceId` and watching 8 columns derive and the new one fail.
- **The direction is enforced by Docker's own labels, not by a path.** The two compose projects are
  `readonly` literals, containers are found by `com.docker.compose.project`, and the database user is
  read from the container's own environment - so the script needs no compose file, no `.env` and no
  path to be right. Every write goes through one function that RE-READS the target's label per call.
  Verified on the box: the discovery finds `infrastructure-postgres-1` and reads `POSTGRES_USER=canari`,
  and a `--dry-run` with no dev environment present refuses with
  `no running 'postgres' container in project 'canari-dev'` before touching anything.
- **`push_token` holds 70 rows on prod and no foreign key references it**, so the truncate is safe.

**AND ONE GAP IT EXPOSED, small but real: the platform cannot declare payments DISABLED.**
`platform_config.payment_provider` is typed `'stripe' | 'lydia'` with no third value, so the copy
leaves it alone - writing anything else would contradict what the code asserts about the column. The
consequence is that dev presents Stripe as the live provider and fails on use, with no keys behind it.
A `'none'` value, refused by the DTO's `@IsIn` today, would let an environment say the truth. Worth
one line of enum and one migration, and it is not urgent.

**Phase 2 alone remains owed to the user:** the Firebase project (the Play service account holds only
`androidpublisher` and no `serviceusage.services.enable`, so it can neither create a project nor turn
an API on) and the dev keystore, plus a decision on where that keystore is backed up.

**MEASURED 2026-09-01, before any of it is scoped - four facts, three of them worse than the note
above assumed.**

- **`dev.canari-emse.fr` is not merely an alias, it is a PUBLIC one.** It answers `200` and
  `/api/version` returns `{"version":"0.14.15","minClientVersion":"0.14.0"}` - byte for byte what
  `canari-emse.fr` returns, because it is the same containers. Anyone told "use the dev site" today
  is typing into production, and the name is doing the opposite of its job.
- **`/home/canari/canari-dev/` already exists, and it is a trap.** It is a clone stranded on a
  `master` branch at `5ce5ddc` (2026-04-24), four months and one whole toolchain behind: it still
  carries `.prettierrc`, `.prettierignore` and `.pre-commit-config.yaml`, none of which this repo has
  used since the move to oxfmt. It also holds a `DEV_BRANCH_SETUP.md` that exists in NO commit of
  this repository - a design document that lives only on the box, which is exactly the failure
  `CLAUDE.md` forbids. Read it and fold what survives into this page, then delete the clone. The
  hazard that used to accompany this - `cd-dev.yml` deploying into that directory on top of it - is
  gone with the workflow, so what is left is purely to recover the document before the clone goes.
- **`cd-dev.yml` was dormant, not missing - and is now DELETED (2026-09-01, `a8ac1828` is the last
  commit holding it).** 734 lines, `on: push: branches: [dev]`, last run 2026-05-09, and the `dev`
  branch does not exist on origin, so its trigger could never fire - but `workflow_dispatch` could,
  and **it read the SAME secrets as production**, Garage keys and `FIREBASE_SERVICE_ACCOUNT_JSON`
  included, with `docker-compose.dev.yml` then defaulting `GARAGE_BUCKET` to the same `canari-media`.
  Its host ports were offset (5433, 6380, 3100, 3104, 3110-3114) so nothing collided, and its volumes
  were separate by compose project - but `redis_data` was absent from its `volumes:` block entirely,
  so a dev Redis would have kept the shared message log in a container filesystem. Waking it up as it
  stood was how a test notification reaches a real phone, which is why the deletion was pulled forward
  ahead of the CD unification rather than bundled with it. It was no loss as a reference: the dev arm
  will be written from `deploy.yml`, which works, not from a file that never did.
- **The box has room, so capacity is not a reason to host dev elsewhere:** 70 GB free of 125 GB, and
  15 GiB of 16 GiB RAM available with the whole production estate running at ~800 MiB.

**One thing found while measuring, unrelated to dev and owed a decision:** the tunnel runs as
`cloudflared --no-autoupdate tunnel run --token <token>` under root, which means its ingress lives in
the Cloudflare dashboard rather than in a file on the box - and **the token is visible in `ps aux` to
every user on the machine.** A token-based tunnel also means a second environment's hostname is a
dashboard change, not a repo change, so nothing in this repository would record it.

### A SECOND campaign, for everything that is not chat - asked for 2026-08-16

**It is a second campaign, not more sections on this one** - the user's framing, and it settles a
structural question. The expected size is dozens of checks per surface, where the current dashboard
already carries 18 sections in one file whose entire job is to be a LIVE summary someone can read.
Pouring a second campaign into it destroys that property. So: its own dashboard, its own manifest, its
own phase files - and `checks.mjs`'s phase list is the seam to look at first, since a second campaign
must be runnable without re-running this one.

The 18 sections were written around one class of failure: a message crossing between two transports
and two platforms, and the silent loss that class produces. That leaves whole surfaces with **no check
at all** - posts, forms, communities as a management surface, profiles, media browsing, calendar,
payments - and a surface with no check is not a surface that works, it is one nobody has asked about.

The named starting point is the **`social` notification family**: a post, a comment, a reaction on a
post, a form alert. It does **not** share the chat path - no MLS, no per-device fan-out, no outbox -
so none of the verdicts already taken transfer to it, and its delivery is server-decided, which is a
different failure mode (an audience computed wrong notifies the wrong people, and nothing on the
client can detect that).

Three things must be settled BEFORE writing checks:

- **The venue.** Every existing check sends into the two-test-account DM or `Canari Test Venue`
  precisely because production is shared. A post or a form alert has an AUDIENCE, so the same
  discipline needs an answer that does not exist yet: what does a test post look like that no real
  member is notified by? Until that is answered, no social check may run on prod.
- **The observer.** `srvlog.mjs` partitions its window by subject and classifies every line. The
  services behind posts and forms are not in that window today, and an unclassified window is not an
  observation.
- **What a verdict rests on.** A chat check reads the peer's DOM. A notification with an audience is
  only correct if the people who should NOT get it did not - an assertion about absence, over a
  population, needing its window sized from a measured latency rather than guessed
  ([testing-methodology](testing-methodology.md), rule 13).

**The eleven emoji rows belong to this campaign** - they are listed in the bundled-emoji-font
entry above, which is their only copy.

## THE DELIVERY CHAIN REVIEW - opened by the 2026-09-06 outage, agreed with the user the same night

*"C'est peut-etre pour ca qu'apres la resolution rapide de ce probleme, il faut qu'on revoie le
workflow"* (user, 2026-09-06), after an earlier exchange in which the complaint was READABILITY -
*"C'est pas un peu alambique tout ces workflows ?"*. The outage turned that into five items that are
DEMONSTRATED rather than argued. Ordered by value, which is not the order they were noticed in.

**1. THERE IS NO ROLLBACK, AND THE ONE ATTEMPTED WAS GREEN WHILE DOING NOTHING.** P1.
`infrastructure/docker-compose.prod.yml` names its images `:latest`, so what production runs is
decided entirely by what that tag points at when `docker pull` runs. Re-running v0.16.1's
`Deploy to Production Server` on 2026-09-06 passed **twenty steps**, authenticated to GHCR, migrated,
health-checked, and redeployed **v0.16.4** - because `latest` is v0.16.4. A version can be shipped
and cannot be unshipped. The pipeline ALREADY pushes an immutable `v${version}` tag
(`deploy.yml`, `type=raw,value=v${{ inputs.version }}`); deploying by it would make re-running an old
job a real rollback, which is the shape everybody already assumes it has.

**2. A DEPLOYED ESTATE IS NOT ASKED WHETHER IT WORKS.** P1, and it is what let this reach users.
The release run was green, `canari-emse.fr` and `dev.canari-emse.fr` both answered `HTTP 200`, and
every login was refused. `CLAUDE.md` already says a green deploy proves the containers started and
never that the site answers; **answering does not prove it works either**.
`tools/cross-client-harness/deployed-wasm-check.mjs` was written during the incident and refuses an
estate serving a wasm that can panic - it named `mls_wasm_bg.YXThuGSF.wasm` on production, the exact
file in the user's stack trace, with no credentials and in seconds. It belongs after the dev deploy,
where it would have stopped this build before production. It is NOT a login and must not be sold as
one; the honest check is a real sign-in on the deployed build, and no campaign row does that.

**3. A RELEASE THAT DID NOT REACH PRODUCTION IS LOUD NOW; WHAT IS STILL SILENT IS PRODUCTION
FALLING OVER LATER.** The first half is closed (2026-09-10). `Production estate` needs
`[android, ios]` in success - deliberately, and that dependency is untouched: production must not
serve a version a store has just refused. What was wrong is that a SKIPPED job does not fail a
run, so v0.16.2 and v0.16.3 were published, announced and served to nobody while production ran
v0.16.1 from 2026-09-03 until the next deploy broke.

`release-shipped.sh` closes it, and it reads the `prod-released` MARKER rather than the estate
job's result - a job result says what the workflow did, the marker says what production serves,
and they differ exactly when it matters (a tag push that fails after a green deploy, an emergency
deploy by hand). Seven assertions in `release-shipped.test.sh`, including the case nobody expects:
a SUCCESSFUL estate whose marker did not move.

**The sibling is still open and it is the USER's**: nothing watches production between releases.
This check fires once, at the moment of a release. An estate that dies an hour later is still
reported by nobody - see the external uptime probe in the table at the top of this page.

**4. THE EMERGENCY PATH SHORTENS NOTHING.** P2, measured under real urgency. `gh pr merge --admin`
skips the ruleset's required check on the PULL REQUEST; `release-preflight.sh` gate 3 then refuses
the release because `CI passed` never ran on the commit - and the wait is for the same CI, later,
after a failed release run. The bypass bought zero minutes and cost one refused run. Either write
that down where somebody reaching for it will read it, or build a short path that is actually short.

**5. THE RUN VIEW MISLED, AND IT IS FIXED (2026-09-07) - NOT SHIPPED UNTIL A RELEASE CARRIES IT.**
Was P3. `deploy.yml` was called twice with a `phase` input and every job inside carried
`if: inputs.phase == ...`, so the two calls contributed identically-named jobs and half of them were
`skipped` for reasons the names did not carry - the user read
`Production estate / Deploy to dev.canari-emse.fr: skipped` and could not tell which skip was normal.
**MEASURED before the fix**, on `v0.16.4` (run 34057019347), the last stable to reach the end: 22
rows, 5 skipped, and **4 of those 5 structurally impossible** rather than merely not taken.

THE DEEPER FIX WAS THE ONE TAKEN, and this entry had already named it: *one small library workflow
per target, which costs NOTHING in the Actions list*. `deploy.yml` is gone, replaced by `build.yml`,
`serve-dev.yml` and `serve-prod.yml` - one file per thing done, each called at most once, so every
row a release draws is a row that can run. The release kind moved with it: it was resolved in
`preflight` and then carried DOWN and re-tested in eight places, and it is now ONE fork in
`release.yml` producing an estate NAME (user, 2026-09-07: *"faire la dichotomie plus tot dans
l'arborescence"*). Neither estate workflow mentions a pre-release at all any more.

ASSERTED, so it cannot regress quietly: `release-chain.test.sh` fails if any workflow is called
twice, if the estate is resolved anywhere but the one fork, or if either estate workflow starts
reading the release kind again (121 assertions, all green). `deploy-env.test.sh` follows the `.env`
to `serve-prod.yml` and the DEV_ secrets to `serve-dev.yml` (41 assertions). `ecosystem-shape`
carries the measured reason the four repositories legitimately differ here: the other three deploy
ONE estate, their `deploy.yml` declares no `phase` at all, and `release.yml` calls it once.

**AND THE CONSTRAINT THAT SHAPED ALL OF IT, WHICH IS NOT TO BE RELITIGATED.** *"le moins de workflows
differents possibles, ca inonde la console github"*. The complexity did not appear from nowhere: it
moved from many files into few files with phases. Any proposal here must keep four visible workflows.

**6. AUTO-MERGE STAYS ARMED DURING AN INCIDENT, AND IT NEARLY UNDID THE FIX.** P2, and it was luck
rather than design that it did not. While production was down, PR #397 - which edits
`mls-core/src/state.rs`, the file the hotfix was changing - merged itself on schedule. It landed
BEFORE the hotfix, so the hotfix squashed on top and both guards survived; had the order been the
other way round, a green auto-merge would have silently reverted a `cfg` that was holding every web
login up, and nothing in the chain would have said so. The verification that caught it was a hand
`grep` of `origin/main` after the fact. **Either arming is suspended while an incident is open, or a
pull request touching a file the in-flight fix touches is held** - and the second needs no human
switch, which makes it the better one.

**AND THE HONEST CHECK FOR ITEM 2 CANNOT BE A CAMPAIGN ROW, WHICH IS WHY IT IS NOT ONE.** The rig has
targeted the LOCAL estate since 2026-09-03, deliberately, so no row it could ever carry would have
opened a session on `canari-emse.fr` or `dev.canari-emse.fr`. `deployed-wasm-check.mjs` closes the
part that needs no account - and the next defect of this class may not be in the wasm at all, in
which case it sees nothing. **The real check is a sign-in against the deployed estate, in the
pipeline, right after the dev deploy and before the stable is allowed to proceed.**

That needs a decision rather than code, which is why it stops here: a dedicated smoke account has to
exist on both estates, its credentials have to be GitHub secrets, and somebody has to accept that a
CI job holds a real login for a real user on production. **The alternative - that nobody signs in
before users do - is what happened on 2026-09-06**, and it cost every user their access for the time
it took one of them to report it.

**7. AN INCIDENT WAITS BEHIND STORE ARTEFACTS IT DOES NOT NEED.** P3, measured on 2026-09-06.
`release.yml` carries `concurrency: group: release, cancel-in-progress: false`, which is right - two
releases running at once would race the bump and the markers. But `v0.16.5-alpha.2`, whose only job
was to move `dev-deployed` one commit so the hotfix could ship, sat `pending` while
`v0.16.5-alpha.1` finished building an APK and an IPA that nobody was waiting for. **The restoration
of service was queued behind a TestFlight upload.** Whatever the fix is - a lane for a release whose
estate work is done, cancelling a superseded pre-release's store arms, or simply knowing to cancel by
hand - the thing to keep is that the serialisation is correct and only its GRANULARITY is wrong: the
estate and the stores do not need the same lock.
