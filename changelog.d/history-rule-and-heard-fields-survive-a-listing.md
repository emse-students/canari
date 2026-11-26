### Fixed - the history rule an admin saves stays on the card, and a rename or role change heard during a listing is no longer overwritten by its older answer

The `workspace.updated` frame now forwards `historyVisibility`, and the listing ledger is keyed per (row, field) so a demoted administrator does not get their controls back from an older listing ([chat](docs/wiki/frontend/modules/chat.md#a-live-fact-heard-during-a-listing-is-newer-than-its-answer-2026-10-26)).
