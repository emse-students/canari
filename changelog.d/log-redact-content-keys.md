### Fixed - a one-word message no longer reaches the exported log

`text="ok"` survived redaction because a preceding field swallowed the `text=` name and a one-word value looks like an enum; content fields are now always replaced by their length ([mobile](docs/wiki/frontend/mobile.md#the-in-app-log)).
