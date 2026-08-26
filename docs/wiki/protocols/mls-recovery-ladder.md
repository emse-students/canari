# MLS recovery ladder

This document describes how the **client** recovers from MLS and delivery-queue issues, and where to look when debugging.

**See also:** [`mls-desync-prevention.md`](mls-desync-prevention.md) — tactics that _prevent_ client/server state drift before recovery runs.

## Ordered recovery steps

1. **Queue processing** — Pending encrypted payloads are fetched (`fetchMessages`), decrypted in WASM, then **acked** only when policy allows (see below). If decryption fails or the handler returns `false`, the message may stay queued for retry.

2. **Welcome / commit distinction** — **Welcomes** are only acked after successful processing. **Commits** are acked on success or on certain errors (web vs Tauri rules differ slightly; shared rules live in `frontend/src/lib/services/mlsQueueAckPolicy.ts`).

3. **Epoch alignment** — On **Tauri**, epoch is cached in `_epochByGroupId` and refreshed via `refreshEpochCache()` after each successful queue item (including persisted **`group_reset`** rows), after `processWelcome`, and when sending commits (`sendCommit` also seeds the cache from `obtenir_epoch`). **`getEpoch()`** reads the cache; **`forgetGroup`** clears it. On **Web**, `getEpoch()` reads the WASM client directly — no separate cache.

4. **Epoch gap recovery (rung 1 → rung 2)** — When an incoming frame is at a higher epoch than the local group (`msg_epoch > group_epoch`), the device is behind. **Rung 1 (non-destructive)**: it fetches the ordered commits it missed from the server commit-log (**`GET /api/mls/commits/:groupId?sinceEpoch=N`**) and re-applies them via `processIncomingMessage` (`attemptCommitReplay` in `commitReplay.ts`), catching its epoch up with **no state loss and no re-Welcome**. **Rung 2 (destructive, fallback)**: only if the commits were pruned below the retained floor (`belowFloor`) or one fails to apply, AND the gap persists past `EPOCH_GAP_ESCALATION_MS`, does it `forgetGroup` + recover its state anew. The commit-log is written atomically with the epoch advance in `validateCommit`: **`POST /api/mls/commit`** now carries the commit bytes and does validate + store + fan-out in one call. Retention is long (~1 year) so rung 1 covers almost every gap.

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

## Verification (tests + runtime)

| Step | What must hold | How we check |
|---|---|---|
| Queue ACK rules | Success acks only with `queuedMessageId` and `cbResult !== false`; Web exceptions ack commits only; Tauri welcomes / GAP / UNRECOVERABLE skip ack | `mlsQueueAckPolicy.test.ts` |
| Epoch (Tauri) | After queue success (incl. persisted `group_reset`), welcome, and `sendCommit`, cache reflects `obtenir_epoch` | Code: `refreshEpochCache` after `group_reset` and on success path; `sendCommit` seeds cache |
| Metrics | `logMlsMetric` is a no-op unless dev or `canari_mls_debug` | `mlsRecoveryMetrics.test.ts` |
| Epoch gap replay (rung 1) | Missed commits are fetched + re-applied before any destructive rung-2 forget; `belowFloor` falls to rung 2 | `commitReplay.test.ts`, `setupMessageHandler.test.ts`, `messaging.commit-log.spec.ts` |
| External-join self-recovery (rung 2) | `requestReAdd` tries `externalJoin` first; welcome_request only as fallback; GroupInfo store is membership-gated + monotonic | `external_join.rs`, `BaseMlsService.externalJoin.test.ts`, `messaging.group-info.spec.ts`, `recovery.test.ts` |
| A join never leaves the base behind | The joiner exports at `base + 1` before merging, the blob travels in the commit submission, and the server stores it in the same transaction as the advance; a wrong-epoch instance abandons the join | `external_join.rs` (`a_joiner_exports_the_base_its_own_commit_created_before_merging`), `BaseMlsService.externalJoin.test.ts`, `messaging.commit-log.spec.ts` |
| A refused GroupInfo read terminates the ladder | 403 is typed at the throw, survives `externalJoin`, retires the conversation; 401/404/5xx and a `200`-with-`null` stay retryable | `mlsDeliveryApi.groupStatus.test.ts`, `BaseMlsService.externalJoin.test.ts`, `recovery.test.ts` |
| Kick API | Authenticated clients only | `HeaderAuthGuard` on `kick-stale-device`, `kick-stale-user` |

## Backend identity binding

Routes that take a **user id** in the path or body are checked against the **`x-user-id`** header set by the edge proxy after auth, except where another user's id is **intentionally** required (e.g. **`getUserDevices`** to fetch another user's key packages for invitations). **Global admins** bypass the path/body user-id match via **`x-global-admin: true`**.

## Observability

- **Metrics** — `logMlsMetric()` in `mlsRecoveryMetrics.ts` records recovery-related events. Extra console detail appears **only** in dev builds **or** when `localStorage['canari_mls_debug'] === '1'`.
- **Policy tests** — `mlsQueueAckPolicy.test.ts`; `mlsRecoveryMetrics.test.ts` for debug logging. Run `npm run test` in `frontend` (Vitest) after changing queue behavior.

## Related sources

- Nginx routing: [`infrastructure/local/Dockerfile.frontend`](../../../infrastructure/local/Dockerfile.frontend) (`/api/mls/*` → chat-delivery).
- Full MLS API surface: [`apps/chat-delivery-service/src/app.controller.ts`](../../../apps/chat-delivery-service/src/app.controller.ts).

## See also

- [`mls-desync-prevention.md`](mls-desync-prevention.md) — Prevention tactics to avoid entering recovery
- [`mls-protocol.md`](mls-protocol.md) — MLS protocol overview, invariants, data model
- [`services/chat-delivery.md`](../services/chat-delivery.md) — Backend commit-log and GroupInfo endpoints
