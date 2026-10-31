### Fixed - a re-admission's row is marked before its state is dropped, and a recovery announces only into its own session

A kill between the drop and the mark could leave a conversation `active` over its evicted state; and a join landing after a sign-out could resume the next session's outbox ([chat](docs/wiki/frontend/modules/chat.md#a-group-becoming-ready-resumes-what-was-held-for-it-and-a-re-admission-holds-2026-10-31)).
