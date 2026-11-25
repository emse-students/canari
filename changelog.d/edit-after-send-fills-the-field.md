### Fixed - "Modifier" right after a send showed the banner with an empty field

The composer's clear after a send wrote the field's own text, which, landing after the parent's clear of a SvelteMap-backed draft, stayed as a local override and swallowed the next text the parent loaded (the edited message). The clear now only empties the DOM; the parent's text is the one writer ([chat](docs/wiki/frontend/modules/chat.md)).
