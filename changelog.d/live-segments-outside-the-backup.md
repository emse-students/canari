### Changed - Live segments are stored on a volume no backup reads

media-service keeps live segments and posters on a `live_segments` volume of its own instead of Garage, so a live replay is never in a backup (owner decision D2), and the object store refuses a `live/` key ([live-replays](docs/wiki/live-replays.md#wp-r3-as-built-the-segments-outside-the-backup)).
