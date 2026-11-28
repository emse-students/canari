### Changed - a catch-up writes the reactions and the peer's read marks once per conversation, not once per frame

During a drain the store was written once per reaction (~75 ms) and once per peer read mark (~65 ms), about 4 s of a 10 s catch-up on a phone. They are now held until the drain's window closes and written in one merge and one save per conversation, in the same order and to the same final rows; a frame's ack still waits for its write ([chat](docs/wiki/frontend/modules/chat.md#the-reactions-and-read-marks-of-a-catch-up-are-written-once-2026-11-28)).
