### Changed - a conversation is ordered, timed and read by the server's clock, not the author's

A DM or group message now sorts, shows its time and counts as read by when the server accepted it, as
a salon already did; a message delivered late appears where it arrived, counts as unread and
notifies. Older read marks and clients are honoured beside the new ones
([chat](docs/wiki/frontend/modules/chat.md#conversations-are-ordered-by-the-servers-clock-decided-by-the-owner-2026-10-31),
[legacy-compatibility](docs/wiki/legacy-compatibility.md)).
