### Fixed - a salon invitation's notice carries ids, drawn live in each reader's language

The notice travelled as the inviter's rendered sentence, freezing a name and a language into the frame; it now carries the group's `{ newUsers: [id] }` payload, and an unparseable archive frame is skipped with one line. Old sentence rows stay readable. See [chat](docs/wiki/frontend/modules/chat.md#a-salons-membership-notice-carries-ids-2026-11-16).
