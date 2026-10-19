### Added - lives: the client foundation (wire types, typed API client, v1 parameters)

`frontend/src/lib/live/` types every `/api/lives` answer, calls every route with each refusal classified at the throw (`LIVE_FULL`, `LIVE_SEATS_UNAVAILABLE` and `429` never confusable), and sends segments in index order through ONE index counter (`enqueue(index, sealed)` refuses any index but `nextIndex`); no UI yet ([live](docs/wiki/frontend/modules/live.md#the-client-foundation-2026-10-19)).
