### Fixed - the live card follows the feed tab, and a feed of replays no longer bursts 429s

Under "Organisations" the live card lists association lives only; the covers of live posters and replays now load three at a time instead of all at once, which was tripping nginx's per-address connection bound ([live](docs/wiki/frontend/modules/live.md#the-width-of-the-poster-fetches-s14-2026-11-20)).
