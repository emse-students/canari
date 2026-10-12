### Changed - communities are loaded side by side at startup

Seven communities were loaded one after another (21+ requests in a row, 2.9 s); they now load
together and the list costs the slowest one
([chat](docs/wiki/frontend/modules/chat.md#the-communities-are-loaded-side-by-side-not-one-after-another-2026-10-12)).
