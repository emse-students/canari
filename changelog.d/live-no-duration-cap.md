### Changed - a live has no longest duration, and keeps only its newest segments while it runs

The 60-minute cap, its auto-stop, the sheet line and the byte budget derived from it are gone; a live ends by its broadcaster, by 60 s without a segment, or by staff, and the server deletes the segments behind the newest 20 as it goes, so storage per live is bounded whatever its length. Lives stay off in production until `1.5.4` carries this ([lives](docs/wiki/services/lives.md#what-one-broadcaster-may-store)).
