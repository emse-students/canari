# MLS recovery ladder

This document describes how the **client** recovers from MLS and delivery-queue issues, and where to look when debugging.

## Ordered recovery steps

1. **Queue processing** — Pending encrypted payloads are fetched (`fetchMessages`), decrypted in WASM, then **acked** only when policy allows (see below). If decryption fails or the handler returns `false`, the message may stay queued for retry.

2. **Welcome / commit distinction** — **Welcomes** are only acked after successful processing. **Commits** are acked on success or on certain errors (web vs Tauri rules differ slightly; shared rules live in `frontend/src/lib/services/mlsQueueAckPolicy.ts`).

3. **Epoch alignment** — On **Tauri**, epoch is tracked in `_epochByGroupId` and refreshed after commits, welcomes, and sends. If something feels “one epoch behind,” check that `refreshEpochCache()` / `getEpoch()` paths ran for that group.

4. **Stale / kick flows** — Server metadata (`DeviceGroupMembership`: `pending`, `welcome_sent`, `welcome_received`, `stale`) must match MLS reality. After remove commits, **`kick-stale-user`** and **`resetGroupEpoch`**-style flows realign server + clients; callers must remain authenticated (same patterns as other MLS API routes).

5. **Last resort** — Full resync / re-login / clearing local MLS state is outside normal operation; prefer fixing the specific gap (queue item, epoch, membership row) first.

## Backend identity binding

Routes that take a **user id** in the path or body are checked against the **`x-user-id`** header set by the edge proxy after auth, except where another user’s id is **intentionally** required (e.g. **`getUserDevices`** to fetch another user’s key packages for invitations). **Global admins** bypass the path/body user-id match via **`x-global-admin: true`**.

## Observability

- **Metrics** — `logMlsMetric()` in `mlsRecoveryMetrics.ts` records recovery-related events. Extra console detail appears **only** in dev builds **or** when `localStorage['canari_mls_debug'] === '1'`.

- **Policy tests** — `mlsQueueAckPolicy.test.ts` covers ack rules; run `npm run test` in `frontend` (Vitest) after changing queue behavior.

## Related sources

- Nginx routing: `infrastructure/local/Dockerfile.frontend` (`/api/mls-api/*` → chat-delivery).
- Full MLS API surface: `apps/chat-delivery-service/src/app.controller.ts`.
