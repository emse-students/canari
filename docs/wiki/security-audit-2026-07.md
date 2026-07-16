# Security / Reliability Audit - 2026-07

Read-only static audit of Canari (frontend SvelteKit + Rust WASM MLS, backend NestJS
microservices behind nginx). This file is the canonical remediation tracker: each finding
has an ID, a concrete exploit scenario, the affected file(s), and a status. Update the
status column as fixes land. CLAUDE.md references this file for the fix campaign.

## Threat model recap (why these matter)

- nginx `auth_request` **always returns 200** (`core-service` verify endpoint never blocks);
  real per-route enforcement is by NestJS guards. A route on a client-exposed prefix
  (`/api/associations`, `/api/mls`, `/api/media`, `/api/users`) with **no guard / no
  ownership check** is reachable and abusable by any authenticated user, spoofing
  `x-user-id` where the header is not re-derived server-side.
- MLS confidentiality relies on `dm_group_members` being an honest "who was legitimately
  invited" list. Every server-side MLS gate (group-info, commits-since, welcome/history
  re-add, both foreground and background push paths) trusts this table. If any user can
  write it, E2EE collapses.

## Findings (severity desc)

| ID | Sev | Title | Status |
|----|-----|-------|--------|
| S1 | CRITICAL | Self-join any MLS group via unauth `addGroupMember` | FIXED (cf8..) |
| S2 | CRITICAL | Identity spoof via unbound `register-device` | FIXED |
| S3 | CRITICAL | Payment bypass / entitlement grant via unguarded "internal" association routes | TODO |
| S4 | HIGH | Arbitrary device deletion/manipulation (no ownership) | TODO |
| S5 | HIGH | Arbitrary group member removal + roster enumeration | TODO |
| S6 | MEDIUM | Arbitrary media blob deletion (IDOR) | TODO |
| S7 | MEDIUM | nginx does not reset identity headers on unauth locations | TODO |
| S8 | MEDIUM | welcome/history-request trust body `requesterUserId` | TODO |
| B1 | LOW/BUG | users `search` reads never-populated `req.user`; route unguarded | TODO |
| S9 | INFO | `canari_ws_token` access token JS-readable (accepted tradeoff) | ACCEPTED |
| S10 | INFO | Document vault is server-custody, not E2E (document as such) | ACCEPTED |

### S1 - CRITICAL - Self-join any MLS group (E2EE bypass)
`POST /api/mls/groups/:groupId/members` - `apps/chat-delivery-service/src/controllers/members.controller.ts:170`
(`addGroupMember`). Only `HeaderAuthGuard` (authenticated). No check that the caller is
already an authorized member/admin of the group. Any user inserts a `dm_group_members` row
for themselves in any group; then `GET /api/mls/group-info/:groupId`
(`messaging.service.ts:928`) passes its membership gate and returns the GroupInfo (public
ratchet tree); the attacker forges an external-join commit and reads plaintext at the
current epoch. No online peer required. Also lets an excluded member rejoin.
Fix: require caller to be an existing authorized member/admin of the group; group-creation
first-add must still work (creator adds self).
FIXED: `assertCallerMayMutateMembership` in `members.controller.ts` gates `addGroupMember` on
`x-user-id` (HMAC-bound by HeaderAuthGuard) being a global admin, an existing member, or the
creator bootstrapping an empty group (caller==target, 0 members). The inviter registers an
invitee BEFORE sending the Welcome, so a freshly-Welcomed joiner is already a member when its
redundant self-registration runs; only the rare inviter-registration-lost edge loses that
safety net (reliability, not security). Legacy no-op when `x-user-id` absent.

### S2 - CRITICAL - Identity spoof via unbound register-device
`POST /api/mls/register-device` - `apps/chat-delivery-service/src/controllers/devices.controller.ts:108`.
Takes `userId` from the body, never compared to `x-user-id`; KeyPackage credential not
validated against caller identity. Attacker registers a device (own private key) under a
victim's `userId`; the handler auto-creates pending `DeviceGroupMembership` for every group
the victim is in (`devices.controller.ts:176-201`), so other members' clients send a Welcome
to the fake "victim device" -> attacker joins all the victim's groups in cleartext.
Fix: reject `body.userId !== caller` (or drop body.userId, use header); validate credential.
FIXED: `registerDevice` and `registerDevicePrekeys` now call
`assertCallerOwnsUserId(x-user-id, x-global-admin, body.userId)` - a device can only register
under its own account (admins exempt; legacy no-op when `x-user-id` absent). KeyPackage
credential cryptographic validation is NOT added here (would need WASM-side parsing); the
identity binding closes the practical escalation.

### S3 - CRITICAL - Payment bypass via unguarded internal association routes
`apps/social-service/src/associations/associations.controller.ts:1152-1178`:
`POST products/:productId/purchase-completed`, `POST :id/stripe-account`,
`POST :id/stripe-complete`. No `@UseGuards`, no `X-Internal-Secret` check, yet on the
nginx-exposed `/api/associations` prefix. Attacker posts `purchase-completed`
`{userId:self, amountCents:0, paymentIntentId:random}` -> gets the cotisation/product tag
without paying; idempotence keys only on client-supplied `paymentIntentId`
(`products.service.ts:729`). `stripe-account` lets an attacker set an arbitrary Connect
account on an asso (payout hijack / payment DoS).
Fix: verify `X-Internal-Secret` (timing-safe, like `internal.controller.ts`) and have the
core-service callers send it. Confirm each caller and the Stripe webhook path.

### S4 - HIGH - Arbitrary device deletion/manipulation
`apps/chat-delivery-service/src/controllers/devices.controller.ts`: `DELETE :userId/:deviceId`
(:423), `DELETE .../prekeys` (:351), `PATCH .../metadata` (:239) - no ownership binding
(controller doesn't even import `assertCallerOwnsUserId`). Any user purges a victim's
KeyPackages/memberships/queued messages/push token and denylists re-registration -> victim
ejected from all conversations.
Fix: `assertCallerOwnsUserId(x-user-id, x-global-admin, targetUserId)` on all user-scoped
device routes.

### S5 - HIGH - Arbitrary group member removal + roster enumeration
`members.controller.ts`: `DELETE mls/groups/:groupId/members/:userId` (:263,
`removeGroupMember`) - no authz -> anyone kicks anyone (delivery-level DoS). Metadata leaks:
`getGroupUserMembers` (:228) and `getGroupMembers` (:253) return any group's roster without
a membership check.
Fix: require caller be an authorized member/admin to remove; gate roster reads on membership.

### S6 - MEDIUM - Arbitrary media blob deletion (IDOR)
`apps/media-service/src/media/media.controller.ts:265` `DELETE /media/:id` - only
`verifyToken()` (JWT validity), no owner check despite "owner only" comment. `logoMediaId`
etc. are public via `/api/public/associations` -> enumerate + delete asso logos, event
images, doc/chat blobs. `GET /media/:id` (:236) also lacks ACL (ciphertext IDOR, lower
impact - confidentiality holds via CEK, but metadata leak / defense-in-depth gap).
Fix: bind media rows to an owner and check it on DELETE (and ideally GET).

### S7 - MEDIUM - nginx identity headers not reset on unauth locations
`infrastructure/local/Dockerfile.frontend`: `/api/public/`, `/api/media/public/`,
`/api/external`, `/api/auth`, `/api/associations/calendar/feed.ics` each define their own
`proxy_set_header` block, so they do NOT inherit the server-level `X-User-Id ""` /
`X-Global-Admin "false"` resets. Client-injected identity headers reach these upstreams. Not
exploitable today (handlers use params/api-key) but a latent trap for any future header read.
Fix: reset these headers unconditionally at server scope (or in each public location).

### S8 - MEDIUM - welcome/history-request trust body requester identity
`apps/chat-delivery-service/src/controllers/messaging.controller.ts:124` and `:133` take
`requesterUserId`/`requesterDeviceId` from the body without matching the caller. Part of the
S1 chain; standalone, lets an attacker trigger welcome/history fan-out under arbitrary ids.
Fix: derive requester from `x-user-id`, or assert it matches.

### B1 - LOW/BUG - users search dead auth context + unguarded
`apps/core-service/src/users/users.controller.ts:47` reads `req.user?.sub`, but `req.user`
is never populated (header auth, no interceptor sets it) -> `currentUserId` always
undefined: self-exclusion never applies and service-account visibility can't identify an
admin caller on search. Route also lacks `@UseGuards(NginxAuthGuard)` -> de-facto anonymous
user enumeration. Fix: read `@Headers('x-user-id')`; add the guard.

### S9 / S10 - accepted
S9: `canari_ws_token` holds the access token in a JS-readable cookie (needed for WS); any XSS
-> token theft. Accepted tradeoff; CSP is strict. S10: `documentVaultKey` stored server-side
plaintext (HKDF derivation sound); document as "encrypted at rest / trusted server", not E2E.

## Notes for the fix campaign
- These controllers are called by the legitimate frontend/native flows - each authz addition
  MUST be validated against the real call sites so group creation, invites, device
  registration, and recovery re-adds keep working. Check call flow before tightening.
- Chat-delivery membership gates already have the pattern: `assertCallerOwnsUserId`
  (`apps/chat-delivery-service/src/utils/sanitize.ts:62`).
