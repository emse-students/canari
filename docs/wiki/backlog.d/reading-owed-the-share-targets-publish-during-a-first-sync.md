## Reading owed - the share targets published twenty-three times in an account's first sync: which id flaps

target: 1.7.0

**Seen** on `1.7.0-alpha.12`, Mi 9T, dev, after a sign-out and a sign-in of a second test account
([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)):
23 `publishShareTargets: 5 target(s)` in about 27 s, `1 removed` on most of them. `syncShareTargets`
republishes whenever the ordered ids and labels of the top five change, so each call is a real change
of the list, and `removed` counts ids the previous set held that the new one lacks (a label-only
change removes none).

**Built:** each publish writes ONE in-app log line saying how it differs from the one before and what
the platform lists afterwards (`describeShareTargetsChange`, `sharing/shareTargetsNative.ts`):
`[ShareTargets] published (conversations changed): added [<id8>], removed [<id8>], N relabelled, reordered|same order; N of M present, N stale left`
(id prefixes, never a name; [sharing](../frontend/sharing.md)). No behaviour changed yet.

**Candidate mechanisms, read from the code by the review of that change, to be CONFIRMED by the reading:**
- **A, a flap.** `conversationRecency` (`utils/chat/conversations.ts`) reads the newest message's time
  once any message exists and the seed (`lastMessageAt`) only before. A row born of a Welcome is seeded
  with the admission's server time (`admissionSeed`, `mls-client/messagePipeline/setupMessageHandler.ts`),
  about "now" on a first sync, so it enters the top five, then falls back to its real last message when
  its history lands, and the row it evicted returns. The same id in `removed` and later in `added`.
  Fix at the seed/replay seam (a key that does not drop while the replay is owed), not in the share code.
- **B, a walk forward.** `selectShareTargets` skips a DM whose name is not resolved
  (`peekUserDisplayName`, a plain Map, no reactive re-run), so the sixth conversation takes the slot and
  the DM appears at its rank at the next unrelated change. Never a returning id.
- **C, label-only publishes.** An unnamed group's label is built from its members' names as they
  resolve, a salon's community suffix appears once `channelWorkspaces` loads. `N relabelled`, nothing added or removed.
- **Under all three:** the gate (`conversationSourcesSettled`: the local restore and the FCM injections)
  opens before the server's first sync of an account new to the install, so every publish comes from a
  list still being built. A publish from the sync's own end (a fact, never a timer) is the common fix
  if the sync exposes one.

**The reading that closes it:** on the Mi 9T, on the next pre-release, sign a second test account in and
read the `[ShareTargets] published` lines of its first sync (`adb logcat` or the in-app log): the same
id leaving and returning is A, only new ids B, only `relabelled` C. Then fix the cause the lines name,
with the test the entry always asked for: one sync replaying N conversations publishes a number of
times bounded by the changes of the final top five. Delete the entry with that fix.
