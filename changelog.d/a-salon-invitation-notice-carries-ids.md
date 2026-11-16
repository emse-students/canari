### Fixed - a salon invitation's notice can carry ids, drawn live in each reader's language

Every reader now draws a salon `memberAdded` notice from `{ newUsers: [id] }` as well as from the legacy sentence; the inviter keeps sending the sentence until `minClientVersion` passes the reader, so no supported build shows raw JSON. An unparseable archive frame is skipped with one line. See [chat](docs/wiki/frontend/modules/chat.md#a-salons-membership-notice-carries-ids-2026-11-16).
