## Readings owed - the five defects of the owner's 1.7.1 Android log (2026-11-22)

target: 1.8.0

Built together ([changelog fragments](../../../changelog.d/)): (1) the Graine retention sweep drops per answered
chunk and resumes (`resumeGraineSweepIfOwed`, wired on the foreground edge, `online` and `visibilitychange`);
(2) `GET /api/forms/summaries?ids=` (at most 50, additive, the per-form routes stay for old clients) read through one
microtask-coalesced batcher (`formSummaries.ts`), and an unknown state draws neutral (`submitted: null`);
(3) a keyless history ask is a typed once-per-sender warning: the floor is enforced IN THE CLIENT ONLY, so a
build below `1.7.0` that has not met the gate can still send one, and the frame carries no build to name;
(4) the unread-pill warning is judged after the re-measure; (5) a declined private salon is said once.

Owed, on a phone on dev (the log comparison needs a real device):

1. A device holding 1,000+ seeds with the network cut mid-sweep logs `retention sweep interrupted after N of M`, then
   `retention sweep dropped` on the next foreground, and the held count falls across both.
2. A feed with many attached forms makes a handful of `/api/forms/summaries` requests, no `/api/forms/:id` or `/check`,
   and a request made to stall draws the card with no "Response sent" line instead of an answered state.
3. A 1.6.x peer asking for history yields ONE `history-ask-without-answer-key` warning per conversation, however often
   it resumes. Server side: a measured count of senders still below the floor decides when the line can go.
4. Scrolling up in a busy thread while messages arrive and send logs no `unread-pill anchor` warning.
5. One `private salon ... not entered` line per salon per boot, not one per resume.
