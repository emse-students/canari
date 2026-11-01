## Hardware reading owed: one background Welcome on the Mi 9T (2026-10-22)

The background Welcome route (`POST /mls/push/send-welcome-and-commit`) now validates its commit as the
push-secret-authenticated committer, so a native path changed and no gate here runs native code.

**Verified from source instead of hardware (2026-10-22).** The rig could not build the trigger: a new
device asks for a background Welcome only when its own external join fails for a reason other than
not being a member. So the request was compared with the route by reading both.
`sendWelcomeAndCommit` in `CanariFirebaseMessagingService.kt` sends `Authorization: PushSecret`, puts
`userId` and `deviceId` in the body, and sends neither `senderId` nor `x-user-id`. The route
authenticates that exact pair and hands it to `validateCommit` as the committer, `senderId` included.
The pair passes the registry check because the push-token row and the key-package row both take
`userId` from `x-user-id`. iOS never posts this route. `push.controller.welcome-commit.spec.ts`
already sends exactly this body. **The reading below stays owed** (a bench phone, the lead's), and it no longer holds a stable.

The reading has one setup and three checks:

- **Setup.** The Mi 9T is killed, not force-stopped (swiped away), and is a member of a group
  conversation. A new device of another member must send a `welcome_request` for it, which makes the
  phone answer in the background. **That request is sent only when the newcomer's own external join
  for the chat group FAILS for a reason other than `NotAGroupMember`** (no GroupInfo published, a stale
  base, an unreachable server; `requestReAdd` step 9 and `sendWelcomeRequest` in `recovery.ts`). A new
  login on a healthy estate does not send it: see the attempt below. The PROCESS must be cold: a
  process in which the app was loaded since it last died answers `prepare refused
  reason=warm-process` and sends nothing, by design.
- **Phone (logcat).** Both of these lines appear (their wording since the typed answer, see
  [chat-delivery](../services/chat-delivery.md#the-background-welcome-answers-what-happened-and-the-stage-is-merged-only-on-an-acceptance-2026-10-22)):
  - `processWelcomeRequestBackground: Welcome staged ... baseEpoch=N`;
  - `processWelcomeRequestBackground: group=... target=... accepted at base N - Welcome sent - staged Add merged`.

  No `REFUSED`, `OUTCOME UNKNOWN` or `ACCEPTED AND NOT HELD` line appears.
- **The same reading with the app OPENED inside the round trip** (open the app between the
  `Welcome staged` line and the answer): the phone logs `stage left in mls.bin (left-to-foreground)`
  or `already settled by the foreground`; the foreground's next load logs `background stage of
  group=... found in the loaded state` (or `already merged`), then the WebView logs `[COMMIT] settling
  1 staged commit(s) by resubmission` and `... accepted - merged`; the newcomer reads the next message.
  No `ACCEPTED AND NOT HELD`, no `is ABSENT from the state this foreground keeps`, no `ERASES`.
- **The same reading with the phone STALE** (its group moved while it was shut, as on 2026-10-22):
  the phone logs `REFUSED epoch_mismatch: built on base N, the group is at M`, the server answers 409,
  the phone then reads the group's next message once opened, and the newcomer's next ask logs
  `already refused as stale from this mls.bin -> not answered`.
- **Server (chat-delivery on the local estate).** For the same group, these three lines appear:
  - `[BG_WELCOME][bg-wlc-...] START ... baseEpoch=N`;
  - `commit accepted -> activeEpoch=N+1`;
  - `DONE`.

  No `REJECT` appears, and in particular no commit-caller refusal.
- **The newcomer.** It opens the group and reads the next message.
