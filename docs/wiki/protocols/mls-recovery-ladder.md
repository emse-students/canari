# MLS recovery ladder

This document describes how the **client** recovers from MLS and delivery-queue issues, and where to look when debugging.

**See also:** [`mls-desync-prevention.md`](mls-desync-prevention.md) — tactics that _prevent_ client/server state drift before recovery runs.

## Ordered recovery steps

1. **Queue processing** — Pending encrypted payloads are fetched (`fetchMessages`), decrypted in WASM, then **acked** only when policy allows (see below). If decryption fails or the handler returns `false`, the message may stay queued for retry.

2. **Welcome / commit distinction** — **Welcomes** are only acked after successful processing. **Commits** are acked on success or on certain errors (web vs Tauri rules differ slightly; shared rules live in `frontend/src/lib/services/mlsQueueAckPolicy.ts`).

3. **Epoch alignment** — On **Tauri**, epoch is cached in `_epochByGroupId` and refreshed via `refreshEpochCache()` after each successful queue item (including persisted **`group_reset`** rows), after `processWelcome`, and when sending commits (`sendCommit` also seeds the cache from `obtenir_epoch`). **`getEpoch()`** reads the cache; **`forgetGroup`** clears it. On **Web**, `getEpoch()` reads the WASM client directly — no separate cache.

4. **Epoch gap recovery (rung 1 → rung 2)** — When an incoming frame is at a higher epoch than the local group (`msg_epoch > group_epoch`), the device is behind. **Rung 1 (non-destructive)**: it fetches the ordered commits it missed from the server commit-log (**`GET /api/mls/commits/:groupId?sinceEpoch=N`**) and re-applies them via `processIncomingMessage` (`attemptCommitReplay` in `commitReplay.ts`), catching its epoch up with **no state loss and no re-Welcome**. **Rung 2 (destructive, fallback)**: `forgetGroup` + recover the state anew — reached two ways, and they are not the same claim. **The server said NEVER**: rung 1 came back with a pruned floor (`belowFloor`) or a NAMED HOLE (`gapAt`), which is a proof that no later attempt can produce the missing commits, so the escalation is immediate. **The attempt merely FAILED**: a commit would not apply, the request errored — the next frame may well succeed, so this keeps `EPOCH_GAP_ESCALATION_MS` rather than destroying local state on one bad answer. The commit-log is written atomically with the epoch advance in `validateCommit`: **`POST /api/mls/commit`** now carries the commit bytes and does validate + store + fan-out in one call. Retention is long (~1 year) so rung 1 covers almost every gap.

   **A HOLE IN THE COMMIT LOG WAS SURVIVED BY A CLOCK, AND THAT COST TWELVE MESSAGES.** `belowFloor`
   described the START of the requested range only, so a device at epoch 120 fetching a log that ran
   `[120, 122, 123, …]` applied 120, threw on 122, reported `healed=false` and sat frozen for the
   full `EPOCH_GAP_ESCALATION_MS` — with every frame arriving in those 30 s ACKed and dropped. The
   server held the answer in the response it was already writing. `getCommitsSince` now walks for
   contiguity and names the first epoch it cannot supply as **`gapAt`**, `attemptCommitReplay` treats
   that as terminating and applies none of the unreachable tail, and the handler escalates on the
   proof. Measured on prod 2026-09-02: DM `7da231f8` ran 0..129 with **121 absent** for two days,
   which is a hole nothing can ever fill — `(groupId, baseEpoch)` is UNIQUE — and every check on the
   campaign board passed throughout. The cause of the hole is on
   [`mls-desync-prevention.md`](mls-desync-prevention.md) §1.

   **THE LADDER HAS TWO ENTRANCES, AND UNTIL 2026-08-29 IT HAD ONE.** Everything above is the READ
   side: a frame arrives, it cannot be decrypted, the device learns it is behind. The WRITE side
   learns the same fact from a different place — `POST /api/mls/commit` refuses a staged commit with
   `epoch_mismatch` and answers with its own `activeEpoch` — and that fact reached no rung at all.
   The refusal is documented as retryable, and the retry is correct *provided the commit we missed
   arrives on its own*, which is what happens in the case it was written for: two devices commit at
   once, the loser is refused, the winner's commit reaches it through the fan-out, the retry lands.
   **Nothing established that premise.** On a conversation whose only remaining traffic was the
   refused commits themselves, no frame ever arrived, so no rung ever ran and the same commit was
   refused for ever — measured on production at 191 and 172 refusals in twenty-four hours, on two
   conversations that were stuck for good. A device in that state is also the only one that can admit
   anyone, so every peer asking to be re-added was stranded behind it, and their outboxes stayed
   frozen (`isInEpochGap`) — which is what the "messages en attente" nudge was reporting.
   `runCommitTransaction` now calls `catchUpOnRefusedCommit` before it throws: the epochs decide (a
   refusal that reports no server epoch ahead of ours is not a gap and touches nothing), rung 1
   replays under the same MLS lock the read side holds, and a gap it cannot close is left in the
   epoch-gap registry for the sync watchdog to escalate. **No rung, no cadence and no escalation was
   added** — the two rungs, their order and their single owner are unchanged.

   **WHICH RUNG ACTUALLY SERVES THIS, MEASURED: rung 2, always.** Both production groups healed within
   two minutes of the deploy, and rung 1 could not help either of them. It fetched the single commit
   each device was missing and OpenMLS refused to re-apply it (`same-epoch refusal`), because that
   commit was the device's OWN — the server accepted it and the local merge never happened, the
   crash-before-merge gap `runCommitTransaction` documents one comment above the submission. That is
   the shape a write-side refusal has by construction: a device refused at `baseEpoch` while the
   server sits at `baseEpoch + 1` is usually the author of the commit that made the difference. Rung 1
   still runs first, because nothing available at the refusal distinguishes it from a peer's commit we
   merely missed, and it is non-destructive when it is wrong. What the log then says is the
   difference: `replayed 0 commit(s) … healed=false` followed by `still behind after rung 1`.

   **Rung 2 recovery is self-service first.** The re-add seam `requestReAdd` tries **`externalJoin`** before any peer Welcome: it fetches the latest GroupInfo (**`GET /api/mls/group-info/:groupId`**, membership-gated), builds a native openmls external commit, and submits it under the standard epoch gate (**`POST /api/mls/commit`** at the GroupInfo's base epoch; on an epoch race it discards the group and retries with a fresher GroupInfo — no peer liveness required). The committer refreshes the stored GroupInfo after every accepted commit (**`POST /api/mls/group-info/:groupId`**, monotonic). Only when no GroupInfo is available does it fall back to a `welcome_request` (a reachable member re-adds us via a Welcome). The reboot/CAS/successor machinery was fully retired — external join is the self-service recovery; welcome_request is the thin fallback.

   **A joiner publishes the base its OWN commit created, inside the submission (2026-08-26).** An
   external commit advances the group by one epoch, so the base the joiner built on is stale the
   instant its commit is accepted — and until this change the new one was minted by a SECOND
   round-trip (`refreshGroupInfo`) made after the join returned. An external joiner reloads by
   construction, so that call was the one certain to be lost, and nothing else ever mints a base: the
   published one then trailed `activeEpoch` for good, the strict gate refused every later external
   commit, and a distribution group has no peer-Welcome fallback to take instead. COMM-22 measured it
   on production. Because an external commit is applied to the returned instance at once (unlike a
   staged add/remove), the joiner can `export_group_info` at `base + 1` before merging; that blob
   travels in **`POST /api/mls/commit`** as `groupInfo`, and `validateCommit` writes it with the epoch
   advance in one transaction. The client refuses to publish unless its instance is exactly at
   `base + 1` and abandons the join otherwise — a monotonic base stored under the wrong epoch cannot
   be walked back. **Ordinary staged commits still mint their base by follow-up**: their commit is
   unapplied at submit time, so the device is still at the old epoch and has nothing to export; see
   [backlog](../backlog.md) for the openmls bundle GroupInfo that would close that half too.

   **A refused GroupInfo read ENDS the ladder; it does not descend it.** "Or the device is not an authorized member" used to be in the sentence above, and it was a defect: the endpoint is gated on a `dm_group_members` row, so its **403 is the roster answering** that we hold no membership — which no retry and no peer can change. It now arrives as `NotAGroupMemberError`, thrown by `fetchGroupInfo`, propagated by `externalJoin`, and terminates the recovery through the same seam as a server-side tombstone (`stopRecovering`: cancel, `clearGroupNotReady`, retire the conversation). Until then it was flattened to `null`, read as *no base published yet*, and fell to the fallback — so a group we had LEFT was chased once a minute for as long as it existed, one 403 and one broadcast per pass, contained only by the `RECOVERY_TIMEOUT_MS` throttle. Any OTHER failure (a 5xx, a transport error) says nothing about membership and must still descend to the fallback, or a bad deploy retires live conversations.

5. **Stale / kick flows** — Server metadata (`DeviceGroupMembership`: `pending`, `welcome_sent`, `welcome_received`, `stale`) must match MLS reality. After remove commits, the client calls **`POST /api/mls/kick-stale-device`** (single device; used by `kickStaleDevice()` in MLS services) or **`POST /api/mls/kick-stale-user`** (all devices of a user).

6. **Last resort** — Full resync / re-login / clearing local MLS state is outside normal operation; prefer fixing the specific gap (queue item, epoch, membership row) first.

## The external-join base, and who repairs it when it falls behind

The base is a self-contained `GroupInfo` stored by the delivery service. It is the whole of what
lets a device with **no local MLS state** re-enter a group without asking anybody - rung 4,
`externalJoin` - and the commit gate accepts `baseEpoch == activeEpoch` and nothing else.

**Only a member holding the tree can mint one, and it is minted as a follow-up.** `runCommitTransaction`
ends with `void this.refreshGroupInfo(groupId)`: off the critical path, deliberately, because a
commit that the server accepted must not be reported as failed just because a follow-up did not
land. The cost was documented in that comment for months and was exactly as stated - lose the
follow-up and the group's epoch has advanced while the published base has not, **permanently**,
because nothing else ever mints one.

**Measured on production 2026-09-04**, and the shape of the number is the diagnosis:

| Groups with a base | Stale | Gap | Oldest | Devices `pending` on a stale one |
| --- | --- | --- | --- | --- |
| 43 | **4** | **exactly 1 epoch, all four** | 2026-08-30 | 3 |

A uniform gap of one is one lost follow-up per group, not drift. Three of the four are
CONVERSATIONS, and the only repair that existed (`republishStaleBase`) ran for distribution groups.

**The repair, and why it is where it is.** `GET /mls/users/:userId/groups` is the one call every
device makes on every connection, and it now carries `activeEpoch` and `baseEpoch`. A device holding
the current tree republishes when they disagree - `republishBaseIfStale` in
`frontend/src/lib/utils/chat/staleBase.ts`, the single implementation, which the Graine repair
delegates to and decorates with its own `[GRAINE]` label.

Four properties, each a house rule rather than a preference:

1. **The durable state is the server's two columns**, and there is no second copy. A client-side
   owed-work queue (the `pendingGroupExits` shape) would duplicate a fact another member may already
   have fixed, and durable state answers only the question it was written for.
2. **The trigger is an event that already happens** - a connection - not a clock. Nothing polls, and
   a device that never connects owes nothing.
3. **Termination is a proof**: `baseEpoch == activeEpoch`. Never an attempt count or a deadline. A
   failed republish leaves the group exactly as stale, and the next holder's connection tries again.
4. **Idempotence is free**: the server's publish is monotonic, so two holders repairing at once, or
   one repairing twice, cannot make the base worse.

A holder whose OWN tree is behind cannot mint a usable base either. That is a distinct verdict and it
is logged, because a run in which every holder is behind is a group nobody can repair.

**The immediate arm is separate and is not a duplicate.** A device refused with `stale_base` right
now asks one online member to republish (`base_refresh_request`, `notifyBaseRefreshRequest`) instead
of falling into the shared `welcome_request` fallback - which asks for a Welcome, a tree MUTATION
that takes the group's add lock and replays the duplicate-leaf race, to obtain something the
requester did not need. The connect-time repair heals the steady state with nobody asking; this one
serves the party that is locked out. Neither is a retry: the requester re-asks on its own cadence and
each ask is forwarded to a randomly re-elected member.

## Verification (tests + runtime)

| Step | What must hold | How we check |
|---|---|---|
| Queue ACK rules | Success acks only with `queuedMessageId` and `cbResult !== false`; Web exceptions ack commits only; Tauri welcomes / GAP / UNRECOVERABLE skip ack | `mlsQueueAckPolicy.test.ts` |
| Epoch (Tauri) | After queue success (incl. persisted `group_reset`), welcome, and `sendCommit`, cache reflects `obtenir_epoch` | Code: `refreshEpochCache` after `group_reset` and on success path; `sendCommit` seeds cache |
| Metrics | `logMlsMetric` is a no-op unless dev or `canari_mls_debug` | `mlsRecoveryMetrics.test.ts` |
| Epoch gap replay (rung 1) | Missed commits are fetched + re-applied before any destructive rung-2 forget; `belowFloor` falls to rung 2 | `commitReplay.test.ts`, `setupMessageHandler.test.ts`, `messaging.commit-log.spec.ts` |
| A terminating rung 1 escalates at ONCE | `belowFloor` / `gapAt` forget + re-Welcome on the first frame, no timer advanced; a replay that merely failed still waits out the threshold | `setupMessageHandler.test.ts`, `commitReplay.test.ts` |
| The log's holes are named by the server | Contiguity walk truncates the reply and reports `gapAt`; a pruned log reports `belowFloor` and no gap | `messaging.commit-log.spec.ts` |
| The write side enters the ladder too | A commit refused with a server epoch ahead of ours replays the missed commits before the refusal is thrown; one it cannot close stays in the epoch-gap registry for rung 2; a refusal reporting no such epoch, and an accepted commit, enter nothing | `BaseMlsService.refusedCommit.test.ts` |
| External-join self-recovery (rung 2) | `requestReAdd` tries `externalJoin` first; welcome_request only as fallback; GroupInfo store is membership-gated + monotonic | `external_join.rs`, `BaseMlsService.externalJoin.test.ts`, `messaging.group-info.spec.ts`, `recovery.test.ts` |
| A join never leaves the base behind | The joiner exports at `base + 1` before merging, the blob travels in the commit submission, and the server stores it in the same transaction as the advance; a wrong-epoch instance abandons the join | `external_join.rs` (`a_joiner_exports_the_base_its_own_commit_created_before_merging`), `BaseMlsService.externalJoin.test.ts`, `messaging.commit-log.spec.ts` |
| A refused GroupInfo read terminates the ladder | 403 is typed at the throw, survives `externalJoin`, retires the conversation; 401/404/5xx and a `200`-with-`null` stay retryable | `mlsDeliveryApi.groupStatus.test.ts`, `BaseMlsService.externalJoin.test.ts`, `recovery.test.ts` |
| Kick API | Authenticated clients only | `HeaderAuthGuard` on `kick-stale-device`, `kick-stale-user` |

## Backend identity binding

Routes that take a **user id** in the path or body are checked against the **`x-user-id`** header set by the edge proxy after auth, except where another user's id is **intentionally** required (e.g. **`getUserDevices`** to fetch another user's key packages for invitations). **Global admins** bypass the path/body user-id match via **`x-global-admin: true`**.

## Observability

- **Metrics** — `logMlsMetric()` in `mlsRecoveryMetrics.ts` records recovery-related events. Extra console detail appears **only** in dev builds **or** when `localStorage['canari_mls_debug'] === '1'`.
- **Policy tests** — `mlsQueueAckPolicy.test.ts`; `mlsRecoveryMetrics.test.ts` for debug logging. Run `bun run test` in `frontend` (Vitest) after changing queue behavior.

## Related sources

- Nginx routing: [`infrastructure/local/Dockerfile.frontend`](../../../infrastructure/local/Dockerfile.frontend) (`/api/mls/*` → chat-delivery).
- Full MLS API surface: [`apps/chat-delivery-service/src/app.controller.ts`](../../../apps/chat-delivery-service/src/app.controller.ts).

## See also

- [`mls-desync-prevention.md`](mls-desync-prevention.md) — Prevention tactics to avoid entering recovery
- [`mls-protocol.md`](mls-protocol.md) — MLS protocol overview, invariants, data model
- [`services/chat-delivery.md`](../services/chat-delivery.md) — Backend commit-log and GroupInfo endpoints
