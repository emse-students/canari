## Reading owed - a resume reads the key group only of a community that changed (2026-11-22)

target: 1.7.3

**What is built:** one `GET /api/channels/workspaces/key-group-versions` per community listing, and a
community whose version is the one its last converged roster pass started from - with this device's
tree still held, live, at the active epoch - skips `distribution-group` and `members`
([offline-and-weak-network](../frontend/offline-and-weak-network.md#a-return-re-reads-the-key-group-only-of-a-community-that-changed-2026-11-22)).
Proven by `key-group-versions.spec.ts`, `ChannelService.bootReads.test.ts`,
`distributionGroup.test.ts` and `rosterReconcile.test.ts`; nothing has run on a phone.

**The before:** the owner's Android log, 1.7.1, 2026-11-19 22:01 to 2026-11-22 00:55 - 131 resumes,
5 050 requests, 1 161 `distribution-group` and 1 164 `members` for 9 communities (about 18 of them
per resume, each pass ending `agrees with its roster ... nobody to remove`).

**The reading that closes it, on the first pre-release carrying it (dev), on the Mi 9T:** the test account
in at least 5 communities; cold start, then 10 resumes (background the app 10 s, bring it back). In
the in-app log, the cold start's passes run in full (`agrees with its roster`, one `[KEY_GROUP_VERSIONS]`
request, then `roster pass converged`); each resume after it shows ONE key-group versions request and
`roster pass skipped (no read owed)` per community, with ZERO `distribution-group` or `members`
request. Count the requests per resume against the 1.7.1 figure above (about 18 of these two kinds
per resume for 9 communities - here 2 per community). Then from a second account remove a third
member from one community while the phone is backgrounded: on the next resume THAT community says
`changed since the last converged pass - running it` (its roster, and the epoch the removal committed, moved), the others skip.
A fail is a resume reading `distribution-group` for an unchanged community, or the removed member's
community skipped.
