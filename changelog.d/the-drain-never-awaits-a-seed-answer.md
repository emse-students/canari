### Fixed - a seed request no longer freezes the message drain

A device asked for seeds while its community key group held a commit of unknown outcome could stop applying every incoming message until a reload: the answer is now sent after the frame that asked, never awaited under the drain's lock ([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md#10-client---the-drain-awaits-no-send-the-seed-answer-freeze-2026-11-25)).
