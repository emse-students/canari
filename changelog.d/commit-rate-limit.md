### Changed - `POST /mls/commit` is rate-limited per user, and a refused membership report is logged on the client

The commit route answers `429` past 600 commits per user per minute; the client rolls a rate-limited staged commit back as a typed refusal, and warns when the server refuses a membership report ([channel-encryption](docs/wiki/protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
