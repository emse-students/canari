### Security - an arriving Graine v1 seed is refused, now that the floor is the v2 writer

With `minClientVersion` at `1.0.3`, the web app and the native push mirror refuse every NEW v1 seed, so a modified client can no longer mint a v1 session to post under another member's name; v1 sessions already held stay readable ([channel-encryption 21.7](docs/wiki/protocols/channel-encryption.md#217-an-arriving-v1-seed-is-refused-wp-g2-5b---the-floor-reached-the-writer-2026-10-11)).
