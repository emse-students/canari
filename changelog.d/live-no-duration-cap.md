### Changed - a live has no longest duration and no total byte budget

The 60-minute cap, its auto-stop, the sheet line and the byte budget derived from it are gone; a live ends by its broadcaster, by 60 s without a segment, or by staff. Builds up to 1.5.x still get a harmless `maxDurationMs` ([lives](docs/wiki/services/lives.md#what-one-broadcaster-may-store), [legacy-compatibility](docs/wiki/legacy-compatibility.md)).
