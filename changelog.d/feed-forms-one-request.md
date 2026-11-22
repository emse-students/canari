### Fixed - a feed page reads its attached forms in one request, and a stalled read is no longer "not answered"

`GET /api/forms/summaries` replaces a form read and a check per attached form (125 + 88 requests in one log); when the state cannot be read the card is drawn with the state unknown instead of claiming the reader has not answered. Old clients keep their per-form routes ([backlog](docs/wiki/backlog.d/owner-log-2026-11-22-readings-owed.md)).
