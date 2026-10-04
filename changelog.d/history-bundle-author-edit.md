### Fixed - a missed edit is restored with its body when the author answers the history request

A `history_bundle` used to set the "edited" flag over the pre-edit text; it now takes the edited body when the answering peer is the message's author, ordered like a live edit, and never from anyone else ([chat](docs/wiki/frontend/modules/chat.md)).
