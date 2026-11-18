## Reading owed - the share targets are sent once, when the member leaves the app, after an account's first sync

target: 1.7.1

**Seen** on `1.7.0-alpha.12`, Mi 9T, dev, after a sign-out and a sign-in of a second test account
([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)):
23 `publishShareTargets: 5 target(s)` in about 27 s, `1 removed` on most of them.

**The cause, read from the code.** `IncomingShareHost` ran `syncShareTargets` in an `$effect` that
read the conversation map, so every change of the top five during the sync was a publish, behind a
gate (`conversationSourcesSettled`) that closes at the end of the restore, the boot catch-up and the
push-cache merge (`sessionAuth.ts`, the `beginConversationSource` span) - not at the end of a first
sync, which goes on after it. Two of the three candidate mechanisms are real:
- **A, a flap (real).** A row a Welcome makes is seeded with the admission's server time
  (`admissionSeed`, `mls-client/messagePipeline/setupMessageHandler.ts`), near "now", and
  `conversationRecency` (`utils/chat/conversations.ts`) reads that seed only while the row holds no
  real message. A NEW DEVICE of a member is admitted to every group of the account after its login,
  one Welcome at a time as peers answer, and each group's past reaches it later still, from a peer
  (`reconcileGroup`, the history probe). So each joined row entered the top five and evicted the
  fifth, then fell to its real place when its history landed and the evicted row came back.
- **B, a walk forward (real).** `selectShareTargets` skips a DM whose peer name is not known, and
  the name is read through `peekUserDisplayName` from a plain `Map` (`utils/users/displayName.ts`)
  that no effect tracks: the DM entered at the next UNRELATED re-run, so the published list
  depended on the timing of other changes.
- **C, label-only publishes (real, minor).** A salon's community suffix appears once
  `channelWorkspaces` loads; a group's name once its derivation runs.

None of them is wrong for the sidebar, which shows a sync in progress. What was wrong is publishing
each step to a list nobody reads during the sync, and the end of that sync is not a fact the client
holds (a new device's history comes from peers, whenever one is online). **The fix** sends the list
at the one moment it can be read - the member leaving the app (`followShareTargets`,
`sharing/shareTargetsFollow.svelte.ts`, on `onAppScreenChange`) - and when the member moves the
switch; never on a change of the map. On iOS the departure's publish is held
(`holdWhileLeaving`) until the native side answers. Pinned by `shareTargetsFollow.svelte.test.ts`, which replays a
first sync on a live map (restored rows, the gate opening, eight Welcome rows seeded on top, their
histories landing, a relabel): no publish while it runs, ONE when the member leaves, holding the
final list, none on a second departure with nothing changed, and the departure held until the
native answer; `IncomingShareHost.shareTargets.svelte.test.ts` mounts the host and fails if a list
change in front publishes. Each publish keeps its one line
`[ShareTargets] published (left the app): added [id8], removed [id8], N relabelled, reordered|same order; N of M present, N stale left`
([sharing](../frontend/sharing.md)).

**The reading that closes it** (both phones, next pre-release): sign a second test account in, let
the first sync run with the app in front, and read the logs - no `[ShareTargets] published` line
while it runs; send the app home, and ONE `published (left the app)` line follows, then
`dumpsys shortcut` lists five `c:<id>` targets of that account (the iPhone: the share sheet's row
shows its conversations). Bring it back and send it home again with nothing new: no line. Delete the
entry with that reading.
