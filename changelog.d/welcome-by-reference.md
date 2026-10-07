### Fixed - a first-contact Welcome is carried by reference, as a typed outcome

A Welcome (4608 B against a 3716 B budget) is never inlined in the push: the device fetches it by id, and the decision is now a typed `decideProtoCarriage` outcome, with an over-budget MESSAGE logged at warn level. See [chat-delivery](docs/wiki/services/chat-delivery.md#a-welcome-is-carried-by-reference-never-inlined-2026-10-08).
