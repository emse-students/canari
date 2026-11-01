# MLS availability when no device holds a group (audit, 2026-10-31)

**Question (owner, 2026-10-31):** *"On a une parade si jamais il n'y a plus d'appareil qui a les
clefs du groupe ? La disponibilite doit etre maximale."* Is there a way back in when no live device
holds a group's MLS state any more?

Sections 1-8 are a read-only audit of `main` at `c5186791b` (#2791 merged: a member's further
device is added automatically); line numbers cite that commit. Nothing was run against an estate.
**The owner decided on 2026-10-31 ([decisions](#decisions-taken-2026-10-31)), and D1-D3 and D5 are
built - with the self-join SHUT on the server until every member client reads it as D2/D3 say
([the gate](#the-gate-d1-waits-for-d2-and-d3-on-every-member-client))**: where the audit below says
"today", it describes the code before that build.

**Related:** [mls-recovery-ladder](mls-recovery-ladder.md) (rung 2, the external join),
[mls-protocol](mls-protocol.md#a-device-of-a-member-is-added-never-asked-about-2026-10-31) (the
further-device door), [mls-graine-state-machine](mls-graine-state-machine.md) (dead ends DE1/DE2 and
the one-holder report), [dm-vs-community-encryption](dm-vs-community-encryption.md),
[history-reconciliation](history-reconciliation.md), [channel-encryption](channel-encryption.md).

## Verdict in five lines

1. **A group needs a CURRENT BASE, not a live holder, for anyone to get back in.** An external commit
   is built from the stored GroupInfo alone. Every current commit carries the base of the epoch it
   creates, so the base is almost always current even when every device that minted it is gone.
2. **What locks a conversation for good today is a CLIENT RULE, not RFC 9420.** A user's new device
   whose user still holds a (dead) leaf is a "further device", refuses to join by itself and waits for
   a member's device to add it. When no member device ever answers, it waits forever, although the
   server would accept its external commit.
3. **Nothing collects a dead leaf without a live member.** So the predicate stays `further_device`
   for as long as nobody is there - the candidate in the brief is **verified**.
4. **Communities and channels are not affected**: an entitled device joins the key group by itself.
   Only a stale base with no holder closes one (terminal, and rare).
5. **The past is unrecoverable by design wherever no device (and no backup) still holds it**: DM
   history lives only on devices, community history is server ciphertext whose seeds live only on
   devices.

## 1. What an entry needs, and who may use it

An external join reads the stored base (`GET /api/mls/group-info/:groupId`), builds an external
commit on it (`MlsManager::join_by_external_commit`, `frontend/mls-core/src/welcome.rs:84`) and
submits it under the strict epoch gate. **No holder takes part.** A holder was needed only when the
base was exported. Since 2026-10-04 every commit carries the base it creates, and `validateCommit`
stores it in the transaction that advances the epoch (`newBase`,
`apps/chat-delivery-service/src/services/messaging.service.ts:2448`). The Android background Add
carries one too (`push.controller.ts:755`). A base therefore falls behind only after a commit from a
client older than that change, or when the base was never published.

So DE2 of [mls-graine-state-machine](mls-graine-state-machine.md) ("a group whose tree NO member
holds any longer ... terminal by construction") is exact **only when the base is stale or absent**.
With a current base, RFC 9420 lets a party with no state in. The same overstatement is in the
`reportSingleHolderGroups` comment and log text (`apps/chat-delivery-service/src/app.controller.ts:836-842`,
`:920-925`): "nothing in this system or in RFC 9420 can reopen them". What closes such a
conversation today is the door policy below.

### The doors, as built

| Joiner | Door today | Where |
| --- | --- | --- |
| A device whose OWN leaf is still in the tree (state lost, id kept) | joins by itself and replaces its prior leaf | `welcome.rs:58-60` returns `false`; the one Remove is checked by `refuse_foreign_external_remove` (`frontend/mls-core/src/messaging.rs:655`) and `assertExternalRemoveIsOwnPriorLeaf` (`messaging.service.ts:3471`) |
| A user holding NO leaf, with a roster seat that is not a link ask | joins by itself; members write "entered without being added" (`returning` / `direct-peer` / `new-person`) | `welcome.rs:39-66` returns `false`; observer `entersUninvited`, `frontend/src/lib/mls-client/deviceTrust.ts:133` |
| **A further device**: its user holds a leaf, this device does not | **refuses itself** (`further_device`) and sends a `welcome_request` | `welcome.rs:39`; `BaseMlsService.ts:6988-7002`; `recovery.ts:742` and `:945` |
| A seat awaiting a member (invitation link) | the server answers 409 `awaiting_admission` to the base and to every commit | `assertMayReadExternalBase`, `messaging.service.ts:4365-4379`; `assertCommitterMayCommit`, `:3548-3575`; client `recovery.ts:625` |
| No roster seat | 403 `NOT_A_MEMBER`, recovery ends | `recovery.ts:748`, `stopRecovering` |
| An entitled device, community or salon key group | joins by itself, no further-device door | `ensureDistributionGroup`, `BaseMlsService.ts:7268` (only `welcomeOwed: 'ask'`); entitlement asked of social-service in `assertCommitterMayCommit` |

**The server would accept a further device's external commit.** The gate allows an external commit
from any caller holding a roster seat that is not awaiting (`seat !== null`,
`messaging.service.ts:3571`) and binds the new leaf to the authenticated caller
(`external_leaf_foreign`, `:2294`). The further-device refusal is the client's own choice, read off
the unverified tree of the served GroupInfo (`external_join_is_a_further_device`, `welcome.rs:27-38`).
It exists so that an honest device never makes the entry members' observers flag as
`unvouched-device` (`DeviceEvent::enters_as_unvouched_device`,
`frontend/mls-core/src/device_trust.rs:175`; TypeScript twin `deviceTrust.ts:154`).

**The resulting asymmetry.** A member with no leaf at all can let themselves in. A member whose only
leaf belongs to a dead device cannot. The dead leaf is what blocks.

## 2. Who answers a further device's ask

`askAMemberToReAddUs` (`recovery.ts:1196`) sends a `welcome_request`. The server
(`notifyWelcomeRequest`, `messaging.service.ts:5744`) elects among `routableMembers` (`:5439`): the
`group:members:<id>` set, reloaded from `active` device rows only. A device that is itself waiting is
never a candidate.

- **A candidate is online**: the request is forwarded to it (`:5853`), and `automaticAdmission`
  (`frontend/src/lib/utils/chat/actions.ts:118`) adds the device because its user holds a leaf in
  the answerer's tree. The account's own other live devices are candidates too.
- **Nobody is online**: the ask is stored for 24 h (`pending_welcome:<group>`, `:5861`), queued on
  every member's `pending_welcome_notify:<user>` for their next connection, and an FCM
  `welcome_request_pending` wakes members' Android phones (`:5905`).
  `prepare_welcome_background_with_key` (`frontend/src-tauri/src/mobile/background.rs:577`) adds
  the device from the push with the same user-level verdict, **without the app being opened**.
- **iOS has no background path**: `canari_push.mm:3953` does not act on `welcome_request_pending`.
  A web member answers only while a tab is open.
- **Durable side**: `registerDevice` writes a `pending` seat in every group of the user
  (`apps/chat-delivery-service/src/controllers/devices.controller.ts:427-452`), which every member's
  `processPendingInvitations` sweep honours on its own connection. The hourly cleanup deletes it
  14 days after `pendingSince` (`app.controller.ts:1263`), and the next registration writes it
  again. The requester itself re-asks once per `RECOVERY_TIMEOUT_MS` while its app is open and
  records nothing (its server-row backlog entry was closed by D1 on 2026-10-31).

So the further device waits for **any device of any member that holds the tree and is online, an
Android phone with a working push token, or an app opened later**. If none ever exists, nothing
else answers.

## 3. Dead leaves: nothing collects them without a live member

- **The stray-leaf collector removes only REVOKED devices, and only through a member's commit.**
  `removeStrayLeaves` (`frontend/src/lib/utils/chat/strayLeaves.ts:70`) is an allowlist of the
  identities `group-rosters` names as revoked (`revokedLeavesIn`, `:154`). It runs on a member's
  connection, in the held-group branch, so a group with no live member is never visited.
- **A revocation is written only by `DELETE mls/devices/:userId/:deviceId`**
  (`devices.controller.ts:906-960`, the one caller of `upsertRevocation`,
  `apps/chat-delivery-service/src/utils/revocation.ts:60`): the owner's device panel, or an install
  retiring the id its own rotation abandoned (`reason=retired`,
  `frontend/src/lib/mls-client/abandonedDevices.ts`). **An uninstalled or lost phone is never
  revoked** unless its owner deletes it by hand.
- **The server's garbage collection is not a revocation.** `detectStaleDevices`
  (`app.controller.ts:402`) demotes an `active` row to `pending` once the device has published no
  KeyPackage for 90 days. `cleanupStaleDevices` (`:1142`) then purges its footprint
  (`purgeDeviceFootprint` without `recordKeyGroupsHeld`, `messaging.service.ts:956`). Both act on
  routing rows. A ratchet tree is not a routing row.
- **A further device cannot remove its sibling's leaf itself.** An external commit may carry at most
  one Remove, and only of the joiner's own prior leaf (`messaging.rs:655`, `messaging.service.ts:3471`).
- **A lost state always produces a further device.** A saved state that is absent, altered or
  undecryptable makes the client rotate its identity (`rotateDeviceIdentity`,
  `BaseMlsService.ts:3629`, called at `:3714`, `TauriMlsService.ts:839`, `WebMlsService.ts:932`),
  so the new id is a sibling of the old leaf. The old id is retired (revoked), but collecting it
  still needs a live member.

**The candidate in the brief is verified.** A user's new device, in a group whose tree still holds a
leaf of that user's dead device, with no member device ever able to answer: `external_join_is_a_further_device`
is `true` on every attempt (it is re-read on every fresh base, `BaseMlsService.ts:6985-7002`), the
device asks, nobody answers, and nothing removes the dead leaf. It waits forever, and the server
holds a base it would have accepted a join on.

## 4. Case by case

"Answerable" below means: some device of some member holds the tree and is online, is an Android
phone the push can wake, or belongs to someone who opens the app later. "Base current" is the normal
case (section 1).

| # | Situation | Member's new device | Returning member, state intact | New person by link |
| --- | --- | --- | --- | --- |
| C1 | **1:1**, one side lost every device, the other side answerable | `further_device`, added by the peer's device automatically (Android in the background too) | not applicable (the peer is the holder) | no link asks in a 1:1 (`askAMemberToAdmit` is group-only) |
| C2 | **1:1**, one side lost every device, the other side's devices are iOS or web only and never reopened | waits until the peer opens the app; **forever** if never | - | - |
| C3 | **1:1, both sides lost every device** | **forever**: each new device is `further_device`, neither is a candidate for the other's ask. Starting the DM again reuses the server group (`findActiveDirectGroupForPeer`, `groupCreation.ts:1073`) and re-enters the same recovery (`:1115`) | - | - |
| G1 | **Group conversation**, at least one member answerable | added automatically | rung 1 (commit log, ~1 year) or rung 2 with its own leaf: by itself | waits for a member's Accept; the Android background answer refuses asks (`awaiting_admission`) |
| G2 | **Group**, the only remaining holders are iOS/web devices nobody reopens | waits; **forever** if never reopened | by itself (its own leaf) | waits; the ask expires after 14 days (`expireUnansweredAsks`, `utils/group-membership.ts:766`) |
| G3 | **Group, every device of every member lost** | **forever**, for every member (each is a further device) | - | **forever** (expires after 14 days), by the owner's rule |
| G4 | **Group**, a member whose leaves were all removed but whose seat stands, nobody online | joins by itself (no leaf: not a further device); members later write an uninvited-entry line | - | - |
| B | **Any conversation, base stale or absent, no holder** (DE1/DE2) | **forever**; `stale_base` is asked to be republished (`recovery.ts:887`), `no_peer_online` is recorded against the epoch pair (`:911`) | **forever** too (rung 2 needs the base) | - |
| K1 | **Community or salon key group**, no holder online, base current | joins by itself, entitlement asked of social-service (a 503 is retried, never an acceptance) | by itself | community membership is social-service's, then the device joins by itself |
| K2 | **Key group, base stale, no holder** | **forever** (no `welcome_request` fallback for a key group; `sessionWatchdogs.ts:117-134` logs `stale_base`) | **forever** | **forever** |
| CH | **A channel (salon)** | the availability of its key group (K1/K2); its PAST also needs a seed holder (section 6) | same | same |

A returning member whose device kept its state needs nobody in every case but B and K2: rung 1
replays the commit log, and rung 2 replaces its own leaf.

## 5. What is blocked forever today

| | Case | Cause | By RFC 9420? |
| --- | --- | --- | --- |
| **F1** | A further device with no answerable member device: C2/G2 when nobody reopens, C3, G3 | the client's further-device door, plus no collector of dead leaves without a member | **No.** The server holds a current base and would accept the join |
| **F2** | Stale or absent base with no holder: B, K2 | nobody can mint a base | **Yes** (DE1 becomes DE2). Rare since 2026-10-04: only a commit from an older client leaves a base behind |
| **F3** | A new person whose link ask no member answers before it expires | the owner's rule: a new person is admitted only by a member | No, by design, and kept |

Not blocked: key groups with a current base, a user's first device in a group, a device whose own
leaf is still in the tree.

## 6. History: what is lost by design and what is kept

**1:1 and group conversations.** Messages travel inside MLS, so reading a past frame needs that
epoch's secrets, which only devices that were members then ever held, and which forward secrecy then
deletes. The server keeps a capped `history:{groupId}` stream (MAXLEN ~1000, 90-day TTL) and the
per-device queue, both MLS ciphertext that no later joiner can open
([history-reconciliation](history-reconciliation.md#constraints-measured-rather-than-assumed)).
A device that joins by external commit gets nothing from before its join and asks a member for it
(`reconcileGroup`, `recovery.ts:851-856`). So **with no live device holding the messages, the past is
gone**, except:

- the local plaintext store of any surviving device of any member, served by the history exchange;
- a `.canari` backup ([backup](../frontend/backup.md)): it restores conversations and messages,
  read-only on a different device until it is a member again. MLS state is restored only on the
  same device id (`frontend/src/lib/backup.ts:14-23`).

**Communities and channels.** Messages are AES-GCM ciphertext stored once on the server
(`channel_messages`, one-year retention). MLS carries only the 32-byte seeds. A new device of an
entitled member joins the key group by itself and receives the seed bundle from a member device
that holds the seeds (`shared`). Seeds are kept in `IStorage` on each device and in backups
([channel-encryption 4.10](channel-encryption.md#410-seeds-must-become-durable-which-they-are-not-today)).
So **with no device and no backup holding a seed, the messages of that session stay on the server
and nobody can read them**. Messages sent after a self-join are unaffected. DE6 (a seed handed over
mid-session) remains terminal by design. Not verified: whether a seed restored from a backup is then
re-shared with other members by the ordinary seed answer.

Graine plays no part in DMs. Nothing on the server can decrypt either kind of past, and that is the
design: a server that could would be the backdoor RFC 9420 has no place for.

## 7. Proposed design: a further device lets itself in when no member's device can answer

**The narrowest change that closes F1 without touching the owner's three rules.**

1. **Client door (`recovery.ts:945`).** On `further_device`, the device still asks first. If the
   server answers `stored` (its own verdict: no member device online), the device runs the external
   join in the same pass **without the further-device check and with `welcomeOwed: 'ask'`**. The seat
   served with the base (`gi.seat`, read at `BaseMlsService.ts:7016`) then shows an Android
   background Add that the same request's FCM wake may have started (`addInFlight`, `welcomeQueued`),
   and the device waits for that Welcome instead of joining over it. Any race left is decided by the
   epoch gate: one commit lands, the other is refused and rebuilt. No new timer: the trigger is the
   server's answer, the cadence is the existing `RECOVERY_TIMEOUT_MS` throttle.
2. **Observers (`deviceTrust.ts:154`, `device_trust.rs:175`, `deviceNotices.svelte.ts:776`).** A
   self-entry by a device whose user already held a leaf is announced exactly like an automatic Add:
   "X a ajoute un appareil" (`chat_system_device_added`) to members, "Nouvel appareil connecte" with
   "Ce n'est pas moi" on the owner's other devices. It is no longer written as `unvouched-device`, and
   `withholdHistoryFrom` (`frontend/src/lib/utils/chat/historyWithheld.ts:138`) is not applied to it,
   so it receives history under rule 2 of
   [history-answer-addressing](history-answer-addressing.md) like an added device.
3. **Server: unchanged.** It already accepts the commit from a seated user and binds the leaf to the
   caller. A new person stays outside: the `awaitingAdmission` 409 on the base and on every commit
   is untouched.
4. **Once in, the device is a holder.** It republishes the base on connection, adds the next further
   devices automatically (its siblings and other members'), and its stray-leaf collector removes the
   revoked leaves, its own retired id included.

Variant (a), wider: drop the door entirely and let every further device join by itself, as before
2026-10-27. Same security as below, one round trip fewer, no ask path left to race. It is the literal
reading of the 2026-10-30 decision's title ("a new device of a member enters by itself").

**Rejected:**

- **The server revoking garbage-collected devices so their leaves get collected.** That is a
  destructive control decided by a clock (90 days without a KeyPackage), and a device offline that
  long re-registers on its next connection (`devices.controller.ts:176-186`). It also still needs a
  live member to commit the Remove.
- **A server attestation that "no member could answer", checked by members.** Members cannot verify
  it, and the server is the party the check would guard against.
- **Self-entry gated on revoking the old devices**, rejected by the owner on 2026-10-30 because it
  reopens the stolen-session lock-in. This proposal revokes nothing and keeps "Ce n'est pas moi".

### The security trade-off, honestly

| What a member's automatic Add checks | Under a self-join |
| --- | --- |
| The KeyPackage's credential names the device the server listed (`key_package_verdict`, `identity-mismatch`, `frontend/mls-core/src/members.rs:467`) | The server binds the new leaf to the authenticated caller (`external_leaf_foreign`, `messaging.service.ts:2294`), and every member verifies the commit's signature. **The same trust root**: the server's authentication of the device's enrolment |
| A known device id under a different key is refused (`signature-key-changed`) | A further device is a NEW id, so it is a first sight under both doors. A re-entry under a known id is already announced as `key-changed` |
| The requester's user holds a leaf in the adder's own tree (`automaticAdmission`) | The joiner reads it off the signed GroupInfo, and every observer reads it from its own tree (`member_already_present`) |
| The seat gate and the add lock | The seat gate (`assertCommitterMayCommit`); a link ask is still refused |
| A human decides | **Nobody, in both cases**, since 2026-10-31 (the Add is automatic, even from a push) |

**What is really given up.** Today a member can tell a device that let itself in from one a member's
device added, and writes the first as an accusation (`[UNINVITED_ENTRY] kind=unvouched-device`)
while withholding history from it. That tripwire catches a **hostile delivery service** using its own
copy of the base to insert a device under a member's account with no member device involved. Under
the proposal that insertion reads like an ordinary new device.

**Why that costs almost nothing beyond the risk already accepted.** The same hostile server can
already enrol a device under a member's account and relay its `welcome_request` to any member device
(an Android phone in the background is enough), which adds it automatically, announces only "X a
ajoute un appareil", and serves it history. That is the residual risk the owner accepted on
2026-10-30, with the owner's alert as its control. The proposal removes the need for a member device
to be reachable at that moment; it does not let a server bring in a NEW PERSON, since the joiner's
user must already hold a leaf in every member's tree. Members keep detecting a new person's self-entry
(`entersUninvited`), unchanged.

**If the tripwire is kept instead**, honest recoveries in the F1 cases would each write an accusing
line and withhold history in that conversation, from every member (`historyWithheld.ts` stops
broadcast answers while any withheld device is present). That is noise the house rules do not allow,
and it lands exactly on the conversations that just survived losing every device.

**The one class the tripwire KEEPS (review of #2832): a KNOWN device id entering by its own commit
under a key other than the one known for it.** A further device is a NEW id, so its first sight is the
honest case D1 opens. A known id under a new key is not a further device's recovery: an honest
re-registration of that device is a re-add by a member or a rejoin on its own seat, and what is left
is exactly the insertion the tripwire exists for, under a name members already trust. So it still
writes the accusing line (`chat_system_unvouched_device_entry`), reports `unvouched-device`, and is
withheld history in that conversation. One predicate decides it, on both sides of the WASM boundary:
`DeviceEvent::enters_as_unvouched_device` (`frontend/mls-core/src/device_trust.rs`) and
`entersAsUnvouchedDevice` (`frontend/src/lib/mls-client/deviceTrust.ts`) answer
`trust == KeyChanged && enters_by_its_own_commit()`, and a device added by such an entry stays
unvouched with it. The shared fixture `mls-core/tests/fixtures/device_notices.json` pins the three
rows: pinned and first-sight entries are ordinary added devices, the key-changed one is unvouched.

## 8. Measurement: what the hourly report says, and what it cannot see

`reportSingleHolderGroups` (`app.controller.ts:851`, hourly since 2026-09-12) counts, per live group
with at least two members (`MIN_MEMBERS_FOR_HOLDER_REPORT`, `retention.constants.ts:250`), the
DISTINCT USERS with an `active` device row. It WARNs at one holder and ERRORs at zero, and repairs
nothing. Key groups count the users on their device rows. Last public readings
([mls-graine-state-machine](mls-graine-state-machine.md#the-report-was-read-ten-days-on-2026-09-22-and-it-says-the-lever-worked)):

| | 2026-09-12 | 2026-09-22 |
| --- | --- | --- |
| live groups | 58 | 100 |
| zero holders | 1 (not a real conversation) | 0 |
| one holder | 9, of which 5 real | 1 (two browsers of one user) |

Later counts are in the private operations notes and were not read for this page. The owner decided
on 2026-10-04 to build nothing for the one-holder case unless its count rises.

**Its blind spots, read from the query (`app.controller.ts:868-889`):**

- **`active` is not liveness.** A dead device's row stays `active` until it has published no
  KeyPackage for 90 days (`detectStaleDevices`). A conversation whose every device died last month
  reads as fully held. The house's own liveness clock is `KeyPackage.createdAt` (the comment on `detectStaleDevices`,
  `app.controller.ts:386-401`), and the report does not read it.
- **It does not see F1.** A further device waiting with a `pending` seat and no Welcome looks like any
  stranded seat to `reportStrandedDeviceMemberships`, which cannot tell the two apart. Since D1 a
  further device waits only while a member device is online to add it, so a `pending` seat with no
  Welcome is again a defect or an ask nobody answered.
- **It counts users, so it cannot see an iOS-only or web-only holder that never reopens** (G2): that
  user is a holder for the report and a dead end for the further device.

A read-only query that would measure the population F1 threatens, to run on production with
`default_transaction_read_only = on` (not run here): per live conversation, count distinct users
whose `active` device rows belong to a device with a `key_package` row created in the last 30 days,
and list the groups where that count is zero while a `pending` row created after the newest such
KeyPackage exists. Counts only, never ids
([durable-rules](../durable-rules.md#a-measurement-taken-from-production-names-roles-and-counts-never-people---this-repository-is-public)).

## 9. Decisions only the owner can take

1. **May a member's further device let itself in when the server says no member device can answer**
   (section 7), or in every case (variant a)? Today it waits for ever (F1).
2. **How is such an entry announced?** As an ordinary added device (the proposal), or as today's
   accusing line, with history withheld from it in that conversation?
3. **History for such a device**: rule 2 (its user's own windows, like an added device), or nothing
   until a member's device acts.
4. **New persons**: confirm that a link ask no member answers stays blocked and expires after 14 days
   (F3). Nothing technical can change that without breaking the rule.
5. **Stale or absent base with no holder (F2)**: confirm it stays terminal. RFC 9420 offers no entry,
   and a server-side resurrection would be a backdoor.
6. **Optional, not needed for F1**: an iOS background answer to `welcome_request_pending`, which would
   shorten the G2 waits. A hardware item.

**Corrections owed to the wiki and code comments if (1) is decided either way:** DE2 in
[mls-graine-state-machine](mls-graine-state-machine.md) and the `reportSingleHolderGroups` comment
and WARN text should say "closed while the base is stale or absent", not "nothing can reopen them".

**Done with this page (2026-10-31):** DE2 of [mls-graine-state-machine](mls-graine-state-machine.md)
and the `reportSingleHolderGroups` comment and WARN text now say "closed while the base is stale or
absent".

## Decisions taken 2026-10-31

The owner answered section 9 the same day. What each one changed in the code:

- **D1 - a further device asks first, then lets itself in when no member device can answer** (section
  7, not variant a). `requestReAdd` (`frontend/src/lib/utils/chat/recovery.ts`) runs the external join
  once with `asAFurtherDevice: 'ask'`; on `further_device` it sends the `welcome_request`, and ONLY on
  a `stored` answer it joins in the same pass with `welcomeOwed: 'ask'`. The conversation's base is
  now served with this device's seat (`GET /api/mls/group-info/:groupId?deviceId=`, `readDeviceSeat`
  in `apps/chat-delivery-service/src/utils/device-seat.ts`, read AFTER the base), so a queued Welcome
  or an Add in flight answers `welcome_owed` and is waited for. No timer was added: the trigger is the
  server's answer, the cadence the existing `RECOVERY_TIMEOUT_MS` throttle. The seat gate and the
  `awaitingAdmission` 409 are untouched.
  **One door per answer (review of #2832).** A `stored` answer used to put the ask in Redis AND wake
  members' Android phones, whose background Add then raced the self-join it had just licensed. The
  further device's ask now carries its intent (`selfJoinIfNobody: true`): with no member online and a
  CURRENT base, the server stores, queues and wakes nothing, and withdraws an ask an earlier pass
  stored (`SREM pending_welcome:{groupId}`, `LREM` of the exact frame from each member's
  `pending_welcome_notify` list) - the device's own commit is the one door. On a stale or absent base
  the device cannot let itself in, so the ask is stored and woken as any other and the member's Add is
  the one door. Were two doors still to meet (an Add a member's app started from a forwarded ask
  moments before), the strict epoch gate accepts one and the loser rebuilds - the member clears its
  staged Add, the device drops its refused join and takes the Welcome - and one leaf stands
  (`mls-core/tests/further_device_door.rs`, both orders). That is the last line, never the design.
- **D2 - announced as an ordinary added device.** `DeviceEvent::announces_new_device` is the one event
  for both doors: "X a ajoute un appareil" to members, "Nouvel appareil connecte" with "Ce n'est pas
  moi" on the owner's other devices. A further device - a new id, or one pinned by another group -
  entering by its own commit writes no accusing line and no `unvouched-device` report. A NEW PERSON's
  self-entry is still said and reported (`entersUninvited`), and so is a KNOWN id under a new key
  ([the class the tripwire keeps](#the-security-trade-off-honestly)).
- **D3 - history follows rule 2** of [history-answer-addressing](history-answer-addressing.md) for a
  further device. `historyWithheld.ts` and `withholdHistoryFrom` stay, narrowed to the key-changed
  class above.
- **D4 - a link ask nobody answers stays blocked** and expires after 14 days. Nothing changed; the
  no-holder facts are never served to an `awaitingAdmission` seat.
- **D5 - a stale or absent base with no holder stays terminal**, with no server-side resurrection. The
  conversation says so instead of waiting for ever - see below.
- **D6 - the iOS background Add is deferred.** D1 makes it unnecessary for a further device; it
  remains a hardware item for the waits of a person's own ask.

### The gate: D1 waits for D2 and D3 on every member client

A `1.5.1`-`1.5.4` member reads a further device that let itself in as an accusation and withholds
history from it - the tripwire D2/D3 narrowed. So the self-join must not open while such a client may
still be a member. **The server holds the door shut** with one constant,
`FURTHER_DEVICE_SELF_JOIN_OPEN = false` (`apps/chat-delivery-service/src/utils/device-seat.ts`):

- `GET /api/mls/group-info/:groupId?deviceId=` serves the base WITHOUT the asking device's seat, so
  the client reads `seat_unreadable` and does not join (`recovery.ts`, the D1 block);
- a `selfJoinIfNobody` ask is stored, queued and woken exactly as any other.

A constant, not an environment switch: the condition is a fact about the shipped clients, the same on
every estate, and the commit that flips it is its record. **Lifted by a one-line pull request once
`minClientVersion` is at least `1.5.5`**, the release carrying D2/D3 - the row in
[legacy-compatibility](../legacy-compatibility.md) carries it. Until then a further device in a
conversation with no member online waits, as before this page.

### D5: the banner, and what decides it

"Cette conversation ne peut plus etre ouverte sur cet appareil : aucun appareil qui la detenait n'est
revenu." (`chat_unopenable_here`), with "Recommencer avec les memes personnes" (a NEW group under the
same name, the same people invited; groups only - a 1:1 is keyed by its peer, so a second one would be
a duplicate on the other side) and "Retirer de ma liste". Removing it deletes nothing, here or on the
server: a per-account hidden list (`ACCOUNT_KEY.unopenableHidden`) hides it from the conversation list
while it is not active, so if a device that held it comes back and adds this one, it is listed again.

**The banner must never appear for a case that is still going to resolve** (a slow Welcome, an Add in
flight). So it is decided by ONE server answer's facts, never by a clock, a missing message or a
pending state (`readNoHolder`, `frontend/src/lib/utils/chat/noHolder.svelte.ts`):

1. A `no_peer_online` answer - to a `welcome_request` or a base-refresh request - carries `facts`: the
   stored base's `baseEpoch` and the group's `activeEpoch` (or `base: null`), and the asking device's
   seat (`welcomeQueued`, `addInFlight`), read by the server in that same request
   (`noHolderFacts`, `messaging.service.ts`). A forwarded answer carries none.
2. **The base first.** A current base reads `base-usable`: D1 lets the device in, so the banner branch
   is reachable only once the base fact has ruled the self-join out.
3. **Then the seat.** A queued Welcome or an Add in flight reads `welcome-owed`; an unread add lock or an
   `active` seat reads `unknown`.
4. **Then the holders (review of #2832).** A group merely SLOW is not a dead one. The answer also
   carries `holders`: `liveHolderDevices`, the count of OTHER users' devices with an `active` row in the
   group AND a KeyPackage published within `RETENTION_WINDOW_MS` (90 days - the window the server
   already uses to call a device gone, `detectStaleDevices`), and `wakeSent`, whether this very request
   woke member phones. Anything but `0` and `false` reads `unknown`: a member who did not open the app
   tonight is still a holder.
5. Only what is left is `no-holder`.

Anything unknown - not asked yet, offline, a transport error, an older server sending no facts, a
malformed answer, one without `holders` - keeps today's waiting text. Every answer replaces the
reading, so a member device coming online (a forwarded answer), a republished base, or a Welcome
landing (`cancelReAdd`, and the conversation turning `active`) takes the banner down **at the next
recovery pass that reads it** - the next answer on the recovery cadence, or the Welcome's own
`cancelReAdd` - not at the instant the fact changes on the server. The reading is session memory: a
restart starts from unknown and asks again.

**The hidden list is released the first time the conversation is seen active** (`releaseHiddenOnceActive`,
from `cancelReAdd` and from the list for every active row), so "Retirer de ma liste" can never hide a
conversation that opened and later went pending again. It keeps at most `HIDDEN_UNOPENABLE_CAP` (200)
ids, oldest dropped first. "Recommencer" runs one at a time (a second tap while it creates is ignored)
and says it failed with a toast (`chat_unopenable_start_again_failed`) rather than doing nothing. Tests: `noHolder.svelte.test.ts`, the D5 block of
`recovery.test.ts`, `messaging.no-holder-facts.spec.ts`, `useConversations.startAgain.svelte.test.ts`.

### How rare D5 is, read from the code (no production query)

A base falls behind only through a commit that did not carry the base it creates. Since 2026-10-04
every commit carries `newBase`, stored by `validateCommit` in the transaction that advances the epoch,
the Android background Add included, and `minClientVersion` is now `1.5.1`, so no client that may still
commit omits it. A key group's base is the community's, outside this page. What can still be behind,
or absent:

- a conversation whose last commit came from a pre-2026-10-04 client and that has not committed since
  (any commit by a current member republishes);
- a conversation whose base was never published (created by an old client and never committed since);
- a holder that republishes on connection (`initializeConnection`) ends either case, so what remains
  is the subset of the above whose every holder is gone for good.

So D5 is a legacy population that can only shrink: no current client can add to it. Its size on
production was not read for this page; the read-only count is section 8's query, restricted to groups
whose base is absent or behind.
