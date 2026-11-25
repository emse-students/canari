### Fixed - "Modifier" right after a send showed the banner with an empty field

The composer's clear after a send wrote the field's own text as a local override of the parent's, and the next text the parent loaded (the edited message) was lost to it. The clear now only empties the DOM; the parent's text is the one writer ([chat](docs/wiki/frontend/modules/chat.md)).
