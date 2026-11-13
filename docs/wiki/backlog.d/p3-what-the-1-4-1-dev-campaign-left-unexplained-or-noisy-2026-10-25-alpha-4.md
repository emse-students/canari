## P3 - what the 1.4.1 dev campaign left unexplained or noisy (2026-10-25, alpha.4)

target: 1.9.0

Each is a log or console line the campaign met and no row asserts on. NOISE IS NEVER ACCEPTABLE
([CLAUDE.md](../../../CLAUDE.md)): explain it or fix it, never demote it.

- **A past-epoch frame older than the joiner's own Welcome is logged at WARN as an unreadable loss.**
  Seen on ADM-1/3/4 (`[RUST::WARN] Past-epoch application frame, unreadable for good: msg_epoch=2
  group_epoch=3 ... TooDistantInThePast`), emitted while a new `WasmMlsClient` loads its state, right
  after "Welcome complete: re-queued 1 buffered message(s)" and before "[HISTORY] ... holds 1 frame(s)
  it can never read - reconciling". The frame predates the membership, so under the no-past-for-new-
  members decision it is not a loss: drop it at INFO with its reason, once.
- **Restored notices carry no proof and no mark (the `[AUTHORSHIP] ... carry no author proof` lines of
  DEV-1).** Every one checked is a system notice row (`sender 'system'`), never a user message: the
  count equals the system rows of each batch. Two classes. (a) Device-local rows relayed into other
  members' timelines (contact lines, outbox failure lines): P3, already filed above, fix = a
  "device-local" property set where the row is written and kept out of digest, diff and bundle.
  (b) Shared notices (member added/removed, rename, picture, Join cards) a new device legitimately
  restores: P2 under the Graine v2 authorship item, NOT a regression (v1.4.0 takes every restored row
  on the relayer's word with no mark; `#2276` makes it visible in the pre-releases). Fix at the
  source: store the event frame's verified authorship on the notice row, add a notice verdict in
  `restoredAuthorship.ts` that verifies the signed system frame and redraws the text locally
  (`visibleNoticeContent`) instead of taking the relayer's text; same for `channel_invitation`.
  Interim decision owed after the stable: show the unverified mark on system rows
  (`ChatMessageGroups.svelte` system branch) or not. Do not lower the log level; split the count
  into notices and messages.
- **Two flaky unit tests** (they pass alone, fail in the full parallel run, with or without recent
  changes): `ChatArea.entryWindow.svelte.test.ts` ("never mounts more than the 20-row entry frame")
  and `outbox.reelResume` ("KILL MID-UPLOAD"). Find the shared-state or ordering cause; a flaky gate is
  a gate nobody believes.
- **The rig's volume lines and its own probes** (JOIN_*, WELCOME_REQ, DISCOVERY, 409/400/403 probes,
  DEVICE_KEY/DEVICE_MEMBERSHIPS, the refresh lines of a minted device) are not declared as expected by
  the ADM and DEV rows; a rig allowlist PR follows the chain.

**Plan (batch 13, 2026-11-11) - four separate pieces, none a one-line fix.** (a) The past-epoch WARN (`mls-core/src/messaging.rs`): log at INFO, once, when the frame's epoch is below the epoch this member joined at - needs that join epoch kept in the group state, so native and WASM work with its Rust tests. (b) The unverified restored notices belong to the Graine v2 authorship item (P2) and the device-local rows entry; nothing to do here beyond those. (c) The two flaky tests (`ChatArea.entryWindow.svelte.test.ts`, `outbox.reelResume.test.ts`, both still present): reproduce in the full parallel run and find the shared state - small once reproduced. (d) The rig allowlist of its own probe lines: one harness PR. (c) and (d) can be done in the queue; (a) needs an agent.
