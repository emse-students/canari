## Reading owed - a catch-up writes its reactions and read marks once per conversation

target: 1.8.3

Built 2026-11-28 (`perf/catch-up-batched-store-writes`): while a drain's window is open the reaction
and read-mark writes are held and landed in one merge and one save per conversation at the close,
every checkpoint's hold writing them first and refusing while one stands
([chat](../frontend/modules/chat.md#the-reactions-and-read-marks-of-a-catch-up-are-written-once-2026-11-28)).
The unit tests pin the final rows, the order, the acks and the refusals; no real store or socket ran.

The reading, on the Mi 9T on the first alpha carrying it: resume with a DM that received a run of
reactions and read marks while the app was closed, export the log, and read `[QUEUE] Drain complete`
(the drain should lose the ~4 s of per-frame writes the 2026-11-24 log showed), a single
`[CATCHUP_WRITES] close:` line per drain with the counts, no `[CATCHUP_WRITES]` error, and every
reaction and the peer's read tick still shown after a force-stop and relaunch.
