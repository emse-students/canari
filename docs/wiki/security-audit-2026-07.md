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
| S3 | CRITICAL | Payment bypass / entitlement grant via unguarded "internal" association routes | FIXED |
| S4 | HIGH | Arbitrary device deletion/manipulation (no ownership) | FIXED |
| S5 | HIGH | Arbitrary group member removal + roster enumeration | FIXED |
| S6 | MEDIUM | Arbitrary media blob deletion (IDOR) | FIXED |
| S7 | MEDIUM | nginx does not reset identity headers on unauth locations | FIXED |
| S8 | MEDIUM | welcome/history-request trust body `requesterUserId` | FIXED |
| B1 | LOW/BUG | users `search` reads never-populated `req.user`; route unguarded | FIXED |
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
FIXED: extracted `assertInternalSecret` into `apps/social-service/src/internal/internal-secret.util.ts`
(timing-safe, fails closed when `INTERNAL_SECRET` unset); `internal.controller.ts` now delegates to
it, and all three association routes (`stripe-account`, `stripe-complete`,
`products/:productId/purchase-completed`) call it via a new `x-internal-secret` header param. Send
side: the four core-service callers (payment.controller `stripe-account`/`stripe-complete`,
webhook.controller `purchase-completed`/`stripe-complete`) now pass `internalSocialRequestConfig()`
(already used for form/deletion calls), which attaches the shared secret. `INTERNAL_SECRET` is
already provisioned to both services in every compose file - no infra change.

### S4 - HIGH - Arbitrary device deletion/manipulation
`apps/chat-delivery-service/src/controllers/devices.controller.ts`: `DELETE :userId/:deviceId`
(:423), `DELETE .../prekeys` (:351), `PATCH .../metadata` (:239) - no ownership binding
(controller doesn't even import `assertCallerOwnsUserId`). Any user purges a victim's
KeyPackages/memberships/queued messages/push token and denylists re-registration -> victim
ejected from all conversations.
Fix: `assertCallerOwnsUserId(x-user-id, x-global-admin, targetUserId)` on all user-scoped
device routes.
FIXED: the four write/delete routes - `updateDeviceMetadata` (PATCH metadata),
`purgeDevicePrekeys` (DELETE prekeys), `pruneDevicePrekeys` (POST prekeys/prune) and
`deleteDevice` (DELETE :userId/:deviceId) - now take `x-user-id`/`x-global-admin` headers and
call `assertCallerOwnsUserId` against the sanitized path `userId` (admins exempt; legacy no-op
when `x-user-id` absent). These are self-service device-management flows, so the owner binding
does not break any legitimate call site. The GET routes (`getUserDevices`,
`getDeviceKeyPackage`, `getPrekeyCount`, `listDevicePrekeys`) deliberately stay cross-user open
- invite/welcome flows must read other users' KeyPackages.

### S5 - HIGH - Arbitrary group member removal + roster enumeration
`members.controller.ts`: `DELETE mls/groups/:groupId/members/:userId` (:263,
`removeGroupMember`) - no authz -> anyone kicks anyone (delivery-level DoS). Metadata leaks:
`getGroupUserMembers` (:228) and `getGroupMembers` (:253) return any group's roster without
a membership check.
Fix: require caller be an authorized member/admin to remove; gate roster reads on membership.
FIXED: `removeGroupMember` now calls `assertCallerMayMutateMembership(...,allowCreationBootstrap=false)`
- the caller must be a global admin or an existing member of the group (self-leave passes; mirrors
MLS remove-commit semantics). Roster reads `getGroupUserMembers` (dm_group_members) and
`getGroupMembers` (active DeviceGroupMembership) now take `x-user-id`/`x-global-admin` and call a new
`assertCallerIsGroupMember` gate (global admin or member; freshly-invited joiners are registered as
members before their Welcome, so recovery/re-invite reads still pass). Legacy no-op when `x-user-id`
absent, matching `assertCallerOwnsUserId`.

### S6 - MEDIUM - Arbitrary media blob deletion (IDOR)
`apps/media-service/src/media/media.controller.ts:265` `DELETE /media/:id` - only
`verifyToken()` (JWT validity), no owner check despite "owner only" comment. `logoMediaId`
etc. are public via `/api/public/associations` -> enumerate + delete asso logos, event
images, doc/chat blobs. `GET /media/:id` (:236) also lacks ACL (ciphertext IDOR, lower
impact - confidentiality holds via CEK, but metadata leak / defense-in-depth gap).
Fix: bind media rows to an owner and check it on DELETE (and ideally GET).
FIXED (internal-secret, not owner-binding - see rationale): the audit suggested per-media owner
rows, but media-service has no DB (flat `media_metadata.json`, no owner column) and, more
importantly, owner-binding is the wrong layer for public assets - association logos are managed
by *any* asso admin, so "uploader == deleter" would silently break cross-admin logo/event-image
replacement (the delete is best-effort, so mismatches would leak old blobs, not error). The real
authorization already lives in social-service (association-admin guards). The ONLY caller of
`DELETE /api/media/:id` anywhere is social-service `deleteMediaBestEffort` (logo/event/form/doc
cleanup, server-to-server, Docker-internal); no client deletes media directly. So the fix trusts
that boundary: `DELETE /media/:id` now requires `x-internal-secret` (new
`apps/media-service/src/media/internal-secret.util.ts`, timing-safe, fails closed when unset,
mirrors social-service's util) on top of the existing JWT check; `deleteMediaBestEffort` attaches
`process.env.INTERNAL_SECRET`. `INTERNAL_SECRET` added to the media-service env block in all 3
compose files (prod/dev `${INTERNAL_SECRET:-}`, local dev default). cd.yml already upserts the
secret into the deployed `.env` (prod full-function); cd-dev leaves it empty -> dev delete
fail-closes (best-effort, non-fatal, same tradeoff S3 accepted). GET `/media/:id` deliberately
stays open: gating it needs a per-recipient ACL the flat store lacks and would break legit
cross-user media fetches (recipient downloads sender's blob); confidentiality already rests on the
per-media CEK delivered E2E, so a raw-ciphertext IDOR leaks nothing usable.

### S7 - MEDIUM - nginx identity headers not reset on unauth locations
`infrastructure/local/Dockerfile.frontend`: `/api/public/`, `/api/media/public/`,
`/api/external`, `/api/auth`, `/api/associations/calendar/feed.ics` each define their own
`proxy_set_header` block, so they do NOT inherit the server-level `X-User-Id ""` /
`X-Global-Admin "false"` resets. Client-injected identity headers reach these upstreams. Not
exploitable today (handlers use params/api-key) but a latent trap for any future header read.
Fix: reset these headers unconditionally at server scope (or in each public location).

**FIXED.** Per-location reset (server-scope reset does NOT propagate here: nginx inherits
`proxy_set_header` from an outer scope only when a location defines *none* of its own, and every
one of these 5 locations sets `Host`/`X-Real-IP`/... - so the server-level `X-User-Id ""` block
is dropped). Each of the 5 public locations now strips the full trust-header set the backends
read - `X-User-Id`, `X-User-Logged-In`, `X-Global-Admin`, `X-Internal-Token` - to `""`/`"false"`.
`/api/auth` and `/api/external` previously reset only `X-User-Id`/`X-User-Logged-In`, still
leaking a spoofed `X-Global-Admin`/`X-Internal-Token`; now normalized to the same 4-line block.
Single source of truth is `infrastructure/local/Dockerfile.frontend` (no infra/env change).

### S8 - MEDIUM - welcome/history-request trust body requester identity
`apps/chat-delivery-service/src/controllers/messaging.controller.ts:124` and `:133` take
`requesterUserId`/`requesterDeviceId` from the body without matching the caller. Part of the
S1 chain; standalone, lets an attacker trigger welcome/history fan-out under arbitrary ids.
Fix: derive requester from `x-user-id`, or assert it matches.

**FIXED.** Both controller routes now pass the `x-user-id` header into the service, and a shared
`assertRequesterMatchesCaller` (private on `MessagingService`, near `makeTraceId`) throws
`ForbiddenException` when the authenticated caller does not equal the body's `requesterUserId`.
The requester device is typically NOT yet a group member (that is the reason for the re-invite /
history request), so membership cannot be checked - the meaningful gate is that a session holder
may only solicit fan-out for THEIR OWN identity. Legacy no-op when `x-user-id` is absent (matches
the rest of the campaign). The internal caller (`invitations.controller.ts` invite-accept) passes
`callerId`, which is already the requester, so it satisfies the check. Tests updated
(`messaging.history-request.spec.ts`): existing cases pass the matching caller, plus a spoof-reject
case and a legacy-absent no-op case (6 passing).

### B1 - LOW/BUG - users search dead auth context + unguarded
`apps/core-service/src/users/users.controller.ts:47` reads `req.user?.sub`, but `req.user`
is never populated (header auth, no interceptor sets it) -> `currentUserId` always
undefined: self-exclusion never applies and service-account visibility can't identify an
admin caller on search. Route also lacks `@UseGuards(NginxAuthGuard)` -> de-facto anonymous
user enumeration. Fix: read `@Headers('x-user-id')`; add the guard.

FIXED: `search` now carries `@UseGuards(NginxAuthGuard)` and reads `@Headers('x-user-id')
currentUserId` (mirrors the sibling `directory` route). The dead `@Req()`/`RequestWithUser`/
`JwtUser` plumbing is deleted. Self-exclusion + service-account visibility now get the real
caller id, and anonymous enumeration is closed. All 3 frontend callers (mention autocomplete,
`UserAutocomplete`, `user.ts searchUsers`) use `apiFetch` (authenticated) from logged-in-only
UI, so the guard breaks no legitimate flow.

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
