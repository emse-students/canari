## Readings owed - the five defects of the owner's 1.7.1 Android log (2026-11-22)

target: 1.8.0

Built together ([changelog fragments](../../../changelog.d/)): (1) the Graine retention sweep drops per answered
chunk and resumes (`resumeGraineSweepIfOwed`, wired on the foreground edge, `online` and `visibilitychange`);
(2) `GET /api/forms/summaries?ids=` (at most 50, additive, the per-form routes stay for old clients) read through one
microtask-coalesced batcher (`formSummaries.ts`), and an unknown state draws neutral (`submitted: null`);
(3) a keyless history ask is a typed once-per-sender error: the floor is enforced IN THE CLIENT ONLY, so a
build below `1.7.0` that has not met the gate can still send one, and the frame carries no build to name;
(4) the unread-pill warning is judged after the re-measure; (5) a declined private salon is said once.

Owed, on a phone on dev (the log comparison needs a real device):

1. A device holding 1,000+ seeds with the network cut mid-sweep logs `retention sweep interrupted after N of M`, then
   `retention sweep dropped` on the next foreground, and the held count falls across both.
2. A feed with many attached forms makes a handful of `/api/forms/summaries` requests, no `/api/forms/:id` or `/check`,
   and a request made to stall draws the card with no "Response sent" line instead of an answered state.
3. A 1.6.x peer asking for history yields ONE `history-ask-without-answer-key` error line per conversation, however often
   it resumes. Server side: a measured count of senders still below the floor decides when the line can go.
4. Scrolling up in a busy thread while messages arrive and send logs no `unread-pill anchor` warning.
5. One `private salon ... not entered` line per salon per boot, not one per resume.

**Mi 9T sitting, `1.7.3-alpha.6` (2026-11-22), read from the in-app log (IndexedDB ring, 10:44 to 11:12):** row 4 PASS - 30 messages
arrived in a thread while the phone scrolled up twelve times: zero `unread-pill anchor` lines. Row 1: the sweep runs normally on this
build (`retention sweep dropped 0 seed(s) ... held=43, live=42`); a cut mid-sweep needs a device holding far more seeds, NOT TAKEN.
Row 2: the dev feed holds no post with an attached form, NOT TAKEN. Rows 3 and 5: no 1.6.x peer and no declined private salon on the
bench, NOT TAKEN. The entry stays.

**Mi 9T, second sitting, `1.7.3-alpha.6` (2026-11-22):** row 5 PASS - a private salon the alpha account may see but did not join (it was made an admin of the community, the only standing a private salon is listed to without access) logged exactly ONE `private salon ... not entered` line, then three background-and-front resume cycles (the listing walk ran each time) added none. Row 2, first half PASS - twelve forms attached to twelve feed posts made the feed ask `GET /api/forms/summaries?ids=` seven times (one or two ids each, one per render flush), no `/api/forms/:id` and no `/check` request. **Rows 1, 2 (second half) and 3 are NOT readable on the bench; each carries its replacement, per the rule of 2026-11-22:**
- row 1: `retention.test.ts` ("keeps what completed chunks proved, then resumes") already cuts a 1,100-seed sweep after the first chunk and resumes it; add the two log assertions it lacks - `retention sweep interrupted after 500 of 1100 session(s) (500 dropped so far)` after the first call, `retention sweep dropped` after `resumeGraineSweepIfOwed()`.
- row 2, second half: in `FormCard.svelte.test.ts` mount the card over a batcher whose fetcher rejects, and assert it shows neither the answered label nor an error; with a fetcher resolving `[]` it draws the same neutral state.
- row 3: `systemMessageHandler.askId.test.ts` ("says a repeated keyless ask from one sender ONCE") covers the rule; add a case whose ask is the captured pre-1.7.0 `history_digest` JSON (no `answerKey` field at all) and expect one `HISTORY_DIGEST` keyless line. The live read closes as impossible until a 1.6.x client can be installed beside the pre-release.
The entry stays.
