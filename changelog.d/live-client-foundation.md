### Added - lives: the client foundation (wire types, typed API client, v1 parameters)

`frontend/src/lib/live/` types every `/api/lives` answer, calls every route with each refusal classified at the throw (`LIVE_FULL`, `LIVE_SEATS_UNAVAILABLE` and `429` never confusable), and sends segments in index order; no UI yet, and the segment seal is NOT built because its format is unspecified ([live](docs/wiki/frontend/modules/live.md#the-client-foundation-2026-10-19)).
