### Fixed - two log lines that said nothing now speak only when something changed

The Graine history answer no longer logs `sending 0 of 0` / `answered ... holds nothing` for an empty community, and the key-group entitlement line is logged when the verdict changes (with the cause of a flip to false), not on every read ([durable-rules](docs/wiki/durable-rules.md)).
