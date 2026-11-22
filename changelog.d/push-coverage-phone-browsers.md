### Fixed - the daily push-coverage line no longer counts a phone browser as a phone without push

A browser on a phone states the phone's OS and registers no push by design; the `[PUSH_COVERAGE]`
count and the `[PUSH_MISSING]` line now ask about the native app's devices only, which made the
`1.7.2` line read 43 "missing" phones that were all browsers ([chat-delivery](docs/wiki/services/chat-delivery.md#the-servers-row-decides-whether-a-registration-is-owed-2026-11-15)).
