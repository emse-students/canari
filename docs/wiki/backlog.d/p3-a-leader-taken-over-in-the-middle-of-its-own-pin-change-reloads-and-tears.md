## P3 - A leader taken over in the middle of its own PIN change reloads and tears the change (found 2026-10-18, review of #2058)

target: 1.8.0

**Re-read 2026-11-11: unchanged.** The demotion handler (`setTabLeaderDemotedHandler`,
`useChatSession.svelte.ts`) still reloads 50 ms later, and nothing checks a key change in progress.
Another tab's "Take over" makes the changing leader `releaseLeadership`, and the demotion handler (`useChatSession.svelte.ts`) reloads it 50 ms later whatever it is doing; the recovery finishes the move, but it costs a recovery prompt. **Owed**: refuse or defer a takeover while this tab is changing the key (the realm knows it, `RealmHold.changing`), with a two-realm test ([auth](../frontend/modules/auth.md#the-other-tabs-of-the-account)).
