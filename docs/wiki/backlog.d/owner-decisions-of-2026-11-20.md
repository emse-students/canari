## The owner's decisions of 2026-11-20

target: 1.7.2

Recorded so no question answered here is asked again. Each line names where its detail lives.

1. **The workstation incident of 2026-11-18 is cleaned up**, and the agents' access to the host and to production is restored under the usual rules. The suspension and the credential rotation it owed are lifted by that confirmation.
2. **PR #3486 (the MiConnect stack as the project's own):** the lead recreates the test MiConnect server and worker, and measures production MiConnect's compose dry run read-only. The lead then does the final review and merges it for `1.7.2` ([estate-migration](../infrastructure/estate-migration.md)).
3. **The lead may cut stables automatically**, once the latest alpha is read on both phones and nothing blocks. The lead tells the owner each time ([RELEASE AUTHORITY](../../../CLAUDE.md)).
4. **The precautionary rotation of the TURN analytics tokens was done before the stable.** Production got a new token, and the old one was deleted after production used the new one. Dev's token was rolled again, because its GitHub secret had been left stale by the previous roll ([MIGRATION](../../../infrastructure/MIGRATION.md)).
5. **A finished live is kept as a replay only if its organiser leaves the "Rediffusion" switch on.** The switch is shown when the live is launched and is ON by default. Once the live has started the organiser can only switch it OFF, during or after the live, and that deletes what was kept (segments and anything derived); it can never be switched back on, because nothing was kept. Viewers are not told whether the live will be replayed. The server is the authority. Charter principle 1 ([principes](../../principes.md)): the organiser's video is theirs to keep or to withdraw. Built ([the organiser's switch](../live-replays.md#the-organisers-rediffusion-switch-owner-2026-11-20)); the readings are [owed](live-replay-switch-readings-owed.md).
6. **The chat and the reactions sent during a live should replay in sync with the video, as on Twitch** (*"ce serait bien que les messages/réactions diffusés pendant le live puissent être présents à la rediffusion aussi, comme Twitch"*). A wish, not built: designed and planned with its open questions in [the entry](live-replay-chat-and-reactions-replayed.md); nothing is stored differently until the owner answers.
