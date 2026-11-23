## Reading owed - a resume reads the key group only of a community that changed (2026-11-22)

target: 1.8.0

**What is built (#3960, held as a draft until the 1.7.3 stable is cut, so it ships in the release
after it; the target is the earliest tier because a reading always is, and moves with the plan):**
one `GET /api/channels/workspaces/key-group-versions` per community listing, sent when the listing
starts, and a community whose version is the one its last converged roster pass started from - with
this device's tree still held, live, at the active epoch - skips `distribution-group` and `members`
([offline-and-weak-network](../frontend/offline-and-weak-network.md#a-return-re-reads-the-key-group-only-of-a-community-that-changed-2026-11-22)).
Proven by `key-group-versions.spec.ts`, `ChannelService.bootReads.test.ts`,
`distributionGroup.test.ts`, `rosterReconcile.test.ts` and `useChannelWorkspaces.svelte.test.ts`;
nothing has run on a phone. What it saves is client round trips: the server still reads both answers
per community, once per listing, to hash them.

**The before:** the owner's Android log, 1.7.1, 2026-11-19 22:01 to 2026-11-22 00:55 - 131 resumes,
5 050 requests, 1 161 `distribution-group` and 1 164 `members` for 9 communities (about 18 of them
per resume, each pass ending `agrees with its roster ... nobody to remove`).

**The reading that closes it, on the first pre-release carrying it (dev), on the Mi 9T:** the test
account in at least 5 communities.

1. **Cold start, latency.** Cold start the app and note, in the in-app log, the time from the
   listing's start to `[WORKSPACE-LOAD] communities/channels loaded`, and to the last community's
   `agrees with its roster`. Compare with the same account on the release before it: the versions
   request leaves beside the salon listings, so the key-group step must not be one round trip later.
   Every pass of the cold start runs in full and ends `roster pass converged`.
2. **Resumes, requests.** Then 10 resumes (background the app 10 s, bring it back). Each shows ONE
   key-group versions request and `roster pass skipped (no read owed)` per community, with ZERO
   `distribution-group` or `members` request. Count the requests per resume against the 1.7.1
   figure above.
3. **A change is seen.** From a second account remove a third member from one community while the
   phone is backgrounded: on the next resume THAT community says `changed since the last converged
   pass - running it` (its roster, and the epoch the removal committed, moved); the others skip.

A fail is a resume reading `distribution-group` for an unchanged community, the removed member's
community skipped, or a cold-start key-group step a round trip slower than before.

**2026-11-23, triage after the `1.8.0-alpha.1` reading (Mi 9T, 27 communities).** The communities
pass: one versions request per resume, every community `roster pass skipped (no read owed)`, zero
community `distribution-group` or `members` request, and the removed-member community runs its pass.
It FAILED on the private salons: each resume still read `distribution-group` and `members` for the 3
private salons the account reads (14 requests per resume where 0 are owed) - the versions answer named
communities only. Fixed by carrying each read salon's version in its community's item
([offline-and-weak-network](../frontend/offline-and-weak-network.md#a-return-re-reads-the-key-group-only-of-a-community-that-changed-2026-11-22)).
**Re-read on the next alpha: 0 salon requests per resume** - step 2 above, with each private salon of
the account logging `salon ... roster pass skipped (no read owed)` and no `GET /api/channels/<salon>/distribution-group`
or `/members`; and step 3 on a private salon too (a reader removed: THAT salon runs its pass).
