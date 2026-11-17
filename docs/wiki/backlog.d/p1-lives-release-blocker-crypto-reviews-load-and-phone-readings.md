## P1 - lives are a release blocker (D3): the two crypto reviews, the chat load reading and the phone readings are owed

target: 1.7.0

**A RELEASE BLOCKER (D3): no stable carries lives before it.** The owner's decision of 2026-10-19
([live](../frontend/modules/live.md#decisions-of-2026-10-19)): any member may start a live, so the
moderation and its proofs come before any stable. The moderation CODE is complete (WP-L8, closed
2026-11-17 with the lift of a withdrawal); what stands between lives and a stable is on the gate list
of [live-production](../frontend/modules/live-production.md#2-the-gates-each-with-its-evidence), and
this entry carries the three gates no other entry tracks:

| Gate | What is owed | What closes it |
| --- | --- | --- |
| **G7** | An adversarial crypto review of the segment seal v1 ([live](../frontend/modules/live.md#the-segment-seal-format-v1)) and one of the chat seal C12 ([lives](../services/lives.md#live-chat-and-floating-reactions-wp-l6)); neither is on record | One review each, by a fresh reviewer given the code and the format (not a conclusion), its verdict written where the format is described; a finding fixed or planned as its own entry |
| **G8** | The chat shares the live's row lock with the segment ingest; nothing measured that contention ([lives](../services/lives.md#the-row-lock-extended)) | One dev reading: several web viewers chatting and reacting while a broadcaster sends segments for ten minutes; ingest latency, `LIVE_SEGMENT_TOO_FAST` and chat `429` counts, the row lock's wait, written on lives |
| **G9** | The phone readings: check Y (watching) and LIVE-B1 (broadcasting) of [device-verification](../device-verification.md#live-b1-the-broadcaster-on-both-bench-phones---owed-on-both) on the Mi 9T and the iPhone 12, the moderation screens, the chat panel and the floating reactions, the three broadcaster pushes | Every row `PASS` (never `PASS-DIRTY`) on a `1.7.0` pre-release; the moderation half of it is [its reading entry](reading-owed-live-moderation-pushes-lift-and-the-lives-switch.md) |

Sizes: G7 about a day of review each plus its fixes; G8 an hour on dev with web seats; G9 one
sitting per phone. Charter: principle 1 (your messages are yours) for G7, principle 2 (the essential
is never lost) for G8.
