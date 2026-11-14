### Changed - the public directory of a space leaves out the lists and institutions of other spaces

`GET /api/public/associations?space=` and the slug page filtered associations only; a list or an
institution is now kept only when its audience reaches the named space (owner, 2026-11-14,
[anonymous-surface](docs/wiki/anonymous-surface.md)).
