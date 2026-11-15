### Fixed - a phone whose push registration was lost or never sent registers again at its next unlock

A third of the `1.6.12` phones held no push registration and said nothing; `register-device` now answers whether the server holds one and the phone re-registers on `false`, stating its last outcome, and `[PUSH_MISSING]` and a daily `[PUSH_COVERAGE]` count name such phones per build ([chat-delivery](docs/wiki/services/chat-delivery.md#the-servers-row-decides-whether-a-registration-is-owed-2026-11-15)).
