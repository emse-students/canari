# MLS recovery ladder

This document describes how the **client** recovers from MLS and delivery-queue issues, and where to look when debugging.

**See also:** [MLS_DESYNC_PREVENTION.md](./MLS_DESYNC_PREVENTION.md) - tactics that _prevent_ client/server state drift before recovery runs.

## Ordered recovery steps

1. **Queue processing** - Pending encrypted payloads are fetched (`fetchMessages`), decrypted in WASM, then **acked** only when policy allows (see below). If decryption fails or the handler returns `false`, the message may stay queued for retry.

2. **Welcome / commit distinction** - **Welcomes** are only acked after successful processing. **Commits** are acked on success or on certain errors (web vs Tauri rules differ slightly; shared rules live in `frontend/src/lib/services/mlsQueueAckPolicy.ts`).

3. **Epoch alignment** - On **Tauri**, epoch is cached in `_epochByGroupId` and refreshed via `refreshEpochCache()` after each successful queue item (including persisted **`group_reset`** rows), after `processWelcome`, and when sending commits (`sendCommit` also seeds the cache from `obtenir_epoch`). **`getEpoch()`** reads the cache; **`forgetGroup`** clears it. On **Web**, `getEpoch()` reads the WASM client directly-no separate cache.

4. **Stale / kick flows** - Server metadata (`DeviceGroupMembership`: `pending`, `welcome_sent`, `welcome_received`, `stale`) must match MLS reality. After remove commits, the client calls **`POST /api/mls/kick-stale-device`** (single device; used by `kickStaleDevice()` in MLS services) or **`POST /api/mls/kick-stale-user`** (all devices of a user). **`POST /api/mls/groups/:groupId/reset-epoch`** resets server `activeEpoch` during re-bootstrap. These routes use **`HeaderAuthGuard`** like the rest of `/api/mls/*`.

5. **Last resort** - Full resync / re-login / clearing local MLS state is outside normal operation; prefer fixing the specific gap (queue item, epoch, membership row) first.

## Verification (tests + runtime)

| Step                                                 | What must hold                                                                                                                                    | How we check                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Queue ACK rules                                      | Success acks only with `queuedMessageId` and `cbResult !== false`; Web exceptions ack commits only; Tauri welcomes / GAP / UNRECOVERABLE skip ack | `mlsQueueAckPolicy.test.ts`, `recoveryLadder.contract.test.ts`                              |
| Epoch (Tauri)                                        | After queue success (incl. persisted `group_reset`), welcome, and `sendCommit`, cache reflects `obtenir_epoch`                                    | Code: `refreshEpochCache` after `group_reset` and on success path; `sendCommit` seeds cache |
| Metrics                                              | `logMlsMetric` is a no-op unless dev or `canari_mls_debug`                                                                                        | `mlsRecoveryMetrics.test.ts`                                                                |
| Kick / reset API                                     | Authenticated clients only                                                                                                                        | `HeaderAuthGuard` on `kick-stale-device`, `kick-stale-user`, `reset-epoch`                  |
| Desync prevention (shared `baseEpoch`, server locks) | Covered in companion doc                                                                                                                          | [MLS_DESYNC_PREVENTION.md](./MLS_DESYNC_PREVENTION.md), `desyncPrevention.contract.test.ts` |

## Backend identity binding

Routes that take a **user id** in the path or body are checked against the **`x-user-id`** header set by the edge proxy after auth, except where another user's id is **intentionally** required (e.g. **`getUserDevices`** to fetch another user's key packages for invitations). **Global admins** bypass the path/body user-id match via **`x-global-admin: true`**.

## Observability

- **Metrics** - `logMlsMetric()` in `mlsRecoveryMetrics.ts` records recovery-related events. Extra console detail appears **only** in dev builds **or** when `localStorage['canari_mls_debug'] === '1'`.

- **Policy tests** - `mlsQueueAckPolicy.test.ts` and `recoveryLadder.contract.test.ts`; `mlsRecoveryMetrics.test.ts` for debug logging. Run `npm run test` in `frontend` (Vitest) after changing queue behavior.

## Related sources

- Nginx routing: `infrastructure/local/Dockerfile.frontend` (`/api/mls/*` → chat-delivery).
- Full MLS API surface: `apps/chat-delivery-service/src/app.controller.ts`.
